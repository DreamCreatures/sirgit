import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { CommitRow, RefInfo } from '../../lib/types'
import type { SelectedRef } from '../../state/uiStore'
import { useGraphStore } from '../../state/graphStore'
import { useUiStore } from '../../state/uiStore'
import GraphRow from './GraphRow'
import GraphEdges, { laneColor } from './GraphEdges'

export const ROW_H = 56
// lane spacing: wide enough that a sibling lane's curve reaches the big HEAD
// node (r 15 + faint ring) steeply instead of slicing along its edge band
const LANE_W = 46
const LANE_GUTTER = 14
const OVERSCAN = 12

export function laneX(lane: number): number {
  return LANE_GUTTER + lane * LANE_W + LANE_W / 2
}

interface GraphViewProps {
  refBySha: Map<string, RefInfo[]>
  /** tag names known to be on the remote (ls-remote cache) — pushed-tag chips */
  remoteTags?: string[]
  /** the remote those tags came from — pushed-tag prefixes name the real remote */
  remoteTagRemote?: string | null
  headSha: string | null
  /** show the dashed prospective-commit node above HEAD (staged changes / in-flight merge-rebase) */
  nextCommit?: boolean
  /** hover preview: anchor the dashed node above this commit (the action's target) */
  ghostTarget?: string | null
  /** checked-out branch name — marks the one chip that says (HEAD) */
  currentBranch?: string
  /** the ref the user picked (highlights its chip; drives merge buttons upstream) */
  selectedRef?: SelectedRef | null
  /** override row clicks (squash targeting); default selects the node/ref */
  onNodeClick?: (sha: string, ref?: SelectedRef) => void
  /** double-clicking a non-current branch chip checks it out */
  onCheckout?: (name: string) => void
  /** floating actions rendered over the selected row */
  renderActions?: (sha: string) => ReactNode
  /** the armed ref (a selected branch/remote chip) — its rows grow target buttons */
  armedRef?: { name: string; tipSha: string; remote?: boolean } | null
  /** a row's action button was clicked (move/rebase/squash/merge/squash-merge) */
  onRowAction?: (action: 'move' | 'rebase' | 'squash' | 'merge' | 'squash-merge', sha: string, intoBranch?: string) => void
  /** drag a branch chip onto a row → move the branch to the row's commit */
  onMoveBranch?: (branch: string, targetSha: string) => void
  /** drag a LOCAL tag chip onto a row → move the tag there (pushed tags refuse) */
  onMoveTag?: (tag: string, targetSha: string) => void
}

/**
 * Virtualized commit graph: only visible rows exist in the DOM. Fixed row
 * height + absolute positioning = trivial windowing; the SVG edge layer is
 * also culled to the visible slice (ungit rendered every loaded node forever).
 */
