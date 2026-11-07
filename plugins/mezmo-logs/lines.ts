/* Turning Mezmo lines into what the screens show: short table rows and one
 * line's detail, within Bridge's sizes. Pure ECMAScript (the isolated VM has
 * no TextEncoder, Intl or URL), so byte counts are done by hand. */
import type { MezmoLine } from './mezmo-api'

/** Bridge's text sizes, in UTF-8 bytes (ISOLATED_RUNTIME). */
export const CELL_BYTES = 512
export const BLOCK_BYTES = 8192
const PREVIEW_BYTES = 140
const MESSAGE_BYTES = 8000
const FIELD_VALUE_BYTES = 480
const MAX_FIELDS = 60
const MAX_META = 80

const byteSize = (code: number) => code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
export function byteLength(text: string): number {
  let bytes = 0
  for (const char of text) bytes += byteSize(char.codePointAt(0)!)
  return bytes
}
/** At most `max` UTF-8 bytes, cut on a character, an ellipsis when cut. */
export function clip(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length * 3 <= max || byteLength(text) <= max) return { text, clipped: false }
  let bytes = 0, end = 0
  for (const char of text) { const size = byteSize(char.codePointAt(0)!); if (bytes + size > max - 3) break; bytes += size; end += char.length }
  return { text: text.slice(0, end) + '…', clipped: true }
}
export function size(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n: number) => String(n).padStart(2, '0')
/** "Nov 5 14:03:12.345": the table's time, in UTC (the VM has no time zone). */
export function shortTime(ms: number, millis = true): string {
  const d = new Date(ms)
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}${millis ? '.' + String(d.getUTCMilliseconds()).padStart(3, '0') : ''}`
}
/** "2026-11-05 14:03:12.345 UTC". */
export function fullTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}:${two(d.getUTCSeconds())}.${String(d.getUTCMilliseconds()).padStart(3, '0')} UTC`
}
/** "2026-11-05 14:03", the custom range's own format, in UTC. */
export function minuteTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())} ${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`
}
/** Parses "YYYY-MM-DD HH:MM" (UTC; "T" or seconds also accepted), or null. */
export function parseMinute(text: string): number | null {
  const m = /^\s*(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?\s*(?:UTC|Z)?\s*$/i.exec(text)
  if (!m) return null
  const [y, mo, d, h, mi, s] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '0'].map(Number)
  const ms = Date.UTC(y, mo - 1, d, h, mi, s)
  const back = new Date(ms)
  return back.getUTCMonth() === mo - 1 && back.getUTCDate() === d && h < 24 && mi < 60 && s < 60 ? ms : null
}

const text = (value: unknown): string => typeof value === 'string' ? value : value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value)
const printable = (value: string) => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, ' ')

export function timestampOf(line: MezmoLine): number | null {
  const ts = line._ts
  return typeof ts === 'number' && Number.isFinite(ts) && ts >= 0 ? Math.round(ts) : null
}
export function levelOf(line: MezmoLine): string {
  const raw = line.level ?? line._level ?? line.severity
  return typeof raw === 'string' ? raw.trim().toLowerCase().slice(0, 24) : ''
}
/** What a code block shows: terminal colour codes removed, and control or
 * text-direction characters (invisible on screen, yet copied) made visible
 * as U+FFFD. Tabs and line breaks stay. */
export function shownText(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -\/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '\ufffd')
}
export function messageOf(line: MezmoLine): string {
  if (typeof line._line === 'string') return line._line
  if (typeof line.message === 'string') return line.message
  return text(line._line ?? line.message ?? '')
}
/** A short, stable key for one line within a page: its time and a hash of
 * what it says, so a page re-read can find it again. */
export function keyOf(line: MezmoLine, repeat = 0): string {
  let hash = 0x811c9dc5
  const seed = `${text(line._app)}\u0000${text(line._host)}\u0000${messageOf(line)}${repeat ? `\u0000${repeat}` : ''}`
  for (let i = 0; i < seed.length; i++) { hash ^= seed.charCodeAt(i); hash = Math.imul(hash, 0x01000193) >>> 0 }
  return `${timestampOf(line) ?? 0}-${hash.toString(16).padStart(8, '0')}`
}

/** Every line's key in its page, in Mezmo's order. The same line twice (the
 *  same time, app, host and words: it happens in real logs) gets a key of
 *  its own each time, as Bridge refuses a page whose rows share a key. */
export function keysOf(lines: readonly MezmoLine[]): string[] {
  const used = new Set<string>()
  return lines.map(line => {
    let repeat = 0, key = keyOf(line)
    while (used.has(key)) key = keyOf(line, ++repeat)
    used.add(key)
    return key
  })
}

export type Row = { key: string; ts: number; time: string; level: string; app: string; host: string; preview: string; text: string }
const STREAM_BYTES = 640, STREAM_LINES = 6
/** A stream line's text: the message as it was written (colours removed,
 *  invisible characters shown), its first lines, cut to fit the stream. */
export function streamText(message: string): string {
  const lines = shownText(message).replace(/\r\n?/g, '\n').split('\n'), kept = lines.slice(0, STREAM_LINES).join('\n').replace(/\s+$/, '')
  const cut = clip(kept || '(empty line)', STREAM_BYTES)
  return cut.text + (lines.length > STREAM_LINES && !cut.clipped ? `\n+${lines.length - STREAM_LINES} more lines` : '')
}
/** The message's first non-empty line, spaces collapsed, plus how many more. */
export function previewOf(message: string): string {
  const lines = message.split(/\r?\n/), first = lines.findIndex(line => line.trim()), rest = first < 0 ? 0 : lines.slice(first + 1).filter(line => line.trim()).length
  const head = first < 0 ? '(empty line)' : printable(shownText(lines[first])).replace(/\s+/g, ' ').trim()
  return clip(head, PREVIEW_BYTES).text + (rest ? `  +${rest} more ${rest === 1 ? 'line' : 'lines'}` : '')
}
export function rowOf(line: MezmoLine): Row {
  const ts = timestampOf(line) ?? 0
  return { key: keyOf(line), ts, time: ts ? shortTime(ts, false) : 'Unknown time', level: levelOf(line), app: clip(printable(text(line._app)), 96).text, host: clip(printable(text(line._host)), 96).text, preview: previewOf(messageOf(line)), text: streamText(messageOf(line)) }
}
/** Newest first, the way people read logs. Ties keep Mezmo's order. */
export function rowsOf(lines: MezmoLine[]): Row[] {
  const keys = keysOf(lines)
  return lines.map((line, index) => ({ row: { ...rowOf(line), key: keys[index] }, index })).sort((a, b) => b.row.ts - a.row.ts || a.index - b.index).map(item => item.row)
}

export type Pair = { label: string; value: string }
/** Mezmo's own facts about a line, for its chips: tags, size, environment, file, type. */
export type LineFacts = { tags: string[]; size: number | null; env: string | null; file: string | null; logtype: string | null }
export type Detail = Row & { message: string; messageBytes: number; messageClipped: boolean; fields: Pair[]; hiddenFields: number; meta: Pair[]; json: string; jsonClipped: boolean; facts: LineFacts }
const short = (x: unknown) => typeof x === 'string' && x.trim() ? clip(printable(x.trim()), 120).text : typeof x === 'number' && Number.isFinite(x) ? String(x) : null
function factsOf(line: MezmoLine, messageBytes: number): LineFacts {
  const tags = Array.isArray(line._tag) ? line._tag.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map(t => clip(printable(t.trim()), 60).text).slice(0, 24) : typeof line._tag === 'string' ? line._tag.split(',').map(t => t.trim()).filter(Boolean).slice(0, 24) : []
  const size = typeof line._mezmo_line_size === 'number' && Number.isFinite(line._mezmo_line_size) ? Math.round(line._mezmo_line_size) : messageBytes
  return { tags, size, env: short(line.env ?? line.environment ?? line._env), file: short(line._file), logtype: short(line._logtype) }
}
const SHOWN = new Set(['_line', '_ts', '_app', '_host', 'level'])
function flatten(value: unknown, prefix: string, out: Pair[], depth: number): void {
  if (value && typeof value === 'object' && !Array.isArray(value) && depth < 4 && Object.keys(value).length) {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) flatten(item, prefix ? `${prefix}.${key}` : key, out, depth + 1)
    return
  }
  out.push({ label: clip(printable(prefix), 120).text, value: clip(printable(text(value)), FIELD_VALUE_BYTES).text || '(empty)' })
}
export function detailOf(line: MezmoLine): Detail {
  const message = shownText(messageOf(line)), clipped = clip(message, MESSAGE_BYTES)
  const fields: Pair[] = [], meta: Pair[] = []
  for (const [key, value] of Object.entries(line)) {
    if (SHOWN.has(key)) continue
    if (key.startsWith('_')) flatten(value, key, meta, 3)
    else flatten(value, key, fields, 0)
  }
  const json = clip(shownText(JSON.stringify(line, null, 2)), MESSAGE_BYTES)
  return { ...rowOf(line), time: timestampOf(line) ? fullTime(timestampOf(line)!) : 'Unknown time', message: clipped.text, messageBytes: byteLength(message), messageClipped: clipped.clipped, fields: fields.slice(0, MAX_FIELDS), hiddenFields: Math.max(0, fields.length - MAX_FIELDS), meta: meta.slice(0, MAX_META), json: json.text, jsonClipped: json.clipped, facts: factsOf(line, byteLength(messageOf(line))) }
}
