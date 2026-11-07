/* The screen: Bridge's explorer template. Saved views in the sidebar, the
 * search, filter menus and time range in the toolbar, the log stream in the
 * main column (newest at the bottom), a line opened in place under its row, and
 * Follow in Bridge's bar. Every interaction runs this in a fresh VM: what
 * must survive a click (filters, the window, cursors, the views and the
 * menu values) lives in `state`; the lines themselves are read again by
 * each interaction's one search, so the state stays small. */
import { action, defineView, ui, type Block, type Control, type JsonRecord, type ReadResult, type StreamChip, type StreamDetail, type StreamRow, type Tone, type WriteResult } from '@aibridge/sdk/isolated'
import type { Problem, ProblemKind } from './mezmo-api'
import { byteLength, clip, minuteTime, parseMinute, shortTime, size, type Detail, type Row } from './lines'
import { OPEN_MAX, PAGE_SIZE, RANGE_LABELS, listOf, type Filters, type Range, type SavedViewAnswer, type SearchAnswer, type SearchArgs, type ValuesAnswer, type ViewItem, type ViewsAnswer } from './search'

type State = {
  range: Range; from: number | null; to: number | null
  query: string; apps: string[]; hosts: string[]; tags: string[]; levels: string[]
  view: string; edited: boolean; selected: string | null
  /** The lines shown expanded in place, oldest first (at most OPEN_MAX). */
  expanded: string[]
  page: number; cursors: (string | null)[]; next: string | null; nextUnusable: boolean
  views: ViewItem[] | null; viewsMore: number; viewsProblem: Problem | null
  values: ValuesAnswer | null
  saveOpen: boolean; saveName: string; saveResult: WriteResult | null
}
type Read = { read(name: string, args: JsonRecord, options?: { reuse?: boolean }): Promise<ReadResult> }
const EVERYTHING = '__all', LINE_KEY = /^[0-9]{1,16}-[0-9a-f]{8}$/, CONTEXT_MS = 2 * 60_000
const LEVELS = [{ value: 'fatal', label: 'Fatal' }, { value: 'error', label: 'Error' }, { value: 'warn', label: 'Warning' }, { value: 'info', label: 'Info' }, { value: 'debug', label: 'Debug' }, { value: 'trace', label: 'Trace' }]
const RANGES = (Object.keys(RANGE_LABELS) as Range[]).map(value => ({ value, label: RANGE_LABELS[value] }))
const MAX_PAGES = 20, FOLLOW_SECONDS = 10

const str = (x: unknown, fallback = '') => typeof x === 'string' ? x : fallback
const num = (x: unknown) => typeof x === 'number' && Number.isFinite(x) ? x : null
const strings = (x: unknown, max = 20) => Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string').slice(0, max) : []
function restore(raw: JsonRecord): State {
  const values = raw.values && typeof raw.values === 'object' && !Array.isArray(raw.values) ? raw.values as JsonRecord : null
  const list = (x: unknown) => Array.isArray(x) ? strings(x, 100) : null
  return {
    range: RANGES.some(r => r.value === raw.range) ? raw.range as Range : '1h', from: num(raw.from), to: num(raw.to),
    query: str(raw.query), apps: strings(raw.apps), hosts: strings(raw.hosts), tags: strings(raw.tags), levels: strings(raw.levels),
    view: str(raw.view, EVERYTHING), edited: raw.edited === true, selected: typeof raw.selected === 'string' ? raw.selected : null,
    expanded: strings(raw.expanded, OPEN_MAX).filter(k => LINE_KEY.test(k)),
    page: Math.max(1, num(raw.page) ?? 1), cursors: Array.isArray(raw.cursors) ? raw.cursors.map(c => typeof c === 'string' ? c : null) : [null],
    next: typeof raw.next === 'string' ? raw.next : null, nextUnusable: raw.nextUnusable === true,
    views: Array.isArray(raw.views) ? raw.views as unknown as ViewItem[] : null, viewsMore: num(raw.viewsMore) ?? 0, viewsProblem: (raw.viewsProblem ?? null) as Problem | null,
    values: values ? { apps: list(values.apps), hosts: list(values.hosts), tags: list(values.tags) } : null,
    saveOpen: raw.saveOpen === true, saveName: str(raw.saveName).slice(0, 100),
    saveResult: raw.saveResult as WriteResult | null ?? null
  }
}
const filtered = (s: State) => !!(s.query.trim() || s.apps.length || s.hosts.length || s.tags.length || s.levels.length)
function argsOf(s: State, cursor: string | null, fresh: boolean): SearchArgs {
  const fixed = !fresh || s.range === 'custom'
  return { range: s.range, ...(fixed && s.from !== null && s.to !== null ? { from: s.from, to: s.to } : {}), query: s.query, apps: s.apps.join(','), hosts: s.hosts.join(','), levels: s.levels.join(','), tags: s.tags.join(','), ...(cursor ? { cursor } : {}) }
}
function readProblem(result: Extract<ReadResult, { ok: false }>): Problem {
  const kind: ProblemKind = result.code === 'timeout' ? 'timeout' : result.code === 'too-large' ? 'too-large' : result.code === 'busy' ? 'busy' : result.code === 'denied' ? 'refused' : result.code === 'identity-changed' ? 'auth' : result.code === 'handler-rejected' || result.code === 'invalid-output' ? 'unexpected' : 'network'
  return { kind, status: null, retryAfter: null, detail: result.code === 'identity-changed' ? 'The connection changed.' : '' }
}