export default function GraphView({
  refBySha,
  remoteTags,
  remoteTagRemote,
  headSha,
  nextCommit,
  ghostTarget,
  currentBranch,
  selectedRef,
  onNodeClick,
  onCheckout,
  renderActions,
  armedRef,
  onRowAction,
  onMoveBranch,
  onMoveTag,
}: GraphViewProps) {
  const detailsSha = useUiStore((s) => s.detailsSha)
  const ordered = useGraphStore((s) => s.ordered)
  const laneLayout = useGraphStore((s) => s.laneLayout)
  const loadOlder = useGraphStore((s) => s.loadOlder)
  const fetchingOlder = useGraphStore((s) => s.fetchingOlder)
  const exhausted = useGraphStore((s) => s.exhausted)
  const selectedSha = useUiStore((s) => s.selectedSha)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(600)
  const [viewportW, setViewportW] = useState(1200)
  const rafRef = useRef(0)

  const onScroll = useCallback(() => {
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      setScrollTop(scrollRef.current?.scrollTop ?? 0)
    })
  }, [])

  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      setViewportH(el.clientHeight)
      setViewportW(el.clientWidth)
    })
    ro.observe(el)
    setViewportH(el.clientHeight)
    setViewportW(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  // belt-and-suspenders: correct the cached size on every commit. The
  // ResizeObserver is the primary signal, but its update goes through the
  // scheduler and can land a commit late (notably in throttled background
  // tabs); any committed render re-reads clientWidth/Height for one syscall
  // and recenters immediately instead of staying one resize behind.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (el.clientWidth !== viewportW) setViewportW(el.clientWidth)
    if (el.clientHeight !== viewportH) setViewportH(el.clientHeight)
  })

  const totalRows = ordered.length
  // the "next commit" slot above HEAD is ALWAYS reserved — rows sit at a
  // constant offset, so showing/hiding the dashed ghost (hover previews!)
  // never shifts the map or flickers. Hover previews may anchor the ghost
  // above ANY commit (the action's target): row 0 uses the reserved slot,
  // deeper rows get a no-shift overlay in the row above.
  const ghostSha = ghostTarget ?? null
  const ghostIdx = ghostSha ? ordered.findIndex((r) => r.sha === ghostSha) : -1
  const ghostLane = ghostIdx >= 0 ? (laneLayout.lanes.get(ghostSha!) ?? -1) : -1
  const showGhost = ghostIdx >= 0 && ghostLane >= 0
  const ghostOffset = totalRows > 0 ? ROW_H : 0
  // --- selection gap: while a row's action popup is up, that row pushes
  // itself and everything below one ROW_H down — the bar floats in the
  // opened gap instead of over the row ABOVE, which is exactly the
  // move/drag target the selection exists to act on ("distance between
  // sibling nodes increases 100%", per the user). All index→y math goes
  // through rowTop so rows, edges, ghost, tether and previews agree. ---
  const popupActive =
    !!renderActions && selectedSha != null && detailsSha !== selectedSha && ordered.some((r) => r.sha === selectedSha)
  const selGapIdx = popupActive ? ordered.findIndex((r) => r.sha === selectedSha) : -1
  const rowTop = (i: number) => i * ROW_H + ghostOffset + (selGapIdx >= 0 && i >= selGapIdx ? ROW_H : 0)
  const ghostTop = ghostIdx <= 0 ? rowTop(0) - ROW_H : rowTop(ghostIdx - 1)
  const contentH = totalRows * ROW_H + ghostOffset + (selGapIdx >= 0 ? ROW_H : 0)
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  // +1 window row at the bottom when the gap shifts rows down out of the
  // uniform-height assumption
  const end = Math.min(totalRows, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN + (selGapIdx >= 0 ? 1 : 0))

  // tree layout centers the TRUNK itself (the checked-out branch's column),
  // not the whole lane band: merge-heavy repos accumulate hundreds of
  // right-stacked chains beyond the alternating fan, and centering that band
  // would push the trunk off-screen. Trunk at viewport middle = HEAD where
  // the eye rests, fan around it, overflow clipped right. 'left' mode never
  // centers.
  const laneMode = useGraphStore((s) => s.laneMode)
  const headIdx = headSha ? ordered.findIndex((r) => r.sha === headSha) : -1
  const headLane = headIdx >= 0 && headSha ? (laneLayout.lanes.get(headSha) ?? -1) : -1
  const trunkLane = headIdx >= 0 && headLane >= 0 ? headLane : undefined
  // left mode: the trunk hugs the panel edge, but its TAG chips hug the
  // trunk node's LEFT — without an inset a chip like ori/v0.1.6 starts at
  // negative x and clips ("...6"). 64px of padding buys ~100px of tag room;
  // tree mode centers the trunk, so its corridors already have space.
  const LEFT_TAG_PAD = 64
  const originX =
    laneMode === 'tree' && trunkLane != null
      ? Math.max(0, Math.floor(viewportW / 2) - laneX(trunkLane))
      : LEFT_TAG_PAD
  const showTether = headIdx >= 0 && headLane >= 0 && !ghostSha
  const headCenterY = rowTop(headIdx) + ROW_H / 2
  const tetherCx = originX + laneX(headLane)
  // two regimes: HEAD at/below the viewport top → circle clamps between the
  // reserved top slot and one row above HEAD (pinned to the viewport top
  // while scrolling, riding down to HEAD as it arrives); HEAD fully ABOVE
  // the viewport → circle pins at the viewport top with a "↑N" badge and no
  // guide line (HEAD is above it)
  const headAboveViewport = headCenterY < scrollTop + ROW_H / 2
  const tetherTop = headAboveViewport
    ? scrollTop + ROW_H / 2
    : Math.max(ROW_H / 2, Math.min(scrollTop + ROW_H / 2, headCenterY - ROW_H))
  const tetherRows = Math.max(0, Math.round(Math.abs(headCenterY - tetherTop) / ROW_H) - (headAboveViewport ? 0 : 1))

  const visibleRows = useMemo(() => ordered.slice(start, end), [ordered, start, end])

  // --- hover preview of a row action (ungit-style): the commit run between
  // the armed subject's tip and the hovered target (first-parent walk, the
  // same segment SquashModal lists) drives the overlay + spotlight ---
  const preview = useUiStore((s) => s.actionPreview)
  const rowsBySha = useGraphStore((s) => s.rowsBySha)
  const previewRun = useMemo(() => {
    if (!preview) return [] as string[]
    const out: string[] = []
    let cursor: string | undefined = preview.subjectTipSha
    while (cursor && cursor !== preview.targetSha && out.length < 200) {
      const row = rowsBySha.get(cursor)
      if (!row) break
      out.push(cursor)
      cursor = row.parents[0]
    }
    return out
  }, [preview, rowsBySha])
  // spotlight: rows outside the involved set fade while a preview is up
  const involved = useMemo(() => {
    const set = new Set<string>()
    if (preview) {
      set.add(preview.subjectTipSha)
      set.add(preview.targetSha)
      if (preview.op === 'rebase' || preview.op === 'squash' || preview.op === 'squash-merge') {
        for (const sha of previewRun) set.add(sha)
      }
    }
    return set
  }, [preview, previewRun])
  const spotlight = !!preview

  // infinite scroll: near the bottom, request the next disjoint page
  useEffect(() => {
    if (!exhausted && totalRows - end < 40) {
      void loadOlder()
    }
  }, [end, totalRows, exhausted, loadOlder])

  // post-checkout scroll: center the requested row once it exists. A branch
  // deeper than the loaded window drives the lazy load itself (big pages
  // while seeking) until the row arrives — or gives up at history's end.
  const scrollToSha = useUiStore((s) => s.scrollToSha)
  useEffect(() => {
    if (!scrollToSha) return
    const idx = ordered.findIndex((r) => r.sha === scrollToSha)
    if (idx < 0) {
      // deeper than the loaded window: drive the lazy load (big pages while
      // seeking) until the row arrives — or give up at history's end
      if (!exhausted) void loadOlder(1000)
      else useUiStore.getState().clearScrollTo()
      return
    }
    const el = scrollRef.current
    if (el) {
      const target = Math.max(0, rowTop(idx) - el.clientHeight / 2 + ROW_H / 2)
      el.scrollTo({ top: target, behavior: 'smooth' })
    }
    useUiStore.getState().clearScrollTo()
  }, [scrollToSha, ordered, ghostOffset, exhausted, loadOlder])

  return (
    <div
      ref={scrollRef}
      onScroll={onScroll}
      className="scroll-thin relative h-full overflow-y-auto overflow-x-hidden"
      data-testid="graph-scroll"
    >
      <div style={{ height: contentH, position: 'relative' }}>
        {/* prospective next commit: dashed node above its anchor commit (the
         *  action's target), dashed stem down to it. Row 0 uses the reserved
         *  top slot; deeper anchors overlay the row above — an opaque plate
         *  keeps the ring readable over the edge layer. Pure visibility, no
         *  layout shift either way. */}
        {showGhost && (
          <div
            className="pointer-events-none absolute"
            style={{
              top: ghostTop,
              left: originX,
              width: Math.max(120, laneX(laneLayout.laneCount) + 20 + originX),
              height: 2 * ROW_H,
            }}
            data-testid="ghost-commit"
          >
            <svg width="100%" height={2 * ROW_H}>
              {ghostIdx > 0 && <circle cx={laneX(ghostLane)} cy={ROW_H / 2} r={15} fill="#18181b" />}
              <circle
                cx={laneX(ghostLane)}
                cy={ROW_H / 2}
                r={10}
                fill="none"
                stroke={laneColor(ghostLane)}
                strokeWidth={2}
                strokeDasharray="3 3"
                opacity={0.65}
              />
              <line
                x1={laneX(ghostLane)}
                y1={ROW_H / 2 + 10}
                x2={laneX(ghostLane)}
                y2={1.5 * ROW_H}
                stroke={laneColor(ghostLane)}
                strokeWidth={2}
                strokeDasharray="2 5"
                opacity={0.45}
              />
            </svg>
          </div>
        )}
        <GraphEdges start={start} end={end} offset={ghostOffset} gapAfter={selGapIdx} dim={spotlight} originX={originX} />
        {visibleRows.map((row, i) => {
          const idx = start + i
          const rowLane = laneLayout.lanes.get(row.sha) ?? 0
          return (
            <RowWrapper
              key={row.sha}
              row={row}
              index={idx}
              topOffset={ghostOffset + (selGapIdx >= 0 && idx >= selGapIdx ? ROW_H : 0)}
              lane={rowLane}
              originX={originX}
              tagSide={
                laneMode === 'tree' && trunkLane != null && rowLane < trunkLane
                  ? 'right'
                  : 'left'
              }
              msgWithTags={laneMode === 'tree' && trunkLane != null}
              graphW={viewportW}
              refs={refBySha.get(row.sha)}
              remoteTags={remoteTags}
              remoteTagRemote={remoteTagRemote}
              isHead={headSha === row.sha}
              currentBranch={currentBranch}
              selectedRef={selectedRef}
              selected={selectedSha === row.sha}
              onSelect={(sha, ref) => (onNodeClick ? onNodeClick(sha, ref) : useUiStore.getState().select(sha, ref))}
              onCheckout={onCheckout}
              armedRef={armedRef}
              onRowAction={onRowAction}
              dimmed={spotlight && !involved.has(row.sha)}
              onMoveBranch={onMoveBranch}
              onMoveTag={onMoveTag}
            />
          )
        })}
        {preview && (
          <PreviewOverlay preview={preview} run={previewRun} ordered={ordered} lanes={laneLayout.lanes} rowTop={rowTop} originX={originX} />
        )}
        {/* HEAD tether paints above the rows so the guide line reads over
         * hover backgrounds — nothing else renders in HEAD's lane above the
         * trunk tip, so it never covers a node */}
        {showTether && (
          <div
            className="absolute left-0"
            style={{
              top: tetherTop - 24,
              width: Math.max(120, laneX(laneLayout.laneCount) + 40 + originX),
              height: Math.max(48, headCenterY - tetherTop + 48),
              pointerEvents: 'none',
            }}
            data-testid="head-tether"
          >
            <svg width="100%" height="100%">
              {/* dashed guide line from the circle down to HEAD's ring —
               * only when HEAD is below the circle (scrolled-past HEAD has
               * no line, the ↑N badge says it all) */}
              {headCenterY - tetherTop > 20 && (
                <line
                  x1={tetherCx}
                  y1={24}
                  x2={tetherCx}
                  y2={24 + (headCenterY - tetherTop) - 17}
                  stroke={laneColor(headLane)}
                  strokeWidth={2}
                  strokeDasharray="3 6"
                  opacity={0.55}
                />
              )}
              {nextCommit && <circle cx={tetherCx} cy={24} r={12} fill="#18181b" />}
              <circle
                cx={tetherCx}
                cy={24}
                r={nextCommit ? 10 : 6}
                fill="none"
                stroke={laneColor(headLane)}
                strokeWidth={2}
                strokeDasharray={nextCommit ? '3 3' : '2 4'}
                opacity={nextCommit ? 0.85 : 0.55}
              />
            </svg>
            {/* invisible round hit target over the circle — click jumps back */}
            <button
              className="absolute rounded-full"
              style={{ left: tetherCx - 16, top: 8, width: 32, height: 32, pointerEvents: 'auto' }}
              title={`${currentBranch ?? 'HEAD'} @ ${headSha!.slice(0, 7)} — click to jump to HEAD`}
              onClick={() => useUiStore.getState().requestScrollTo(headSha!)}
              data-testid="head-tether-button"
            />
            {headAboveViewport && tetherRows > 0 && (
              <button
                className="absolute cursor-pointer rounded-full border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[10px] tabular-nums text-zinc-400 hover:border-zinc-500 hover:text-zinc-200"
                style={{ left: tetherCx + 14, top: 16, pointerEvents: 'auto' }}
                title={`Jump to HEAD (${currentBranch ?? 'HEAD'} @ ${headSha!.slice(0, 7)})`}
                onClick={() => useUiStore.getState().requestScrollTo(headSha!)}
                data-testid="head-tether-badge"
              >
                ↑{tetherRows}
              </button>
            )}
          </div>
        )}
        {popupActive && selectedSha && (
          <ActionPopup
            key={selectedSha}
            sha={selectedSha}
            selectedRef={selectedRef}
            index={ordered.findIndex((r) => r.sha === selectedSha)}
            topOffset={ghostOffset}
            gapAbove={selGapIdx >= 0 ? ROW_H : 0}
            laneCount={laneLayout.laneCount}
            originX={originX}
            scrollRef={scrollRef}
            scrollTop={scrollTop}
            onDismiss={() => useUiStore.getState().select(null)}
          >
            {renderActions(selectedSha)}
          </ActionPopup>
        )}
        {!exhausted && fetchingOlder && (
          <div className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center">
            <span className="rounded-full bg-zinc-800/90 px-3 py-1 text-xs text-zinc-400">
              loading older commits…
            </span>
          </div>
        )}
        {exhausted && totalRows > 0 && (
          <div
            className="pointer-events-none absolute inset-x-0 flex justify-center pb-2"
            style={{ top: contentH - ROW_H }}
          >
            <span className="rounded-full border border-zinc-800 bg-zinc-900 px-3 py-1 text-xs text-zinc-600">
              beginning of history · {totalRows.toLocaleString()} commits loaded
            </span>
          </div>
        )}
        {totalRows === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-zinc-600">
            no commits (empty repository or unborn branch)
          </div>
        )}
      </div>
    </div>
  )
}

