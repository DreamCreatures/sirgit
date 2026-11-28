import { create } from 'zustand'
import { api } from '../lib/client'
import type { CommitRow } from '../lib/types'
import { orderRows } from '../lib/order'
import { assignLanes, buildEdges, type BranchTip, type EdgeSeg, type LaneLayout, type LaneMode } from '../lib/lanes'

/**
 * Client-side commit-graph state. Pages are fetched at disjoint offsets and
 * merged by sha (never re-fetched) — the direct fix for ungit's cumulative
 * "load more" that re-downloaded and re-rendered the whole history.
 */

/** Snapshot of the PREVIOUS layout, kept briefly so lane moves can animate. */
export interface LaneAnim {
  lanes: Map<string, number>
  edges: EdgeSeg[]
  laneCount: number
  /** Date.now() at snapshot time — clears itself after the transition */
  at: number
}

interface GraphState {
  path: string | null
  rowsBySha: Map<string, CommitRow>
  /** branch tips for lane assignment (checked-out branch owns the trunk) */
  branchTips: BranchTip[]
  headSha: string | null
  /** lane layout: centered tree around the trunk, or classic left-anchored */
  laneMode: LaneMode
  /** display order (date-order topological over loaded rows) */
  ordered: CommitRow[]
  laneLayout: LaneLayout
  edges: EdgeSeg[]
  /** previous layout when rows changed lanes — drives the slide/cross-fade */
  anim: LaneAnim | null
  /** load failure ("path is not a repository", …) — replaces the fake empty graph */
  loadError: string | null
  revision: number | null
  total: number
  /** next server-side offset to fetch (monotonic per revision) */
  nextOffset: number
  fetchingOlder: boolean
  exhausted: boolean

  reset(path: string): void
  setGraphRefs(tips: BranchTip[], headSha: string | null): void
  setLaneMode(mode: LaneMode): void
  loadFirstPage(): Promise<void>
  /** pageSize may be raised while seeking a deep row (scroll-to-sha) */
  loadOlder(pageSize?: number): Promise<void>
  applyDelta(): Promise<void>
}

function derive(
  rowsBySha: Map<string, CommitRow>,
  tips: BranchTip[],
  headSha: string | null,
  laneMode: LaneMode,
) {
  const ordered = orderRows([...rowsBySha.values()])
  const laneLayout = assignLanes(ordered, tips, headSha, laneMode)
  const edges = buildEdges(ordered, laneLayout.lanes)
  return { ordered, laneLayout, edges }
}

const ANIM_MS = 420

/**
 * Snapshot the PREVIOUS layout when rows changed lanes: merge, move,
 * checkout, stash … all reassign chains, and the nodes should SLIDE to their
 * new columns (with the old edges fading out) instead of teleporting.
 * Pages that only append rows (no lane change) skip the snapshot.
 */
function withAnim(
  prev: { laneLayout: LaneLayout; edges: EdgeSeg[] },
  next: LaneLayout,
): LaneAnim | null {
  let moved = false
  for (const [sha, lane] of prev.laneLayout.lanes) {
    if (next.lanes.get(sha) !== lane) {
      moved = true
      break
    }
  }
  if (!moved) return null
  return {
    lanes: prev.laneLayout.lanes,
    edges: prev.edges,
    laneCount: prev.laneLayout.laneCount,
    at: Date.now(),
  }
}

function scheduleAnimClear(set: (partial: Partial<GraphState>) => void, get: () => GraphState) {
  const at = get().anim?.at
  if (at == null) return
  setTimeout(() => {
    if (get().anim?.at === at) set({ anim: null })
  }, ANIM_MS + 60)
}

export const useGraphStore = create<GraphState>((set, get) => ({
  path: null,
  rowsBySha: new Map(),
  branchTips: [],
  headSha: null,
  laneMode: 'tree',
  ordered: [],
  laneLayout: { lanes: new Map(), laneCount: 1 },
  edges: [],
  anim: null,
  loadError: null,
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
      ordered: [],
      laneLayout: { lanes: new Map(), laneCount: 1 },
      edges: [],
      anim: null,
      loadError: null,
      revision: null,
      total: 0,
      nextOffset: 0,
      exhausted: false,
      fetchingOlder: false,
    })
    void get().loadFirstPage()
  },

  setGraphRefs(tips, headSha) {
    const { rowsBySha, laneMode, laneLayout, edges } = get()
    if (rowsBySha.size === 0) {
      set({ branchTips: tips, headSha })
      return
    }
    const derived = derive(rowsBySha, tips, headSha, laneMode)
    set({
      branchTips: tips,
      headSha,
      ...derived,
      anim: withAnim({ laneLayout, edges }, derived.laneLayout),
    })
    scheduleAnimClear(set, get)
  },

  setLaneMode(mode) {
    const { rowsBySha, branchTips, headSha, laneLayout, edges } = get()
    if (rowsBySha.size === 0) {
      set({ laneMode: mode })
      return
    }
    const derived = derive(rowsBySha, branchTips, headSha, mode)
    set({
      laneMode: mode,
      ...derived,
      anim: withAnim({ laneLayout, edges }, derived.laneLayout),
    })
    scheduleAnimClear(set, get)
  },

  async loadFirstPage() {
    const { path } = get()
    if (!path) return
    set({ nextOffset: 0, exhausted: false, loadError: null })
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
      const derived = derive(merged, get().branchTips, get().headSha, get().laneMode)
      set({
        rowsBySha: merged,
        ...derived,
        loadError: null,
        revision: page.revision,
        total: page.total,
        nextOffset: page.offset + page.rows.length,
        exhausted: page.offset + page.rows.length >= page.total,
      })
    } catch (e: unknown) {
      // a bad/moved path used to render as a FAKE empty repo ("no commits")
      // because the error was swallowed by try/finally
      const msg = e instanceof Error ? e.message : String(e)
      set({ loadError: msg, exhausted: true })
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
    let delta
    try {
      delta = await api.logDelta(path, revision)
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      set({ loadError: msg })
      return
    }
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
    const derived = derive(rowsBySha, get().branchTips, get().headSha, get().laneMode)
    // NOTE: nextOffset intentionally not shifted — new commits are inserted at
    // the top of the server list, so the next page may briefly overlap already
    // loaded rows; the sha-keyed merge dedupes them (never skips, unlike an
    // offset shift which would silently drop rows).
    const grow = (delta.added?.length ?? 0) - (delta.removed?.length ?? 0)
    set({
      rowsBySha,
      ...derived,
      anim: withAnim({ laneLayout: get().laneLayout, edges: get().edges }, derived.laneLayout),
      revision: delta.revision,
      total: get().total + grow,
      exhausted: false,
    })
    scheduleAnimClear(set, get)
  },
}))