const filtersOf = (f: Filters) => ({ query: f.query, apps: f.apps.slice(0, 20), hosts: f.hosts.slice(0, 20), levels: f.levels.slice(0, 20), tags: f.tags.slice(0, 20) })
/** One page of lines, with the expanded ones in full. */
type Page = { rows: Row[]; problem: Problem | null; details: Record<string, Detail> }
type At = { page: number; cursor: string | null; fresh: boolean; view?: string | null; reuse?: boolean }
async function lines(s: State, ctx: Read, at: At): Promise<Page> {
  // A chosen saved view: its own search and filters first (one more read).
  // Bridge answers a view chosen again from memory (a GET this view already
  // received, for a few minutes, until Refresh): switching back costs Mezmo
  // one request, not two.
  if (at.view) {
    const saved = await ctx.read('savedView', { view: at.view }, { reuse: true })
    const answer = saved.ok ? saved.data as unknown as SavedViewAnswer : null
    if (!saved.ok) return { rows: [], problem: readProblem(saved), details: {} }
    if (!answer!.ok) return { rows: [], problem: answer!.problem, details: {} }
    Object.assign(s, filtersOf(answer!.filters))
  }
  // Expanding and closing a line reuse the page this view already has
  // (Bridge answers from memory, no network); everything else reads anew.
  const result = await ctx.read('search', { ...argsOf(s, at.cursor, at.fresh), ...(s.expanded.length ? { open: s.expanded.join(',') } : {}) } as unknown as JsonRecord, at.reuse ? { reuse: true } : undefined)
  if (!result.ok) return { rows: [], problem: readProblem(result), details: {} }
  const answer = result.data as unknown as SearchAnswer
  s.from = answer.from; s.to = answer.to
  if (!answer.ok) return { rows: [], problem: answer.problem, details: {} }
  s.next = answer.next; s.nextUnusable = answer.nextUnusable; s.page = at.page
  s.cursors = at.page === 1 ? [at.cursor] : [...s.cursors.slice(0, at.page - 1), at.cursor]
  return { rows: answer.rows, problem: null, details: answer.details }
}
/** The sidebar's views and the menus' names: on opening and on Refresh. */
async function catalogue(s: State, ctx: Read) {
  await savedViews(s, ctx)
  const values = await ctx.read('values', {})
  s.values = values.ok ? values.data as unknown as ValuesAnswer : { apps: null, hosts: null, tags: null }
}
async function savedViews(s: State, ctx: Read) {
  const views = await ctx.read('views', {})
  if (views.ok) { const a = views.data as unknown as ViewsAnswer; if (a.ok) { s.views = a.views; s.viewsMore = a.more; s.viewsProblem = null } else { s.views = null; s.viewsProblem = a.problem } }
  else { s.views = null; s.viewsProblem = readProblem(views) }
}

const TONES: Record<string, Tone> = { fatal: 'danger', critical: 'danger', crit: 'danger', emergency: 'danger', emerg: 'danger', alert: 'danger', panic: 'danger', error: 'danger', err: 'danger', severe: 'danger', warn: 'warning', warning: 'warning', info: 'info', notice: 'info', debug: 'neutral', trace: 'neutral', verbose: 'neutral' }
const streamRow = (row: Row): StreamRow => ({ key: row.key, time: row.time, accent: row.host, source: row.app, level: row.level ? ui.cell(row.level, TONES[row.level] ?? 'neutral') : null, text: row.text })