const RowWrapper = memo(function RowWrapper({
  row,
  index,
  topOffset,
  lane,
  originX,
  tagSide,
  msgWithTags,
  graphW,
  refs,
  remoteTags,
  remoteTagRemote,
  isHead,
  currentBranch,
  selectedRef,
  selected,
  onSelect,
  onCheckout,
  armedRef,
  onRowAction,
  dimmed,
  onMoveBranch,
  onMoveTag,
}: {
  row: CommitRow
  index: number
  /** extra top offset (the ghost next-commit row shifts everything down) */
  topOffset: number
  lane: number
  /** lane-band centering shift (tree layout) */
  originX: number
  /** which side of the node the tag chips (+ tree-mode message) hug — the trunk-facing side */
  tagSide?: 'left' | 'right'
  /** tree mode: subject/meta ride with the tags on the trunk-facing side */
  msgWithTags?: boolean
  /** scroll-container width — anchors the mirrored blocks */
  graphW?: number
  refs?: RefInfo[]
  remoteTags?: string[]
  remoteTagRemote?: string | null
  isHead: boolean
  currentBranch?: string
  selectedRef?: SelectedRef | null
  selected: boolean
  onSelect: (sha: string, ref?: SelectedRef) => void
  onCheckout?: (name: string) => void
  armedRef?: { name: string; tipSha: string; remote?: boolean } | null
  onRowAction?: (action: 'move' | 'rebase' | 'squash' | 'merge' | 'squash-merge', sha: string, intoBranch?: string) => void
  /** spotlight: the row is outside the preview's involved set */
  dimmed?: boolean
  onMoveBranch?: (branch: string, targetSha: string) => void
  onMoveTag?: (tag: string, targetSha: string) => void
}) {
  return (
    <div
      style={{ position: 'absolute', top: index * ROW_H + topOffset, left: 0, right: 0, height: ROW_H }}
      data-sha={row.sha}
      data-testid="graph-row"
    >
      <GraphRow
        row={row}
        lane={lane}
        originX={originX}
        tagSide={tagSide}
        msgWithTags={msgWithTags}
        graphW={graphW}
        refs={refs}
        remoteTags={remoteTags}
        remoteTagRemote={remoteTagRemote}
        isHead={isHead}
        currentBranch={currentBranch}
        selectedRef={selectedRef}
        selected={selected}
        onSelect={onSelect}
        onCheckout={onCheckout}
        armedRef={armedRef}
        onRowAction={onRowAction}
        dimmed={dimmed}
        onMoveBranch={onMoveBranch}
        onMoveTag={onMoveTag}
      />
    </div>
  )
})

