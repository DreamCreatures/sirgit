import { memo, useMemo } from 'react'
import { useGraphStore } from '../../state/graphStore'
import { ROW_H, laneX } from './GraphView'

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
 */
function GraphEdgesInner({
  start,
  end,
  offset = 0,
  dim = false,
  originX = 0,
}: {
  start: number
  end: number
  offset?: number
  dim?: boolean
  originX?: number
}) {
  const edges = useGraphStore((s) => s.edges)
  const laneCount = useGraphStore((s) => s.laneLayout.laneCount)

  const paths = useMemo(() => {
    if (end <= start) return null
    const out: string[] = []
    const colors: string[] = []
    for (const e of edges) {
      // draw edges that intersect the visible slice (with a 1-row margin)
      const min = Math.min(e.fromIdx, e.toIdx === -1 ? e.fromIdx + 1 : e.toIdx)
      const max = Math.max(e.fromIdx, e.toIdx === -1 ? e.fromIdx + 1 : e.toIdx)
      if (max < start - 1 || min > end) continue

      const x1 = laneX(e.fromLane)
      const y1 = e.fromIdx * ROW_H + ROW_H / 2 - start * ROW_H
      if (e.dangling) {
        out.push(`M ${x1} ${y1} L ${x1} ${y1 + ROW_H / 2}`)
        colors.push(laneColor(e.fromLane))
        continue
      }
      const x2 = laneX(e.toLane)
      const y2 = e.toIdx * ROW_H + ROW_H / 2 - start * ROW_H
      if (x1 === x2) {
        out.push(`M ${x1} ${y1} L ${x1} ${y2}`)
      } else {
        const mid = (y1 + y2) / 2
        out.push(`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`)
      }
      // an edge belongs to the branch it comes from — the child commit's lane
      // color, so a branch line keeps its own hue all the way to its base
      colors.push(laneColor(e.fromLane))
    }
    return { out, colors }
  }, [edges, start, end])

  if (!paths || paths.out.length === 0) {
    return (
      <svg
        className="pointer-events-none absolute"
        style={{ top: start * ROW_H + offset, left: originX, opacity: dim ? 0.25 : 1, transition: 'left 150ms, opacity 150ms' }}
        width={120}
        height={(end - start) * ROW_H}
      >
        <defs />
      </svg>
    )
  }

  const width = Math.max(120, laneX(laneCount) + 20 + originX)

  return (
    <svg
      className="pointer-events-none absolute"
      style={{ top: start * ROW_H + offset, left: originX, width, height: (end - start) * ROW_H, opacity: dim ? 0.25 : 1, transition: 'left 150ms, opacity 150ms' }}
      data-testid="graph-edges"
    >
      {paths.out.map((d, i) => (
        <path key={i} d={d} fill="none" stroke={paths.colors[i]} strokeWidth={STROKE_W} strokeLinecap="round" />
      ))}
    </svg>
  )
}

export default memo(GraphEdgesInner)
