import { create } from 'zustand'
import { api } from '../lib/client'
import type { CommitRow } from '../lib/types'
import { orderRows } from '../lib/order'
import { assignLanes, buildEdges, type BranchTip, type EdgeSeg, type LaneLayout } from '../lib/lanes'

/**
 * Client-side commit-graph state. Pages are fetched at disjoint offsets and
 * merged by sha (never re-fetched) — the direct fix for ungit's cumulative
 * "load more" that re-downloaded and re-rendered the whole history.
 */

interface GraphState {
  path: string | null
  rowsBySha: Map<string, CommitRow>
  /** branch tips for lane assignment (checked-out branch owns the trunk) */
  branchTips: BranchTip[]
  headSha: string | null
  /**
   * Non-tracking-branch filter: extra reachability roots (remote-branch and
   * tag tips) that must stay visible. null = filter off, every loaded row is
   * shown; an array = only rows reachable from tips ∪ extraRoots ∪ HEAD are
   * ordered/rendered (rowsBySha keeps everything for previews + un-filtering).
   */
  extraRoots: string[] | null
  /** display order (date-order topological over loaded rows) */
  ordered: CommitRow[]
  laneLayout: LaneLayout
  edges: EdgeSeg[]
  revision: number | null
  total: number
  /** next server-side offset to fetch (monotonic per revision) */
  nextOffset: number
  fetchingOlder: boolean
  exhausted: boolean

  reset(path: string): void
  setGraphRefs(tips: BranchTip[], headSha: string | null, extraRoots?: string[] | null): void
  loadFirstPage(): Promise<void>
  /** pageSize may be raised while seeking a deep row (scroll-to-sha) */
  loadOlder(pageSize?: number): Promise<void>
  applyDelta(): Promise<void>
}

function derive(
  rowsBySha: Map<string, CommitRow>,
  tips: BranchTip[],
  headSha: string | null,
  extraRoots?: string[] | null,
) {
  let rows = [...rowsBySha.values()]
  if (extraRoots) {
    // branch filter active: a row stays only if reachable from the VISIBLE
    // refs — tips already exclude hidden branches; extraRoots pins remote
    // and tag history so shared/remote commits never disappear
    const reach = new Set<string>()
    const stack: string[] = [...tips.map((t) => t.sha), ...extraRoots]
    if (headSha) stack.push(headSha)
    while (stack.length > 0) {
      const sha = stack.pop()!
      if (reach.has(sha)) continue
      reach.add(sha)
      const row = rowsBySha.get(sha)
      if (row) stack.push(...row.parents)
    }
    rows = rows.filter((r) => reach.has(r.sha))
  }
  const ordered = orderRows(rows)
  const laneLayout = assignLanes(ordered, tips, headSha)
  const edges = buildEdges(ordered, laneLayout.lanes)
  return { ordered, laneLayout, edges }
}

export const useGraphStore = create<GraphState>((set, get) => ({
  path: null,
  rowsBySha: new Map(),
  branchTips: [],
  headSha: null,
  extraRoots: null,
  ordered: [],
  laneLayout: { lanes: new Map(), laneCount: 1 },
  edges: [],
  revision: null,
  total: 0,
  nextOffset: 0,
  fetchingOlder: false,
  exhausted: false,

  reset(path) {
    set({
      path,
      rowsBySha: new Map(),
      branchTips: [],
      headSha: null,
      extraRoots: null,
      ordered: [],
      laneLayout: { lanes: new Map(), laneCount: 1 },
      edges: [],
      revision: null,
      total: 0,
      nextOffset: 0,
      exhausted: false,
      fetchingOlder: false,
    })
    void get().loadFirstPage()
  },

  setGraphRefs(tips, headSha, extraRoots = null) {
    set({ branchTips: tips, headSha, extraRoots })
    const { rowsBySha } = get()
    if (rowsBySha.size > 0) set(derive(rowsBySha, tips, headSha, extraRoots))
  },

  async loadFirstPage() {
    const { path } = get()
    if (!path) return
    set({ nextOffset: 0, exhausted: false })
    await get().loadOlder()
  },

  async loadOlder(pageSize = 200) {
    const { path, nextOffset, fetchingOlder, exhausted, rowsBySha } = get()
    if (!path || fetchingOlder || exhausted) return
    set({ fetchingOlder: true })
    try {
      const page = await api.log(path, nextOffset, pageSize)
      const merged = new Map(rowsBySha)
      for (const r of page.rows) merged.set(r.sha, r)
      const derived = derive(merged, get().branchTips, get().headSha, get().extraRoots)
      set({
        rowsBySha: merged,
        ...derived,
        revision: page.revision,
        total: page.total,
        nextOffset: page.offset + page.rows.length,
        exhausted: page.offset + page.rows.length >= page.total,
      })
    } finally {
      set({ fetchingOlder: false })
    }
  },

  /** Called on WS change events: O(delta) sync instead of refetching pages. */
  async applyDelta() {
    const { path, revision } = get()
    if (!path) return
    if (revision === null) {
      await get().loadFirstPage()
      return
    }
    const delta = await api.logDelta(path, revision)
    if (!delta.changed) {
      set({ revision: delta.revision })
      return
    }
    if (delta.reset) {
      // too many revisions missed — full resync
      await get().loadFirstPage()
      return
    }
    const rowsBySha = new Map(get().rowsBySha)
    for (const r of delta.added ?? []) rowsBySha.set(r.sha, r)
    for (const sha of delta.removed ?? []) rowsBySha.delete(sha)
    const derived = derive(rowsBySha, get().branchTips, get().headSha, get().extraRoots)
    // NOTE: nextOffset intentionally not shifted — new commits are inserted at
    // the top of the server list, so the next page may briefly overlap already
    // loaded rows; the sha-keyed merge dedupes them (never skips, unlike an
    // offset shift which would silently drop rows).
    const grow = (delta.added?.length ?? 0) - (delta.removed?.length ?? 0)
    set({
      rowsBySha,
      ...derived,
      revision: delta.revision,
      total: get().total + grow,
      exhausted: false,
    })
  },
}))