const VIOLET = '#8b5cf6'
/** preview stack/rows cap — beyond this a "+N" chip replaces the tail */
const PREVIEW_CAP = 6

/**
 * Hover overlay for a row action button (ungit's per-operation preview):
 * - rebase — a stack of dashed circles above the target, one per replayed
 *   commit (the count and shape of the move), target ringed
 * - squash / squash-merge — violet rings around every commit that will be
 *   absorbed; squash also ghosts the would-be single commit above the target
 * - move — dashed ring on the target, solid ring on the armed tip
 * Everything renders pointer-events-none on top of the rows; the spotlight
 * (dimmed uninvolved rows) is applied by the rows themselves.
 */
function PreviewOverlay({
  preview,
  run,
  ordered,
  lanes,
  rowTop,
  originX,
}: {
  preview: { op: 'move' | 'rebase' | 'squash' | 'merge' | 'squash-merge'; targetSha: string; subjectTipSha: string; subjectBranch: string }
  run: string[]
  ordered: import('../../lib/types').CommitRow[]
  lanes: Map<string, number>
  /** row index → content y (includes the ghost offset and the selection gap) */
  rowTop: (i: number) => number
  /** lane-band centering shift (tree layout) — every x is laneX + originX */
  originX: number
}) {
  const idxOf = (sha: string) => ordered.findIndex((r) => r.sha === sha)
  const laneOf = (sha: string) => lanes.get(sha) ?? 0
  const colorOf = (sha: string) => laneColor(laneOf(sha))
  const lx = (lane: number) => originX + laneX(lane)
  /** centered-on-node dashed ring (r 16 covers the 8/10/15 node radii) */
  const Ring = ({ sha, stroke, dashed = true, opacity = 0.9 }: { sha: string; stroke: string; dashed?: boolean; opacity?: number }) => {
    const idx = idxOf(sha)
    if (idx < 0) return null
    return (
      <div
        className="pointer-events-none absolute"
        style={{ left: lx(laneOf(sha)) - 18, top: rowTop(idx) + (ROW_H - 36) / 2, width: 36, height: 36 }}
        data-testid="preview-ring"
      >
        <svg width={36} height={36}>
          <circle cx={18} cy={18} r={16} fill="none" stroke={stroke} strokeWidth={2} strokeDasharray={dashed ? '4 3' : undefined} opacity={opacity} />
        </svg>
      </div>
    )
  }

  const targetIdx = idxOf(preview.targetSha)
  if (targetIdx < 0) return null
  const targetLane = laneOf(preview.targetSha)
  const targetColor = laneColor(targetLane)

  // rebase: replayed-commit stack above the target (circles + stems)
  const stack = preview.op === 'rebase' ? run.slice(0, PREVIEW_CAP) : []
  const capped = preview.op === 'rebase' && run.length > PREVIEW_CAP

  // squash: the ghosted single replacement commit above the target
  const ghostIdx = preview.op === 'squash' ? targetIdx : -1
  const ghostTop = ghostIdx <= 0 ? rowTop(0) - ROW_H : rowTop(ghostIdx - 1)

  return (
    <>
      {preview.op === 'move' && (
        <>
          <Ring sha={preview.targetSha} stroke={targetColor} />
          <Ring sha={preview.subjectTipSha} stroke={colorOf(preview.subjectTipSha)} dashed={false} opacity={0.6} />
        </>
      )}

      {preview.op === 'rebase' && (
        <>
          <Ring sha={preview.targetSha} stroke={targetColor} />
          {stack.map((sha, i) => {
            // circle i sits i rows above the target; clamp at the reserved top slot
            const row = Math.max(0, targetIdx - (i + 1))
            const cx = lx(targetLane)
            const cy = rowTop(row) + ROW_H / 2
            return (
              <div key={sha}>
                <div
                  className="pointer-events-none absolute"
                  style={{ left: cx - 14, top: cy - 14, width: 28, height: 28 }}
                  data-testid="preview-stack"
                >
                  <svg width={28} height={28}>
                    <circle cx={14} cy={14} r={7} fill="none" stroke={targetColor} strokeWidth={2} strokeDasharray="3 3" opacity={0.55} />
                  </svg>
                </div>
                {i < stack.length - 1 && (
                  <svg className="pointer-events-none absolute left-0" style={{ top: 0 }} width={Math.max(120, lx(lanes.size) + 20)} height={cy + ROW_H}>
                    <line x1={cx} y1={cy + 7} x2={cx} y2={cy + ROW_H - 7} stroke={targetColor} strokeWidth={1.5} strokeDasharray="2 5" opacity={0.4} />
                  </svg>
                )}
              </div>
            )
          })}
          {capped && (
            <div
              className="pointer-events-none absolute rounded-full border border-violet-500/40 bg-violet-500/10 px-1.5 text-[10px] text-violet-300"
              style={{ left: lx(targetLane) + 14, top: rowTop(Math.max(0, targetIdx - PREVIEW_CAP)) + ROW_H / 2 - 8 }}
            >
              +{run.length - PREVIEW_CAP} more
            </div>
          )}
        </>
      )}

      {(preview.op === 'squash' || preview.op === 'squash-merge') &&
        run.map((sha) => <Ring key={sha} sha={sha} stroke={VIOLET} />)}

      {preview.op === 'squash' && (
        <div
          className="pointer-events-none absolute left-0"
          style={{ top: ghostTop, width: Math.max(120, lx(lanes.size) + 20), height: 2 * ROW_H }}
          data-testid="preview-ghost"
        >
          <svg width="100%" height={2 * ROW_H}>
            {ghostIdx > 0 && <circle cx={lx(targetLane)} cy={ROW_H / 2} r={15} fill="#18181b" />}
            <circle cx={lx(targetLane)} cy={ROW_H / 2} r={10} fill="none" stroke={VIOLET} strokeWidth={2} strokeDasharray="3 3" opacity={0.8} />
            <line x1={lx(targetLane)} y1={ROW_H / 2 + 10} x2={lx(targetLane)} y2={1.5 * ROW_H} stroke={VIOLET} strokeWidth={2} strokeDasharray="2 5" opacity={0.5} />
          </svg>
        </div>
      )}

      {(preview.op === 'merge' || preview.op === 'squash-merge') && (
        <Ring sha={preview.subjectTipSha} stroke="#34d399" dashed={false} opacity={0.5} />
      )}

      {/* merge: a merge commit has TWO parents — the hover ghost already
       * sits above the into-row (data-ghost-preview); draw the second
       * parent's edge: dashed line from the armed branch's tip up to the
       * ghost, so the preview reads as a real merge */}
      {preview.op === 'merge' &&
        (() => {
          const intoIdx = idxOf(preview.targetSha)
          const tipIdx = idxOf(preview.subjectTipSha)
          if (intoIdx < 0 || tipIdx < 0) return null
          // ghost circle center — mirrors GraphView's ghost anchoring
          const gx = lx(laneOf(preview.targetSha))
          const gy = (intoIdx <= 0 ? rowTop(0) - ROW_H : rowTop(intoIdx - 1)) + ROW_H / 2
          const tx = lx(laneOf(preview.subjectTipSha))
          const ty = rowTop(tipIdx) + ROW_H / 2
          const left = Math.min(gx, tx) - 24
          const top = Math.min(gy, ty) - 24
          return (
            <svg
              className="pointer-events-none absolute"
              style={{ left, top }}
              width={Math.abs(gx - tx) + 48}
              height={Math.abs(gy - ty) + 48}
              data-testid="preview-merge-line"
            >
              <line
                x1={gx - left}
                y1={gy - top}
                x2={tx - left}
                y2={ty - top}
                stroke="#34d399"
                strokeWidth={2}
                strokeDasharray="4 4"
                opacity={0.55}
              />
            </svg>
          )
        })()}
    </>
  )
}


