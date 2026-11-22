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

  const totalRows = ordered.length
  // the "next commit" slot above HEAD is ALWAYS reserved — rows sit at a
  // constant offset, so showing/hiding the dashed ghost (hover previews!)
  // never shifts the map or flickers. Hover previews may anchor the ghost
  // above ANY commit (the action's target): row 0 uses the reserved slot,
  // deeper rows get a no-shift overlay in the row above.
  const ghostSha = ghostTarget ?? (nextCommit ? headSha : null)
  const ghostIdx = ghostSha ? ordered.findIndex((r) => r.sha === ghostSha) : -1
  const ghostLane = ghostIdx >= 0 ? (laneLayout.lanes.get(ghostSha!) ?? -1) : -1
  const showGhost = ghostIdx >= 0 && ghostLane >= 0
  const ghostOffset = totalRows > 0 ? ROW_H : 0
  const ghostTop = ghostIdx <= 0 ? 0 : (ghostIdx - 1) * ROW_H + ghostOffset
  const contentH = totalRows * ROW_H + ghostOffset
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(totalRows, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN)

  const visibleRows = useMemo(() => ordered.slice(start, end), [ordered, start, end])

  // tree layout: center the lane band when the viewport has spare width (e.g.
  // collapsed refs panel) — the trunk already sits mid-band thanks to the
  // alternating lane assignment, so the checked-out branch lands near the
  // viewport middle instead of hugging the left edge. The band spans the
  // OUTERMOST NODE EDGES (± the biggest node radius, HEAD's 15), not lane
  // centers, so centering is exact. Narrow viewport → 0 → left-anchored
  // exactly as before.
  const minEdge = LANE_GUTTER + LANE_W / 2 - 15
  const maxEdge = laneX(laneLayout.laneCount - 1) + 15
  const bandW = maxEdge - minEdge
  const originX = Math.max(0, Math.floor((viewportW - bandW) / 2) - minEdge)

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
      const target = Math.max(0, idx * ROW_H + ghostOffset - el.clientHeight / 2 + ROW_H / 2)
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
        <GraphEdges start={start} end={end} offset={ghostOffset} dim={spotlight} originX={originX} />
        {visibleRows.map((row, i) => {
          const idx = start + i
          return (
            <RowWrapper
              key={row.sha}
              row={row}
              index={idx}
              topOffset={ghostOffset}
              lane={laneLayout.lanes.get(row.sha) ?? 0}
              originX={originX}
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
          <PreviewOverlay preview={preview} run={previewRun} ordered={ordered} lanes={laneLayout.lanes} topOffset={ghostOffset} originX={originX} />
        )}
        {renderActions && selectedSha && detailsSha !== selectedSha && ordered.some((r) => r.sha === selectedSha) && (
          <ActionPopup
            key={selectedSha}
            sha={selectedSha}
            index={ordered.findIndex((r) => r.sha === selectedSha)}
            topOffset={ghostOffset}
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
  topOffset,
  originX,
}: {
  preview: { op: 'move' | 'rebase' | 'squash' | 'merge' | 'squash-merge'; targetSha: string; subjectTipSha: string; subjectBranch: string }
  run: string[]
  ordered: import('../../lib/types').CommitRow[]
  lanes: Map<string, number>
  topOffset: number
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
        style={{ left: lx(laneOf(sha)) - 18, top: idx * ROW_H + topOffset + (ROW_H - 36) / 2, width: 36, height: 36 }}
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
  const ghostTop = ghostIdx <= 0 ? 0 : (ghostIdx - 1) * ROW_H + topOffset

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
            const cy = row * ROW_H + topOffset + ROW_H / 2
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
              style={{ left: lx(targetLane) + 14, top: Math.max(0, targetIdx - PREVIEW_CAP) * ROW_H + topOffset + ROW_H / 2 - 8 }}
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
          const gy = (intoIdx <= 0 ? 0 : (intoIdx - 1) * ROW_H + topOffset) + ROW_H / 2
          const tx = lx(laneOf(preview.subjectTipSha))
          const ty = tipIdx * ROW_H + topOffset + ROW_H / 2
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
 * Floating action popup rendered directly ON the selected row (vertical
 * center) so sibling commits above/below stay selectable. Horizontally it
 * sits just right of the selected branch chip — covering the branch only as
 * a fallback when the chip is too far right to fit. Rendered through a
 * portal at fixed viewport coordinates so no sibling panel (drawer, sidebar)
 * can clip it; re-anchors on scroll, clamps inside the viewport, and
 * dismisses on outside click.
 */
function ActionPopup({
  sha,
  index,
  topOffset,
  laneCount,
  originX,
  scrollRef,
  scrollTop,
  onDismiss,
  children,
}: {
  sha: string
  index: number
  /** the ghost next-commit row shifts row positions down */
  topOffset: number
  laneCount: number
  /** lane-band centering shift (tree layout) */
  originX: number
  scrollRef: React.RefObject<HTMLDivElement | null>
  scrollTop: number
  onDismiss: () => void
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [popupH, setPopupH] = useState(44)

  // measure real height (button rows can wrap) for exact centering + clamping
  useLayoutEffect(() => {
    if (ref.current) setPopupH(ref.current.offsetHeight)
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
  const rowCenterY = rect.top + index * ROW_H + topOffset - scrollTop + ROW_H / 2
  let top = rowCenterY - popupH / 2
  top = Math.min(Math.max(top, rect.top + 4), rect.bottom - popupH - 4)

  // horizontal: just right of the selected branch chip; when that would
  // overflow the container, overlay the branch name; last resort = node side
  const laneXBased = rect.left + originX + Math.max(60, laneX(Math.min(laneCount, 6)) + 8)
  const rowEl = container.querySelector(`[data-sha="${sha}"]`)
  const chips = rowEl ? [...rowEl.querySelectorAll('[data-testid="graph-ref-chip"]')] : []
  const lastChip = chips.length ? chips[chips.length - 1].getBoundingClientRect() : null
  let left = lastChip ? lastChip.right + 8 : laneXBased
  let maxW = rect.right - left - 8
  if (maxW < 300 && lastChip) {
    left = lastChip.left
    maxW = rect.right - left - 8
  }
  if (maxW < 220) {
    left = laneXBased
    maxW = window.innerWidth - left - (window.innerWidth - rect.right) - 12
  }

  return createPortal(
    <div
      ref={ref}
      className="fixed z-40 flex items-center gap-1.5 rounded-lg border border-zinc-600 bg-zinc-900 px-2 py-1.5 shadow-2xl"
      style={{ top, left, maxWidth: Math.max(220, maxW) }}
      data-testid="selection-popup"
    >
      {children}
    </div>,
    document.body,
  )
}