function problemNotice(p: Problem): Block {
  const status = p.status ? ` (${p.status})` : '', said = p.detail ? ` Mezmo said: “${p.detail}”` : ''
  const words: Record<ProblemKind, [Tone, string]> = {
    auth: ['danger', p.status ? `Mezmo did not accept the service key${status}. It may be mistyped, revoked or expired. Open the connection chip in the bar above, choose Replace connection and enter a current service key.` : 'The Mezmo connection changed while this search ran. Press Refresh to search again with the current connection.'],
    forbidden: ['danger', `This key cannot read logs${status}. Use a service key (Mezmo: Settings › Organization › API Keys); an ingestion key can only send logs.${said}`],
    rate: ['warning', `Mezmo is limiting requests${status}. ${p.retryAfter !== null ? `Wait ${p.retryAfter} ${p.retryAfter === 1 ? 'second' : 'seconds'}` : 'Wait a minute'}, then press Refresh. Turn Follow off, or choose a shorter range or more filters, to make fewer or lighter requests.`],
    'bad-request': ['danger', `Mezmo refused this search${status}.${said} Check the search syntax and the time range, then try again.`],
    'not-found': ['danger', `This address does not answer as Mezmo${status}. Check the connection's address in the bar's connection chip; Mezmo's is https://api.mezmo.com.`],
    server: ['warning', `Mezmo had a problem answering${status}. Press Refresh in a minute.${said}`],
    unexpected: ['danger', `Mezmo answered in a way this plugin does not understand${status}.${said} The API may have changed; the plugin's README lists what it assumes.`],
    network: ['warning', 'Could not reach Mezmo. Check your network connection, then press Refresh.'],
    timeout: ['warning', 'Mezmo did not answer in time. Try a shorter time range or more filters, then press Refresh.'],
    'too-large': ['warning', 'This page of results is larger than Bridge accepts. Try a shorter time range or more filters.'],
    busy: ['warning', 'Bridge is still finishing another request. Press Refresh in a moment.'],
    refused: ['danger', 'Bridge refused a request this plugin made, so nothing was sent to Mezmo. This is a bug in the plugin.']
  }
  const [tone, text] = words[p.kind]
  return ui.notice(tone, text)
}
function windowText(s: State): string {
  if (s.from === null || s.to === null) return RANGE_LABELS[s.range]
  const day = (ms: number) => shortTime(ms, false).split(' ').slice(0, 2).join(' '), clock = (ms: number) => shortTime(ms, false).split(' ')[2]
  return `${RANGE_LABELS[s.range]} · ${shortTime(s.from, false)} – ${day(s.from) === day(s.to) ? clock(s.to) : shortTime(s.to, false)} UTC`
}
function filterText(s: State): string {
  const parts: string[] = []
  if (s.query.trim()) parts.push(`“${clip(s.query.trim(), 120).text}”`)
  for (const [name, list] of [['apps', s.apps], ['hosts', s.hosts], ['tags', s.tags], ['levels', s.levels]] as const) if (list.length) parts.push(`${name} ${list.join(', ')}`)
  return parts.length ? parts.join(' · ') : 'all apps, hosts, tags and levels'
}

/** A filter menu from Mezmo's own names, or free entry when it gave none. */
function filterControl(label: string, name: 'apps' | 'hosts' | 'tags', s: State): Control {
  const known = s.values?.[name] ?? null, chosen = s[name]
  if (!known || (!known.length && !chosen.length)) return ui.search(`${label}, comma-separated`, chosen.join(', '), action(name))
  const options = [...new Set([...chosen, ...known])].slice(0, 200).map(value => ({ value, label: value }))
  return ui.menu(label, chosen.filter(v => options.some(o => o.value === v)), options, action(`menu-${name}`))
}

/** An expanded line, Mezmo's way: identifiers, metadata and tags as chips,
 *  the line's own fields in a box, Mezmo's internal fields closed. */
