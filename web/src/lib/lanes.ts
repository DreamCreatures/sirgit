import type { CommitRow } from './types'

/**
 * Lane assignment over the display-ordered rows.
 *
 * With branch tips (the app always passes them), lanes follow BRANCHES —
 * gitgraph/GitButler style — in one of two switchable layouts:
 * - 'tree' (default): the checked-out branch owns the trunk; its first-parent
 *   chain runs straight down the MIDDLE of the lane band; every other
 *   branch's chain gets its own column, alternating sides around the trunk
 *   (newest tip → trunk+1, next → trunk−1, …) so branches fan out left AND
 *   right — with the band centered by the view (GraphView's originX), the
 *   HEAD branch sits where the eye rests, not glued to the left edge;
 * - 'left': the classic layout — trunk on lane 0 (leftmost), side branches
 *   stack to the right ordered by tip recency; nothing centers.
 * Tags never affect lanes; commits unreachable from any branch tip (merged
 * and deleted branches) form their own chains as fallback.
 *
 * Without tips (unit tests, unknown refs) it falls back to the original
 * topology-only algorithm: a commit continues its parent's lane, merge
 * parents fan out to their own lanes, lanes expecting the same commit
 * consolidate.
 *
 * Pure + deterministic so it can be unit-tested and memoized.
 */
export type LaneMode = 'tree' | 'left'

export interface LaneLayout {
  /** sha → lane slot (0 = leftmost); in tree mode the trunk holds the middle slot */
  lanes: Map<string, number>
  laneCount: number
}

export interface BranchTip {
  sha: string
  /** checked-out branch — owns the trunk lane */
  current: boolean
}

export function assignLanes(
  ordered: CommitRow[],
  tips: BranchTip[] = [],
  headSha?: string | null,
  mode: LaneMode = 'tree',
): LaneLayout {
  if (tips.length === 0 && !headSha) return assignLanesTopo(ordered)
  return assignLanesChains(ordered, tips, headSha, mode)
}

/** Topology-only assignment (legacy fallback): parent-lane continuation. */
function assignLanesTopo(ordered: CommitRow[]): LaneLayout {
  const lanes: Map<string, number> = new Map()
  /** expected parent sha per column (null = free) */
  let expected: (string | null)[] = []
  let laneCount = 0

  const findExpected = (sha: string): number => expected.indexOf(sha)
  const firstFree = (): number => {
    const i = expected.indexOf(null)
    return i === -1 ? expected.length : i
  }
  const ensureCapacity = (i: number): void => {
    while (expected.length <= i) expected.push(null)
  }
  const setLane = (i: number, sha: string | null): void => {
    ensureCapacity(i)
    expected[i] = sha
    laneCount = Math.max(laneCount, i + 1)
  }

  for (const row of ordered) {
    let lane = findExpected(row.sha)
    if (lane === -1) {
      lane = firstFree()
    }
    lanes.set(row.sha, lane)

    // consolidate: any other lane still expecting this commit merges into it
    for (let k = 0; k < expected.length; k++) {
      if (k !== lane && expected[k] === row.sha) {
        expected[k] = null
      }
    }

    if (row.parents.length === 0) {
      // root commit — lane continues to nothing
      expected[lane] = null
    } else {
      // first parent continues this lane
      expected[lane] = row.parents[0]
      // extra parents (merges): reuse an existing expecting lane or open one
      for (let p = 1; p < row.parents.length; p++) {
        const existing = findExpected(row.parents[p])
        if (existing !== -1 && existing !== lane) continue // already drawn as its own line
        const newLane = firstFree()
        setLane(newLane, row.parents[p])
      }
    }
    // lane count = highest occupied column + 1
    for (let k = expected.length - 1; k >= 0; k--) {
      if (expected[k] !== null) {
        laneCount = Math.max(laneCount, k + 1)
        break
      }
    }
  }

  return { lanes, laneCount: Math.max(1, laneCount) }
}

/**
 * Branch-chain assignment. Walks the first-parent chain of every branch tip;
 * each chain draws as one straight column, so a branch "buds off" its base
 * with a curve and linear history never wiggles.
 */
