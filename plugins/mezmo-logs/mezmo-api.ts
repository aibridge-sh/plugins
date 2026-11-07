/* Every assumption about Mezmo's Log Analysis export API lives in this one
 * module, so a difference from the live service is a one-file fix. None of
 * this has been checked against the live API yet (README, "Assumptions"):
 *
 *  A1  GET /v2/export on the address the person chose when connecting
 *      (https://api.mezmo.com, or the older https://api.logdna.com).
 *  A2  The service key rides as `Authorization: Token <key>`. Bridge
 *      attaches it (plugin.json `attach`); this code never sees it.
 *  A3  `from` and `to` are Unix epoch SECONDS (TIME_UNIT below). Mezmo's
 *      docs also mention milliseconds; flip TIME_UNIT if seconds are refused.
 *  A4  `size` is lines per page; `prefer=tail` asks for the newest lines in
 *      the range.
 *  A5  `query` is Mezmo search syntax; `apps`, `hosts` and `levels` are
 *      comma-separated lists.
 *  A6  The answer is {"lines": [...], "pagination_id": "..." | null}; the
 *      next page is the same request plus that `pagination_id`.
 *  A7  A line carries `_ts` (epoch ms), `_line` (the text), `_app`, `_host`
 *      and `level`; other `_` keys are metadata, the rest parsed fields.
 *  A8  401 means a wrong, revoked or expired key; 403 a key without export
 *      access; 429 a rate limit (Retry-After in seconds); 400 a refused
 *      query or range, explained by {"error": "..."} or {"message": "..."}.
 *  A9  GET /v1/config/view lists the saved views: an array (or {"views":
 *      [...]}) of {viewid, name, query, apps, hosts, levels, tags, category},
 *      and GET /v1/config/view/<viewid> answers one of them.
 *  A10 GET /v1/usage/apps, /v1/usage/hosts and /v1/usage/tags with from and
 *      to (epoch seconds) list the names seen: an array of strings or of
 *      objects naming one ({"app": ...}, {"host": ...}, {"tag": ...} or
 *      {"name": ...}). When they fail, the filters fall back to free entry.
 *  A11 The export takes no tag list: tags become `tag:<name>` terms in the
 *      Mezmo search, OR-ed together and AND-ed with the typed search. */
import { z } from 'zod'
import { PAGE_SIZE } from './search'

export const EXPORT_PATH = '/v2/export'
export const TIME_UNIT = 'seconds' as 'seconds' | 'milliseconds'
export const PREFER = 'tail'

/** One page request. Times are epoch milliseconds here, whatever Mezmo takes. */
export type ExportQuery = { from: number; to: number; query: string; apps: string[]; hosts: string[]; levels: string[]; tags?: string[]; cursor: string | null }

/** A11: the typed search with the chosen tags as Mezmo search terms. */
export function searchText(query: string, tags: readonly string[] = []): string {
  const typed = query.trim(), terms = tags.map(tag => /^[A-Za-z0-9_.:\/-]+$/.test(tag) ? `tag:${tag}` : `tag:"${tag.replace(/["\\]/g, '')}"`)
  const tagged = terms.length > 1 ? `(${terms.join(' OR ')})` : terms[0] ?? ''
  return typed && tagged ? `(${typed}) ${tagged}` : typed || tagged
}

const unit = (ms: number, up: boolean) => TIME_UNIT === 'milliseconds' ? Math.round(ms) : up ? Math.ceil(ms / 1000) : Math.floor(ms / 1000)

/** The relative URL Bridge sends to the connected origin. Only keys listed in
 * plugin.json's getPaths query list may appear; empty filters are left out. */
export function exportUrl(q: ExportQuery, size = PAGE_SIZE): string {
  const params: [string, string][] = [['from', String(unit(q.from, false))], ['to', String(unit(q.to, true))], ['size', String(size)], ['prefer', PREFER]]
  const text = searchText(q.query, q.tags)
  if (text) params.push(['query', text])
  if (q.apps.length) params.push(['apps', q.apps.join(',')])
  if (q.hosts.length) params.push(['hosts', q.hosts.join(',')])
  if (q.levels.length) params.push(['levels', q.levels.join(',')])
  if (q.cursor) params.push(['pagination_id', q.cursor])
  return EXPORT_PATH + '?' + params.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&')
}

export { listOf } from './search'

/** A pagination id Bridge can carry back as a read argument (plugin.json's
 * `cursor` pattern). Anything else ends paging instead of failing the read. */
export const CURSOR = /^[\x21-\x7e]{1,512}$/
const envelope = z.object({ lines: z.array(z.record(z.string(), z.unknown())).max(10000), pagination_id: z.string().nullable().optional() })
export type MezmoLine = Record<string, unknown>
export type ExportPage = { lines: MezmoLine[]; cursor: string | null; cursorUnusable: boolean }

export function parseExport(body: string): ExportPage | null {
  let json: unknown
  try { json = JSON.parse(body) } catch { return null }
  const parsed = envelope.safeParse(json)
  if (!parsed.success) return null
  const id = parsed.data.pagination_id ?? null
  const usable = id !== null && CURSOR.test(id)
  return { lines: parsed.data.lines, cursor: usable ? id : null, cursorUnusable: id !== null && id !== '' && !usable }
}