function lineDetail(row: Row, d: Detail): StreamDetail {
  const ids: StreamChip[] = [{ label: 'Source', value: row.host || 'unknown' }, { label: 'App', value: row.app || 'unknown' }, ...(d.facts.env ? [{ label: 'Env', value: d.facts.env }] : []), ...(row.level ? [{ label: 'Level', value: row.level }] : [])]
  const meta: StreamChip[] = [...(d.facts.size !== null ? [{ label: 'Line size', value: size(d.facts.size) }] : []), ...(d.facts.logtype ? [{ label: 'Type', value: d.facts.logtype }] : []), ...(d.facts.file ? [{ label: 'File', value: d.facts.file }] : []), { label: 'Time', value: d.time }]
  const message = d.messageClipped ? `${d.message}\n\n[Showing the first 8 KB of this ${size(d.messageBytes)} line; the whole line is in Mezmo.]` : d.message
  const fields = d.hiddenFields ? [...d.fields, { label: 'More', value: `${d.hiddenFields} more ${d.hiddenFields === 1 ? 'field' : 'fields'} in the raw line` }] : d.fields
  return {
    message, raw: d.json,
    groups: [{ title: 'Line identifiers', chips: ids }, { title: 'Line metadata', chips: meta }, { title: 'Tags', chips: d.facts.tags.map(t => ({ label: null, value: t })) }],
    fields, more: d.meta.length ? { title: 'Mezmo metadata', items: d.meta } : null,
    actions: [{ label: 'Show surrounding lines', action: action('context', { key: row.key }) }]
  }
}