function assignLanesChains(
  ordered: CommitRow[],
  tips: BranchTip[],
  headSha: string | null | undefined,
  mode: LaneMode,
): LaneLayout {
  const rowBySha = new Map<string, CommitRow>()
  const idxBySha = new Map<string, number>()
  ordered.forEach((r, i) => {
    rowBySha.set(r.sha, r)
    idxBySha.set(r.sha, i)
  })
  const lanes = new Map<string, number>()
  const claimed = new Set<string>()

  // walk the first-parent chain from a tip down to the first claimed commit
  const walk = (startSha: string): CommitRow[] => {
    const chain: CommitRow[] = []
    let sha: string | undefined = startSha
    while (sha && rowBySha.has(sha) && !claimed.has(sha)) {
      const row: CommitRow = rowBySha.get(sha)!
      claimed.add(sha)
      chain.push(row)
      sha = row.parents[0]
    }
    return chain
  }

  interface Chain {
    rows: CommitRow[]
    trunk: boolean
  }
  const chains: Chain[] = []

  // trunk: the checked-out branch, or a detached HEAD
  const trunkTip = tips.find((t) => t.current) ?? (headSha ? { sha: headSha, current: true } : undefined)
  if (trunkTip && rowBySha.has(trunkTip.sha)) {
    chains.push({ rows: walk(trunkTip.sha), trunk: true })
  }

  // side branches: newest tip first → closest column to the trunk
  const sideTips = tips
    .filter((t) => rowBySha.has(t.sha) && !claimed.has(t.sha))
    .sort((a, b) => (idxBySha.get(a.sha) ?? 0) - (idxBySha.get(b.sha) ?? 0))
  for (const t of sideTips) {
    const rows = walk(t.sha)
    if (rows.length > 0) chains.push({ rows, trunk: false })
  }

  // detached HEAD not covered by any branch tip
  if (headSha && !claimed.has(headSha) && rowBySha.has(headSha)) {
    const rows = walk(headSha)
    if (rows.length > 0) chains.push({ rows, trunk: false })
  }

  // anything unreachable from a branch tip (merged + deleted branches):
  // walk it too so a linear unref'd history stays in one column
  for (const row of ordered) {
    if (!claimed.has(row.sha)) {
      const rows = walk(row.sha)
      if (rows.length > 0) chains.push({ rows, trunk: false })
    }
  }

  if (mode === 'left') {
    // classic layout: trunk owns lane 0, side chains stack to the right
    // ordered by tip recency (newest tip = closest branch column)
    let lane = 1
    for (const chain of chains) {
      const l = chain.trunk ? 0 : lane
      for (const r of chain.rows) lanes.set(r.sha, l)
      if (!chain.trunk) lane++
    }
    return { lanes, laneCount: Math.max(1, lane) }
  }

  // tree layout: trunk = offset 0; the first FAN_CAP side chains ALTERNATE
  // sides around it, double-spaced (1st → +2, 2nd → −2, 3rd → +3, …) — one
  // lane of breathing room between the trunk and its nearest siblings,
  // whose chips face the trunk (mirrored rows). Chains BEYOND the fan stack
  // monotonically to the right: merge-heavy histories (ungit: ~470 merged-PR
  // subtrees) must not widen the alternating band, or the trunk lands mid-
  // band thousands of pixels off-screen and the page reads as empty.
  // Offsets normalize to plain 0..laneCount−1 slots — consumers never see a
  // negative lane; the view centers the TRUNK, not the band.
  const FAN_CAP = 10
  const fanRight = Math.ceil(FAN_CAP / 2) + 1
  let sideIndex = 0
  const offsets = chains.map((chain) => {
    if (chain.trunk) return 0
    sideIndex++
    if (sideIndex <= FAN_CAP) {
      return sideIndex % 2 === 1 ? (sideIndex + 1) / 2 + 1 : -(sideIndex / 2 + 1)
    }
    return fanRight + (sideIndex - FAN_CAP)
  })
  let min = 0
  let max = 0
  for (const o of offsets) {
    if (o < min) min = o
    if (o > max) max = o
  }
  const left = -min
  chains.forEach((chain, i) => {
    const lane = offsets[i] + left
    for (const r of chain.rows) lanes.set(r.sha, lane)
  })

  return { lanes, laneCount: Math.max(1, max + left + 1) }
}

/**
 * Edges for the visible slice only: returns, per row index, the parent
 * segments to draw. Parents outside the visible slice get a downward stub.
 */
export interface EdgeSeg {
  /** index in ordered (source row, a commit) */
  fromIdx: number
  fromLane: number
  /** target index in ordered (may be -1 for dangling parent) */
  toIdx: number
  toLane: number
  /** dangling stub: target not loaded */
  dangling: boolean
}

export function buildEdges(
  ordered: CommitRow[],
  lanes: Map<string, number>,
): EdgeSeg[] {
  const idxBySha = new Map<string, number>()
  for (let i = 0; i < ordered.length; i++) idxBySha.set(ordered[i].sha, i)

  const edges: EdgeSeg[] = []
  for (let i = 0; i < ordered.length; i++) {
    const row = ordered[i]
    const fromLane = lanes.get(row.sha) ?? 0
    for (const p of row.parents) {
      const toIdx = idxBySha.get(p)
      if (toIdx === undefined) {
        edges.push({ fromIdx: i, fromLane, toIdx: -1, toLane: fromLane, dangling: true })
      } else {
        edges.push({
          fromIdx: i,
          fromLane,
          toIdx,
          toLane: lanes.get(p) ?? fromLane,
          dangling: false,
        })
      }
    }
  }
  return edges
}
