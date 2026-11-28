import { memo, useMemo } from 'react'
import { useGraphStore } from '../../state/graphStore'
import { ROW_H, laneX } from './GraphView'
import type { EdgeSeg } from '../../lib/lanes'

const LANE_PALETTE = [
  '#3fb950', '#58a6ff', '#bc8cff', '#f778ba', '#ffa657',
  '#39c5cf', '#f2cc60', '#a371f7', '#7ee787', '#ff9bce',
]

export function laneColor(lane: number): string {
  return LANE_PALETTE[lane % LANE_PALETTE.length]
}

const STROKE_W = 2.5

/**
 * SVG edge layer culled to the visible window. Edges are bezier curves from a
 * commit to each of its parents; unloaded (dangling) parents get a downward
 * stub so the graph visibly continues beyond the loaded window. `originX`
 * shifts the whole layer right when the lane band is centered (tree layout).
 *
 * When the store holds a lane `anim` (rows just changed lanes — merge, move,
 * checkout, stash), the MOVED edges cross-fade: the old-lane edges fade out
 * while the new-lane edges fade in, matching the rows' slide transition.
 * Stable edges render once, at full opacity, as before.
 */
function GraphEdgesInner({
  start,
  end,
  offset = 0,
  gapAfter = -1,
  gapSize = 0,
  dim = false,
  originX = 0,
}: {
  start: number
  end: number
  offset?: number
  /** selection gap: the selected row sits gapSize lower, rows below it 2×gapSize (-1 = none) */
  gapAfter?: number
  gapSize?: number
  dim?: boolean
  originX?: number
}) {
  const edges = useGraphStore((s) => s.edges)
  const laneCount = useGraphStore((s) => s.laneLayout.laneCount)
  const ordered = useGraphStore((s) => s.ordered)
  const anim = useGraphStore((s) => s.anim)
  // layer placement under the gaps: uniformly shifted when the gaps are above
  // the window, taller when a gap falls inside it
  const gOf = (i: number) => (gapAfter < 0 || gapSize <= 0 || i < gapAfter ? 0 : i === gapAfter ? gapSize : 2 * gapSize)
  const shift = gOf(start)
  const extra = gOf(end) - gOf(start)

  const paths = useMemo(() => {
    if (end <= start) return null
    const out: string[] = []
    const colors: string[] = []
    const oldOut: string[] = []
    const oldColors: string[] = []
    const newOut: string[] = []
    const newColors: string[] = []
    const animLanes = anim?.lanes
    for (const e of edges) {
      // draw edges that intersect the visible slice (with a 1-row margin)
      const min = Math.min(e.fromIdx, e.toIdx === -1 ? e.fromIdx + 1 : e.toIdx)
      const max = Math.max(e.fromIdx, e.toIdx === -1 ? e.fromIdx + 1 : e.toIdx)
      if (max < start - 1 || min > end) continue

      let fromLane = e.fromLane
      let toLane = e.toLane
      let moved = false
      const fromSha = ordered[e.fromIdx]?.sha
      const toSha = e.toIdx >= 0 ? ordered[e.toIdx]?.sha : undefined
      if (animLanes) {
        const oldFrom = fromSha != null ? animLanes.get(fromSha) : undefined
        const oldTo = toSha != null ? animLanes.get(toSha) : undefined
        moved = (oldFrom != null && oldFrom !== e.fromLane) || (oldTo != null && oldTo !== e.toLane)
      }

      const y1 = e.fromIdx * ROW_H + ROW_H / 2 - start * ROW_H + (gOf(e.fromIdx) - shift)
      const dang = e.dangling
      const y2 = e.toIdx >= 0 ? e.toIdx * ROW_H + ROW_H / 2 - start * ROW_H + (gOf(e.toIdx) - shift) : y1 + ROW_H / 2

      if (moved && animLanes) {
        // cross-fade pair: OLD lane geometry fading out, NEW fading in
        const ofl = fromSha != null ? (animLanes.get(fromSha) ?? fromLane) : fromLane
        const otl = toSha != null ? (animLanes.get(toSha) ?? toLane) : toLane
        const ox1 = laneX(ofl)
        const ox2 = dang ? ox1 : laneX(otl)
        oldOut.push(
          dang
            ? `M ${ox1} ${y1} L ${ox1} ${y1 + ROW_H / 2}`
            : ox1 === ox2
              ? `M ${ox1} ${y1} L ${ox1} ${y2}`
              : `M ${ox1} ${y1} C ${ox1} ${(y1 + y2) / 2}, ${ox2} ${(y1 + y2) / 2}, ${ox2} ${y2}`,
        )
        oldColors.push(laneColor(ofl))
        const x1 = laneX(fromLane)
        const x2 = dang ? x1 : laneX(toLane)
        newOut.push(
          dang
            ? `M ${x1} ${y1} L ${x1} ${y1 + ROW_H / 2}`
            : x1 === x2
              ? `M ${x1} ${y1} L ${x1} ${y2}`
              : `M ${x1} ${y1} C ${x1} ${(y1 + y2) / 2}, ${x2} ${(y1 + y2) / 2}, ${x2} ${y2}`,
        )
        newColors.push(laneColor(fromLane))
        continue
      }

      const x1 = laneX(fromLane)
      if (dang) {
        out.push(`M ${x1} ${y1} L ${x1} ${y1 + ROW_H / 2}`)
        colors.push(laneColor(fromLane))
        continue
      }
      const x2 = laneX(toLane)
      if (x1 === x2) {
        out.push(`M ${x1} ${y1} L ${x1} ${y2}`)
      } else {
        const mid = (y1 + y2) / 2
        out.push(`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`)
      }
      // an edge belongs to the branch it comes from — the child commit's lane
      // color, so a branch line keeps its own hue all the way to its base
      colors.push(laneColor(fromLane))
    }
    return { out, colors, oldOut, oldColors, newOut, newColors }
  }, [edges, ordered, anim, start, end, gapAfter, gapSize])

  const width = Math.max(120, laneX(laneCount) + 20 + originX)
  const layerStyle = (extraOpacity: number) =>
    ({
      top: start * ROW_H + offset + shift,
      left: originX,
      width,
      height: (end - start) * ROW_H + extra,
      opacity: (dim ? 0.25 : 1) * extraOpacity,
      transition: 'left 150ms, opacity 150ms',
    }) as const

  if (!paths || (paths.out.length === 0 && paths.newOut.length === 0)) {
    return (
      <svg className="pointer-events-none absolute" style={layerStyle(1)} width={120} height={(end - start) * ROW_H + extra}>
        <defs />
      </svg>
    )
  }

  return (
    <>
      {/* stable edges (never moved) — the always-on layer */}
      <svg className="pointer-events-none absolute" style={layerStyle(1)} data-testid="graph-edges">
        {paths.out.map((d, i) => (
          <path key={i} d={d} fill="none" stroke={paths.colors[i]} strokeWidth={STROKE_W} strokeLinecap="round" />
        ))}
      </svg>
      {/* lane-move cross-fade: old-lane edges fade OUT while the new-lane
          copies fade IN, in step with the rows' slide transition */}
      {anim && paths.oldOut.length > 0 && (
        <svg className="pointer-events-none absolute edge-out" style={layerStyle(1)} data-testid="graph-edges-old">
          {paths.oldOut.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={paths.oldColors[i]} strokeWidth={STROKE_W} strokeLinecap="round" />
          ))}
        </svg>
      )}
      {anim && paths.newOut.length > 0 && (
        <svg className="pointer-events-none absolute edge-in" style={layerStyle(1)} data-testid="graph-edges-new">
          {paths.newOut.map((d, i) => (
            <path key={i} d={d} fill="none" stroke={paths.newColors[i]} strokeWidth={STROKE_W} strokeLinecap="round" />
          ))}
        </svg>
      )}
    </>
  )
}

export type { EdgeSeg }

export default memo(GraphEdgesInner)