/* ---------- A9: saved views ---------- */
export const VIEWS_PATH = '/v1/config/view'
export const viewUrl = (id: string) => `${VIEWS_PATH}/${encodeURIComponent(id)}`
/** A view id Bridge can carry as a read argument (plugin.json's pattern). */
export const VIEW_ID = /^[A-Za-z0-9_-]{1,64}$/
export type MezmoView = { id: string; name: string; group: string; query: string; apps: string[]; hosts: string[]; levels: string[]; tags: string[] }
const names = (x: unknown, max = 50): string[] => Array.isArray(x) ? x.filter((v): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 200).map(v => v.trim()).slice(0, max) : typeof x === 'string' && x.trim() ? x.split(',').map(v => v.trim()).filter(Boolean).slice(0, max) : []
function viewOf(raw: unknown): MezmoView | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const v = raw as Record<string, unknown>, id = typeof v.viewid === 'string' ? v.viewid : typeof v.id === 'string' ? v.id : ''
  if (!VIEW_ID.test(id)) return null
  const category = names(v.category, 1)[0] ?? (typeof v.category === 'string' ? v.category : '')
  return { id, name: (typeof v.name === 'string' && v.name.trim() ? v.name.trim() : id).slice(0, 100), group: category.slice(0, 60), query: typeof v.query === 'string' ? v.query.slice(0, 500) : '', apps: names(v.apps), hosts: names(v.hosts), levels: names(v.levels).map(l => l.toLowerCase()), tags: names(v.tags) }
}
/** The views listing (A9), sorted by group then name, or null when the body is not one. */
export function parseViews(body: string): MezmoView[] | null {
  let json: unknown
  try { json = JSON.parse(body) } catch { return null }
  const list = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as { views?: unknown }).views) ? (json as { views: unknown[] }).views : null
  if (!list) return null
  return list.slice(0, 500).map(viewOf).filter((v): v is MezmoView => !!v).sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
}
export function parseView(body: string): MezmoView | null {
  try { return viewOf(JSON.parse(body)) } catch { return null }
}

/* ---------- A10: the names seen, for the filter menus ---------- */
export type UsageKind = 'apps' | 'hosts' | 'tags'
export const usageUrl = (kind: UsageKind, from: number, to: number) => `/v1/usage/${kind}?from=${unit(from, false)}&to=${unit(to, true)}`
export function parseUsage(body: string, kind: UsageKind, max = 100): string[] | null {
  let json: unknown
  try { json = JSON.parse(body) } catch { return null }
  const list = Array.isArray(json) ? json : json && typeof json === 'object' && Array.isArray((json as Record<string, unknown>)[kind]) ? (json as Record<string, unknown[]>)[kind] : null
  if (!list) return null
  const field = kind === 'apps' ? 'app' : kind === 'hosts' ? 'host' : 'tag', out: string[] = []
  for (const item of list) {
    const name = typeof item === 'string' ? item : item && typeof item === 'object' ? [(item as Record<string, unknown>)[field], (item as Record<string, unknown>).name, (item as Record<string, unknown>).value].find(v => typeof v === 'string') : undefined
    if (typeof name === 'string' && name.trim() && name.length <= 120 && !out.includes(name.trim())) out.push(name.trim())
    if (out.length >= max) break
  }
  return out.sort((a, b) => a.localeCompare(b))
}

export type ProblemKind = 'auth' | 'forbidden' | 'rate' | 'bad-request' | 'not-found' | 'server' | 'unexpected' | 'network' | 'timeout' | 'too-large' | 'busy' | 'refused'
export type Problem = { kind: ProblemKind; status: number | null; retryAfter: number | null; detail: string }

/** What a non-200 answer means for the person. `detail` is Mezmo's own
 * explanation, printable and short, when its body has one. */
export function problemFor(status: number, headers: Record<string, string>, body: string): Problem | null {
  if (status === 200) return null
  const kind: ProblemKind = status === 401 ? 'auth' : status === 403 ? 'forbidden' : status === 429 ? 'rate' : status === 400 || status === 422 ? 'bad-request' : status === 404 ? 'not-found' : status >= 500 ? 'server' : 'unexpected'
  const retry = /^\d{1,6}$/.test((headers['retry-after'] ?? '').trim()) ? Number(headers['retry-after'].trim()) : null
  return { kind, status, retryAfter: kind === 'rate' ? retry : null, detail: detailOf(body) }
}

function detailOf(body: string): string {
  let json: unknown
  try { json = JSON.parse(body) } catch { return '' }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return ''
  const record = json as Record<string, unknown>
  for (const key of ['error', 'message', 'details']) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) {
      const clean = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim()
      return clean.length > 200 ? clean.slice(0, 199) + '…' : clean
    }
  }
  return ''
}

/** A failure Bridge reported instead of an HTTP answer (PluginError codes). */
export function transportProblem(code: unknown): Problem {
  const kind: ProblemKind = code === 'timeout' ? 'timeout' : code === 'too-large' ? 'too-large' : code === 'busy' ? 'busy' : code === 'not-enabled' ? 'refused' : 'network'
  return { kind, status: null, retryAfter: null, detail: '' }
}
