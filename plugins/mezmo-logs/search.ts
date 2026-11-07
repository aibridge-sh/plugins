/* What the view and the data handlers agree on: the time ranges, a read's
 * arguments (plugin.json declares the same names) and the answers. */
import type { Problem } from './mezmo-api'
import type { Detail, Row } from './lines'

/** Lines per page: one export request each. */
export const PAGE_SIZE = 100
export const PRESETS = { '15m': 15 * 60_000, '1h': 3_600_000, '24h': 86_400_000, '7d': 7 * 86_400_000 } as const
export type Preset = keyof typeof PRESETS
export type Range = Preset | 'custom'
export const RANGE_LABELS: Record<Range, string> = { '15m': 'Last 15 minutes', '1h': 'Last hour', '24h': 'Last 24 hours', '7d': 'Last 7 days', custom: 'Custom range' }
/** `open`: the keys of the lines shown expanded (comma-separated, ≤ 8). */
export type SearchArgs = { range: Range; from?: number; to?: number; query?: string; apps?: string; hosts?: string; levels?: string; tags?: string; cursor?: string; open?: string }
export const OPEN_MAX = 8
export type Filters = { query: string; apps: string[]; hosts: string[]; levels: string[]; tags: string[] }
export type SearchAnswer = { ok: true; from: number; to: number; rows: Row[]; next: string | null; nextUnusable: boolean; details: Record<string, Detail> } | { ok: false; from: number; to: number; problem: Problem }
export type ViewItem = { id: string; name: string; group: string }
export type ViewsAnswer = { ok: true; views: ViewItem[]; more: number } | { ok: false; problem: Problem }
export type SavedViewAnswer = { ok: true; filters: Filters } | { ok: false; problem: Problem }
export type ValuesAnswer = { apps: string[] | null; hosts: string[] | null; tags: string[] | null }

/** The window a search covers: as given, or the preset ending now. */
export function windowOf(args: SearchArgs, now: number): { from: number; to: number } {
  if (typeof args.from === 'number' && typeof args.to === 'number') return { from: args.from, to: args.to }
  return { from: now - PRESETS[args.range === 'custom' ? '1h' : args.range], to: now }
}

/** A comma-separated filter as typed: trimmed, empties and repeats dropped. */
export function listOf(text: string, max = 20): string[] {
  const out: string[] = []
  for (const part of text.split(',')) { const item = part.trim(); if (item && !out.includes(item) && out.length < max) out.push(item) }
  return out
}
