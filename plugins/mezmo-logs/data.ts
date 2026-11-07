/* Data handlers: they run in Bridge's data VM. Bridge attaches the service
 * key and sends each request only to the address the person connected; this
 * code never sees the key. Each read is one to three requests. */
import { defineData, type DataContext } from '@aibridge/sdk/isolated/backend'
import { exportUrl, listOf, parseExport, parseUsage, parseView, parseViews, problemFor, transportProblem, usageUrl, viewUrl, VIEW_ID, VIEWS_PATH, type ExportPage, type ExportQuery, type MezmoView, type Problem, type UsageKind } from './mezmo-api'
import { detailOf, keysOf, rowsOf } from './lines'
import { OPEN_MAX, windowOf, type Filters, type SavedViewAnswer, type SearchAnswer, type SearchArgs, type ValuesAnswer, type ViewsAnswer } from './search'

const WEEK = 7 * 86_400_000
async function get(url: string, ctx: DataContext): Promise<{ problem: Problem } | { status: 200; body: string }> {
  let response
  try { response = await ctx.http.request({ url, method: 'GET', credential: 'mezmo', headers: { accept: 'application/json' } }) }
  catch (error) { return { problem: transportProblem((error as { code?: unknown })?.code) } }
  const problem = problemFor(response.status, response.headers, response.body)
  return problem ? { problem } : { status: 200, body: response.body }
}
const unexpected = (detail: string): Problem => ({ kind: 'unexpected', status: 200, retryAfter: null, detail })
const filtersOf = (view: MezmoView): Filters => ({ query: view.query, apps: view.apps, hosts: view.hosts, levels: view.levels, tags: view.tags })

/** The page for these arguments: one export request. */
async function page(args: SearchArgs, ctx: DataContext): Promise<{ problem: Problem; window: { from: number; to: number } } | { page: ExportPage; window: { from: number; to: number } }> {
  const window = windowOf(args, ctx.now())
  const filters: Filters = { query: args.query ?? '', apps: listOf(args.apps ?? ''), hosts: listOf(args.hosts ?? ''), levels: listOf(args.levels ?? ''), tags: listOf(args.tags ?? '') }
  const query: ExportQuery = { ...window, ...filters, cursor: args.cursor ?? null }
  const answer = await get(exportUrl(query), ctx)
  if ('problem' in answer) return { problem: answer.problem, window }
  const parsed = parseExport(answer.body)
  return parsed ? { page: parsed, window } : { problem: unexpected('The answer was not the export format this plugin expects.'), window }
}

export default defineData({ reads: {
  /** One page; with `open`, the expanded lines in full too (Mezmo has no
   *  single-line read, so a line's detail comes from its page). */
  async search(args: SearchArgs, ctx): Promise<SearchAnswer> {
    const got = await page(args, ctx)
    if ('problem' in got) return { ok: false, ...got.window, problem: got.problem }
    const wanted = new Set((args.open ?? '').split(',').filter(k => /^[0-9]{1,16}-[0-9a-f]{8}$/.test(k)).slice(0, OPEN_MAX)), details: Record<string, ReturnType<typeof detailOf>> = {}
    const keys = keysOf(got.page.lines)
    got.page.lines.forEach((line, i) => { if (wanted.has(keys[i])) details[keys[i]] = { ...detailOf(line), key: keys[i] } })
    return { ok: true, ...got.window, rows: rowsOf(got.page.lines), next: got.page.cursor, nextUnusable: got.page.cursorUnusable, details }
  },
  /** One saved view's search and filters, read when it is chosen. */
  async savedView(args: { view: string }, ctx): Promise<SavedViewAnswer> {
    if (!VIEW_ID.test(args.view)) return { ok: false, problem: unexpected('That saved view id is not one Mezmo uses.') }
    const answer = await get(viewUrl(args.view), ctx)
    if ('problem' in answer) return { ok: false, problem: answer.problem }
    const view = parseView(answer.body)
    return view ? { ok: true, filters: filtersOf(view) } : { ok: false, problem: unexpected('The saved view was not in the format this plugin expects.') }
  },
  /** The saved views for the sidebar, names only (their filters are read
   *  when one is chosen). */
  async views(_args: Record<string, never>, ctx): Promise<ViewsAnswer> {
    const answer = await get(VIEWS_PATH, ctx)
    if ('problem' in answer) return { ok: false, problem: answer.problem }
    const views = parseViews(answer.body)
    if (!views) return { ok: false, problem: unexpected('The saved views were not in the format this plugin expects.') }
    return { ok: true, views: views.slice(0, 150).map(v => ({ id: v.id, name: v.name, group: v.group })), more: Math.max(0, views.length - 150) }
  },
  /** The app, host and tag names of the last week, for the filter menus;
   *  each that fails is null, and its menu falls back to free entry. */
  async values(_args: Record<string, never>, ctx): Promise<ValuesAnswer> {
    const to = ctx.now(), from = to - WEEK, out: ValuesAnswer = { apps: null, hosts: null, tags: null }
    for (const kind of ['apps', 'hosts', 'tags'] as UsageKind[]) {
      const answer = await get(usageUrl(kind, from, to), ctx)
      out[kind] = 'problem' in answer ? null : parseUsage(answer.body, kind)
    }
    return out
  }
} })