export default defineView(async ({ state, event }, ctx) => {
  const s = restore(state)
  let typed: { from: string; to: string } | null = null, customError = ''
  // Where this interaction's one page of lines comes from.
  // By default an interaction shows the same page again, from memory.
  let at: At = { page: s.page, cursor: s.cursors[s.page - 1] ?? null, fresh: false, reuse: true }
  const fresh = () => { at = { page: 1, cursor: null, fresh: true }; s.selected = null; s.expanded = [] }
  if (event.type === 'mount' || event.type === 'refresh') { await catalogue(s, ctx); fresh(); if (s.view !== EVERYTHING && !s.edited) at.view = s.view }
  else if (event.type === 'write-result' && event.name === 'save-view') {
    s.saveName = String(event.values.name ?? '').slice(0, 100)
    s.saveResult = event.result
    if (event.result.outcome === 'saved') {
      const before = new Set((s.views ?? []).map(v => v.id))
      s.saveOpen = false
      await savedViews(s, ctx)
      const created = (s.views ?? []).filter(v => !before.has(v.id) && v.name === s.saveName.trim())
      if (created.length === 1) { s.view = created[0].id; s.edited = false }
    } else s.saveOpen = true
  }
  else if (event.type === 'follow') fresh()
  else if (event.type === 'choose') {
    const name = event.name.replace(/^menu-/, '')
    if (name === 'apps' || name === 'hosts' || name === 'tags' || name === 'levels') { s[name] = event.values.slice(0, 20); s.edited = s.view !== EVERYTHING; fresh() }
  } else if (event.type === 'submit' && event.name === 'custom') {
    typed = { from: String(event.values.from ?? ''), to: String(event.values.to ?? '') }
    const from = parseMinute(typed.from), to = parseMinute(typed.to)
    if (from === null || to === null) customError = 'Write both times as YYYY-MM-DD HH:MM in UTC, for example 2026-11-05 13:00.'
    else if (from >= to) customError = 'The start must be before the end.'
    else { s.range = 'custom'; s.from = from; s.to = to; typed = null; s.selected = null; s.expanded = []; at = { page: 1, cursor: null, fresh: false } }
  } else if (event.type === 'action') {
    const value = event.value ?? ''
    switch (event.name) {
      case 'save-view-open': s.saveOpen = true; s.saveName = ''; s.saveResult = null; break
      case 'save-view-close': s.saveOpen = false; break
      case 'save-view-check': await savedViews(s, ctx); break
      case 'query': s.query = value; s.edited = s.view !== EVERYTHING; fresh(); break
      case 'apps': case 'hosts': case 'tags': s[event.name] = listOf(value); s.edited = s.view !== EVERYTHING; fresh(); break
      case 'view':
        s.view = value; s.edited = false; fresh()
        if (value === EVERYTHING) Object.assign(s, { query: '', apps: [], hosts: [], tags: [], levels: [] })
        else at.view = value
        break
      case 'clear': Object.assign(s, { query: '', apps: [], hosts: [], tags: [], levels: [], view: EVERYTHING, edited: false }); fresh(); break
      case 'range':
        // Custom starts from the window on screen; its form searches it.
        if (value === 'custom') { s.range = 'custom'; if (s.to === null || s.from === null) { s.to = Date.now(); s.from = s.to - 3_600_000 } }
        else { s.range = value as Range; fresh() }
        break
      case 'older': if (s.next && s.page < MAX_PAGES) { at = { page: s.page + 1, cursor: s.next, fresh: false }; s.selected = null; s.expanded = [] } break
      case 'newer': if (s.page > 1) { at = { page: s.page - 1, cursor: s.cursors[s.page - 2] ?? null, fresh: false }; s.selected = null; s.expanded = [] } break
      // A line opens in place under its row, or closes; several may be open.
      case 'open': { const key = event.value ?? ''; if (LINE_KEY.test(key)) s.expanded = s.expanded.includes(key) ? s.expanded.filter(k => k !== key) : [...s.expanded, key].slice(-OPEN_MAX); break }
      // Show surrounding lines: two minutes either side of the line, unfiltered.
      case 'context': {
        const key = typeof event.payload.key === 'string' ? event.payload.key : '', ts = Number(key.split('-')[0])
        if (LINE_KEY.test(key) && Number.isFinite(ts) && ts > 0) {
          Object.assign(s, { query: '', apps: [], hosts: [], tags: [], levels: [], view: EVERYTHING, edited: false, range: 'custom', from: ts - CONTEXT_MS, to: ts + CONTEXT_MS, expanded: [key], selected: null })
          at = { page: 1, cursor: null, fresh: false }
        }
        break
      }
    }
  }
  const page = await lines(s, ctx, at)
  s.expanded = s.expanded.filter(k => page.rows.some(r => r.key === k))
  const rows = page.rows, chosenView = s.views?.find(v => v.id === s.view) ?? null
  const viewName = s.view === EVERYTHING || !chosenView ? 'Everything' : chosenView.name

  // The sidebar: Everything first, then the saved views by their group.
  const groups = new Map<string, { key: string; label: string; detail: string | null }[]>()
  // Views without a category have no heading of their own, unless others
  // have one; then they are "Other views".
  const categorised = (s.views ?? []).some(v => v.group)
  for (const v of s.views ?? []) { const g = v.group || (categorised ? 'Other views' : ''); if (!groups.has(g)) groups.set(g, []); groups.get(g)!.push({ key: v.id, label: v.name, detail: null }) }
  const sidebar = ui.nav({
    title: 'Views', search: (s.views?.length ?? 0) > 6 ? 'Find a view' : null,
    groups: [{ title: '', items: [{ key: EVERYTHING, label: 'Everything', detail: null }] }, ...[...groups].slice(0, 15).map(([title, items]) => ({ title, items }))],
    selected: s.views?.some(v => v.id === s.view) || s.view === EVERYTHING ? s.view : EVERYTHING, action: action('view')
  })

  const toolbar: Control[] = [
    ui.search('Search (Mezmo syntax)', s.query, action('query')),
    filterControl('Apps', 'apps', s), filterControl('Hosts', 'hosts', s), filterControl('Tags', 'tags', s),
    ui.menu('Levels', s.levels.filter(l => LEVELS.some(o => o.value === l)), LEVELS, action('menu-levels'), { search: false }),
    ui.select('Jump to timeframe', s.range, RANGES, action('range')),
    ui.button('Save view', action('save-view-open')),
    ...(filtered(s) || s.view !== EVERYTHING ? [ui.button('Clear', action('clear'))] : [])
  ]

  const first = (s.page - 1) * PAGE_SIZE + 1
  const counted = rows.length ? ` · lines ${first} to ${first + rows.length - 1}${s.next ? '' : ', nothing older'}` : ''
  const summary: Block[] = [ui.text(`${windowText(s)} · ${filterText(s)}${s.edited ? ' · view edited' : ''}${counted}`)]
  if (s.saveResult?.outcome === 'saved' && s.viewsProblem) summary.push(ui.notice('warning', `“${s.saveName}” was saved in Mezmo. The views list could not be refreshed; press Refresh to load it. Do not save it again.`))
  if (s.viewsProblem) summary.push(ui.notice('info', `Saved views could not be read, so only Everything is listed. ${s.viewsProblem.kind === 'forbidden' ? 'This key may not read the configuration.' : 'Press Refresh to try again.'}`))
  if (s.viewsMore) summary.push(ui.text(`${s.viewsMore} more saved ${s.viewsMore === 1 ? 'view is' : 'views are'} not listed.`))
  if (s.values && (!s.values.apps || !s.values.hosts || !s.values.tags)) summary.push(ui.text('Mezmo did not list every app, host or tag name, so those filters take typed names.'))
  if (s.range === 'custom') {
    const custom = typed ?? { from: s.from === null ? '' : minuteTime(s.from), to: s.to === null ? '' : minuteTime(s.to + 59_999) }
    if (customError) summary.push(ui.notice('warning', customError))
    summary.push(ui.form({ key: 'custom', title: 'Custom range, in UTC', fields: [
      { kind: 'text', key: 'from', label: 'From (YYYY-MM-DD HH:MM)', required: true, value: custom.from, maxLength: 24 },
      { kind: 'text', key: 'to', label: 'To (YYYY-MM-DD HH:MM)', required: true, value: custom.to, maxLength: 24 }
    ], submit: { label: 'Search this range', action: action('custom'), disabled: false } }))
  }
  if (rows.length) {
    if (s.nextUnusable) summary.push(ui.notice('info', 'Mezmo sent a next-page id this plugin cannot pass back, so older lines stop here. Narrow the range to see them.'))
    if (s.page >= MAX_PAGES && s.next) summary.push(ui.notice('info', `Paging stops after ${MAX_PAGES} pages. Narrow the range or add filters to reach older lines.`))
  }
  const paging = rows.length && (s.page > 1 || s.next) ? [ui.button('Newer lines', action('newer'), s.page === 1), ui.button('Older lines', action('older'), !s.next || s.page >= MAX_PAGES)] : []
  const blocks: Block[] = [ui.section({ key: 'summary', title: s.page > 1 ? `Page ${s.page}, older lines` : '', controls: paging, blocks: summary })]
  if (page.problem) {
    blocks.push(problemNotice(page.problem))
    blocks.push(ui.text('No log lines are shown until a search works. The view, range and filters above are kept for the next try.'))
  } else {
    blocks.push(ui.stream({ key: 'lines', title: 'Log lines', expand: 'inline', rows: [...rows].reverse().map(row => ({ ...streamRow(row), ...(page.details[row.key] ? { detail: lineDetail(row, page.details[row.key]) } : {}) })), newest: 'last', selectedKey: null, open: action('open'),
      empty: filtered(s) ? 'No log lines match these filters. Remove a filter, check the search syntax, or jump to a longer timeframe.' : 'No log lines in this timeframe. Jump to a longer one, or check in Mezmo that logs are arriving.', partial: null }))
  }

  const saveBlocks: Block[] = [ui.text('Save this search and its filters in Mezmo. The current time range stays in Bridge.')]
  if (s.saveResult && s.saveResult.outcome !== 'saved') {
    const result = s.saveResult
    saveBlocks.push(ui.notice(result.outcome === 'unknown' ? 'warning' : 'danger',
      result.outcome === 'unknown' ? 'Mezmo may have saved this view, but its answer could not be confirmed. Check the views in Mezmo before saving again; Bridge will not retry this request.'
      : result.outcome === 'not-sent' ? 'Nothing was sent. Check your connection, then submit the form again.'
      : result.status === 401 || result.status === 403 ? 'Mezmo refused the save. This key may not have access to create views; check its access in Mezmo.'
      : `Mezmo refused the save${result.status ? ` (${result.status})` : ''}. Check the view name and filters, then try again.`))
  }
  saveBlocks.push(ui.writeForm({key: 'save-view', title: 'Save view to Mezmo', fields: [
    {kind: 'text', key: 'name', label: 'View name', required: true, value: s.saveName, maxLength: 100}
  ], write: {operation: 'createView', body: {query: s.query, apps: s.apps, hosts: s.hosts, tags: s.tags, levels: s.levels}},
  submit: {label: 'Save view to Mezmo', action: action('save-view'), disabled: s.saveResult?.outcome === 'unknown'}}))
  const drawer = s.saveOpen ? ui.drawer({key: 'save-view', title: 'Save view', subtitle: 'Available in Mezmo and Bridge', back: {label: 'Back to logs', action: action('save-view-close')},
    controls: s.saveResult?.outcome === 'unknown' ? [ui.button('Check saved views', action('save-view-check'))] : [], blocks: saveBlocks}) : null
  return {
    state: { ...s } as unknown as JsonRecord,
    model: ui.explorer({ title: viewName, sidebar, toolbar, blocks, drawer, follow: { seconds: FOLLOW_SECONDS } })
  }
})