/**
 * Floating action popup rendered on the row ABOVE the selected one, its left
 * edge aligned with the selected chip — the grown action set no longer fits
 * beside a 3rd/4th chip, and spanning the row above keeps the selected row
 * and its siblings fully clickable. Flips BELOW the row only when there is
 * no room above (selected row at the viewport top). Rendered through a
 * portal at fixed viewport coordinates so no sibling panel (drawer, sidebar)
 * can clip it; re-anchors on scroll, clamps inside the viewport, and
 * dismisses on outside click.
 */
function ActionPopup({
  sha,
  selectedRef,
  index,
  topOffset,
  gapAbove,
  laneCount,
  originX,
  scrollRef,
  scrollTop,
  onDismiss,
  children,
}: {
  sha: string
  /** the picked ref (chip click) — the bar anchors next to THAT chip; null = node pick */
  selectedRef?: { kind: 'branch' | 'tag' | 'remote-branch'; name: string } | null
  index: number
  /** the ghost next-commit row shifts row positions down */
  topOffset: number
  /** the selection gap opened above this row — the bar floats inside it */
  gapAbove: number
  laneCount: number
  /** lane-band centering shift (tree layout) */
  originX: number
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollTop: number
  onDismiss: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [popupW, setPopupW] = useState(0)
  const [popupH, setPopupH] = useState(44)

  // measure natural size before showing: placement right-aligns using the
  // real single-row width, so the bar must never flash in the wrong spot
  // (popupW=0 renders one hidden frame)
  useLayoutEffect(() => {
    if (ref.current) {
      setPopupW(ref.current.offsetWidth)
      setPopupH(ref.current.offsetHeight)
    }
  })

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (ref.current?.contains(t)) return
      // node / ref-chip clicks re-anchor the popup via selection — not a dismissal
      if (t.closest('[data-testid="graph-node"]') || t.closest('[data-testid="graph-ref-chip"]')) return
      // the per-row action buttons ([merge]/[squash merge]/[rebase]/[squash]/
      // [← move]) act on this selection — keep it alive. Without this, the
      // mousedown disarms the selection and unmounts the button mid-click,
      // so the click never lands ("doesn't really click on")
      if (t.closest('[data-action-preview]')) return
      // clicks inside the details drawer (file list, diffs) must not dismiss anything
      if (t.closest('[data-testid="commit-drawer"]')) return
      // same for the in-app confirm/prompt dialog driving an action on this selection
      if (t.closest('[data-testid="app-dialog"]')) return
      onDismiss()
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [onDismiss])

  const container = scrollRef.current
  if (!container) return null
  const rect = container.getBoundingClientRect()
  const rowTopY = rect.top + index * ROW_H + topOffset + gapAbove - scrollTop
  // rest the bar on the row ABOVE the selected one (6px gap); flip below
  // when that would leave the container (selected row at the viewport top)
  let top = rowTopY - popupH - 6
  if (top < rect.top + 4) {
    top = Math.min(rowTopY + ROW_H + 6, rect.bottom - popupH - 4)
    top = Math.max(top, rect.top + 4)
  }

  // horizontal: left edge aligned with the SELECTED chip (a tag pick aligns
  // to the tag, even on the node's far side; a node pick aligns to the
  // row's last chip). The bar spans the row above, so it may use the full
  // container width: when the chip sits close to the right edge and the
  // natural single-row width would run past it, RIGHT-ALIGN the bar —
  // shifting left beats wrapping into a two-row block that towers over
  // neighbouring rows. Wrapping stays only as the fallback when the whole
  // container is narrower than the bar.
  const laneXBased = rect.left + originX + Math.max(60, laneX(Math.min(laneCount, 6)) + 8)
  const rowEl = container.querySelector(`[data-sha="${sha}"]`)
  const anchorEl = (
    (selectedRef && rowEl?.querySelector(`[data-ref="${selectedRef.kind}:${selectedRef.name}"]`)) ||
    (rowEl ? ([...rowEl.querySelectorAll('[data-testid="graph-ref-chip"]')].pop() as HTMLElement | undefined) : undefined)
  )?.getBoundingClientRect?.() ?? null
  let left = Math.max(rect.left + 8, anchorEl ? anchorEl.left : laneXBased)
  if (left + popupW > rect.right - 8) left = Math.max(rect.left + 8, rect.right - 8 - popupW)
  // maxWidth is PLACEMENT-INDEPENDENT (full container width): the measured
  // popupW is then always the natural single-row width. Deriving it from
  // `left` instead would feedback-loop — an anchor near the right edge (or a
  // stale popupW kept across same-row re-selections, since the popup is
  // keyed by sha) clamps the width, the wrap bakes into the measurement,
  // and the bar can never unwrap.
  const maxW = rect.width - 16

  return createPortal(
    <div
      ref={ref}
      className="fixed z-40 flex flex-wrap items-center gap-1.5 rounded-lg border border-zinc-600 bg-zinc-900 px-2 py-1.5 shadow-2xl"
      style={{ top, left, maxWidth: Math.max(200, maxW), visibility: popupW ? 'visible' : 'hidden' }}
      data-testid="selection-popup"
    >
      {children}
    </div>,
    document.body,
  )
}
