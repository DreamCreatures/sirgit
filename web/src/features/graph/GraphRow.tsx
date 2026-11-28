import { memo, useState, type DragEvent, type ReactNode } from 'react'
import { GitBranch, Tag } from 'lucide-react'
import type { CommitRow, RefInfo } from '../../lib/types'
import { relTime } from '../../lib/time'
import { abbrevRemote } from '../../lib/remoteLabel'
import { containsCommit } from '../../lib/dag'
import { useUiStore } from '../../state/uiStore'
import { ROW_H, laneX } from './GraphView'
import { laneColor } from './GraphEdges'

interface GraphRowProps {
  row: CommitRow
  lane: number
  /** horizontal shift of the lane band (tree layout centers it in the viewport) */
  originX?: number
  /** which side of the node the TAG chips hug — the trunk-facing side (left mode: always left) */
  tagSide?: 'left' | 'right'
  /** tree mode: subject/meta ride with the tags on the trunk-facing side; left mode keeps the classic right flow */
  msgWithTags?: boolean
  /** scroll-container width — anchors the mirrored blocks */
  graphW?: number
  refs?: RefInfo[]
  /** tag names known to be on the remote — pushed tags render as <remote-abbrev>/<tag> */
  remoteTags?: string[]
  /** the remote the remoteTags cache came from (raw name — the pushed-tag prefix) */
  remoteTagRemote?: string | null
  isHead: boolean
  /** the checked-out branch — its chip is the one that turns red */
  currentBranch?: string
  selected: boolean
  /** the ref the user picked (branch/tag chip) — highlights that chip */
  selectedRef?: { kind: 'branch' | 'tag' | 'remote-branch'; name: string } | null
  /** clicking the node selects the commit; clicking a chip selects that ref */
  onSelect: (sha: string, ref?: { kind: 'branch' | 'tag' | 'remote-branch'; name: string }) => void
  /** double-clicking a non-current branch chip checks it out */
  onCheckout?: (name: string) => void
  /**
   * The armed ref (a selected branch/remote chip) — selecting it IS arming:
   * rows become potential targets, but their buttons stay hidden until the
   * row's commit node is hovered (ungit's drop-action model, decluttered —
   * one row's actions at a time instead of a button wall on every row).
   */
  armedRef?: { name: string; tipSha: string; remote?: boolean } | null
  /** a row's action button was clicked — sha is this row's commit */
  onRowAction?: (action: 'move' | 'rebase' | 'squash' | 'merge' | 'squash-merge', sha: string, intoBranch?: string) => void
  /** spotlight: the row is outside the hover preview's involved set */
  dimmed?: boolean
  /** drag a local branch chip onto this row → move the branch here */
  onMoveBranch?: (branch: string, targetSha: string) => void
  /** drag a LOCAL tag chip onto this row → move the tag here (pushed tags are not draggable) */
  onMoveTag?: (tag: string, targetSha: string) => void
}

const MAX_CHIPS = 4 // branch chips shown before the +N chip (tags are uncapped — group A)
/** row subjects cap at the classic 72-col guideline — beyond that one title
 *  eclipses the refs and reads as noise; hovering the subject shows it all */
const SUBJECT_CAP = 72
const clipSubject = (s: string) => (s.length > SUBJECT_CAP ? `${s.slice(0, SUBJECT_CAP - 1).trimEnd()}…` : s)
const DRAG_TYPE = 'application/x-sirgit-move'
/** symmetric svg padding around the node circle — keeps the circle centered
 *  exactly on the lane axis so edges run through its center (the HEAD ring
 *  at r+4 must fit inside too) */
const NODE_PAD = 8

/**
 * One virtualized commit row: lane dot + refs + subject + meta.
 * Memoized — re-renders only when its own inputs change.
 * Only the node and the ref chips are clickable — the row body is inert,
 * so reading/sweeping the history never pops the action bar. Selecting a
 * branch/remote chip ARMS it, but the target buttons stay hidden: hovering
 * a row's commit node reveals just that row's actions ([rebase][squash]
 * while the current branch is armed, [move to] always, [merge][squash
 * merge] on the receiving branch's row) and the row's own branch chips
 * step aside while the buttons show; leaving the row restores both.
 * Local branch chips can still be dragged onto a row to move the branch.
 */
function GraphRowInner({
  row,
  lane,
  originX = 0,
  tagSide = 'left',
  msgWithTags = false,
  graphW,
  refs,
  remoteTags,
  remoteTagRemote,
  isHead,
  currentBranch,
  selected,
  selectedRef,
  onSelect,
  onCheckout,
  armedRef,
  onRowAction,
  dimmed,
  onMoveBranch,
  onMoveTag,
}: GraphRowProps) {
  const color = laneColor(lane)
  const x = originX + laneX(lane)
  // compact mode fades every subject except HEAD's; hovering the row's commit
  // NODE reveals it (row-hover pops nothing)
  const subjectCompact = useUiStore((s) => s.subjectCompact)
  const [nodeHovered, setNodeHovered] = useState(false)
  // armed-row action buttons are hover-gated: hovering the commit NODE shows
  // them, leaving the ROW hides them — the node→chip→button corridor stays
  // inside the row, so nothing flickers mid-transit to a click
  const [actionsVisible, setActionsVisible] = useState(false)
  // compact mode also removes the author/time/sha meta on every row — no
  // reveal at all (the node-hover peek shows the commit message ONLY).
  // display:none, not opacity: hidden-but-present meta would eat the corridor
  // between the message and the node on mirrored-left rows, pushing the
  // revealed message far from the node
  const metaHide = subjectCompact ? ' hidden' : ''
  const subjectHide = subjectCompact && !isHead
    ? nodeHovered
      ? ' opacity-100 transition-opacity duration-100'
      : ' opacity-0 transition-opacity duration-100'
    : ''
  // family-tree labeling: [tag chips + message] hug the node on the
  // TRUNK-FACING side; [branch chips + action buttons] take the away side —
  // tree mode does this on every row (the trunk reads as a right-side row);
  // left mode mirrors only the tags, branches + message keep the right flow
  // the working branch's tip (HEAD) reads at 50% bigger than branch nodes;
  // plain commits stay smallest
  const r = isHead ? 15 : refs?.some((rf) => rf.type === 'branch') ? 10 : 8
  const chips = refs ?? []
  // Chip order: [tags…][branch, its remote twin, branch, …][orphan remotes].
  // Pushed-tag truth: the server's ls-remote cache (refreshed after every
  // fetch/push/pull) once it has actually run — the cache reports its remote
  // even when the remote has NO tags, and an empty list then truthfully
  // means "nothing pushed". Only before any network op ran through sirgit
  // (no cached remote) fall back to the row heuristic — every chip on a row
  // points at the SAME commit, so a tag riding a row that carries a remote
  // chip is on the remote. Either way only the pushed form is shown (never
  // both, unlike branches which keep local + remote visible).
  const cacheFetched = remoteTagRemote != null
  const rowHasRemote = chips.some((rf) => rf.type === 'remote-branch')
  const tagPushed = (name: string) => (cacheFetched ? remoteTags!.includes(name) : rowHasRemote)
  // the remote a pushed tag's prefix names: the ls-remote cache's remote
  // when it's authoritative, else the remote chip riding the row
  const rowRemoteName = chips.find((rf) => rf.type === 'remote-branch')?.name.split('/')[0]
  const tagRemoteName = cacheFetched ? (remoteTagRemote ?? rowRemoteName) : rowRemoteName
  const tagPrefix = abbrevRemote(tagRemoteName ?? 'origin')
  const tags = chips.filter((rf) => rf.type === 'tag')
  const ordered: typeof chips = []
  const paired = new Set<string>()
  // the checked-out branch LEADS the chip line (HEAD priority — DOM order is
  // nearest-the-node on both mirror sides), the rest keep ref order
  const branchChips = chips.filter((rf) => rf.type === 'branch')
  if (currentBranch) {
    branchChips.sort((a, b) => Number(b.name === currentBranch) - Number(a.name === currentBranch))
  }
  for (const rf of branchChips) {
    ordered.push(rf)
    paired.add(rf.name)
    // pair any <remote>/<name> twin, not just origin's — repos with other
    // remotes keep their local + remote chips adjacent too
    const twin = chips.find((o) => o.type === 'remote-branch' && o.name.endsWith(`/${rf.name}`))
    if (twin) {
      ordered.push(twin)
      paired.add(twin.name)
    }
  }
  for (const rf of chips) {
    if (rf.type !== 'tag' && !paired.has(rf.name)) ordered.push(rf)
  }
  // +N expands the branch line inline (tags are never capped)
  const [chipsExpanded, setChipsExpanded] = useState(false)
  const shownBranches = chipsExpanded ? ordered : ordered.slice(0, MAX_CHIPS)
  const overflow = ordered.length - shownBranches.length
  const [dragOver, setDragOver] = useState(false)

  // --- armed-ref action matrix (ungit's model: the subject is already picked,
  // each row offers exactly the actions that make sense THERE) ---
  const armed = armedRef ?? null
  const armedIsCurrent = !!armed && !armed.remote && currentBranch === armed.name
  const otherRow = !!armed && row.sha !== armed.tipSha
  // move: any armed ref (local branch or origin/x → push), any other row
  const showMove = !!armed && !!onRowAction && otherRow
  // rebase rewrites the CHECKED-OUT branch — only while it is armed (ungit);
  // squash works on ANY armed local branch: non-current branches take the
  // conflict-free commit-tree ref-surgery path server-side
  const showRebase = armedIsCurrent && !!onRowAction && otherRow
  const showSquash = !!armed && !armed.remote && !!onRowAction && otherRow
  // merging requires one of the two branches to be the checked-out one:
  // - HEAD armed → [merge]/[squash merge] on ALL other branch rows (they receive HEAD)
  // - non-HEAD armed → only the HEAD row shows the buttons (it receives the armed branch)
  const armedBranch = armed && !armed.remote ? armed.name : null
  const mergeIntoBranch = (() => {
    if (!armedBranch || !onRowAction || !currentBranch) return undefined
    const rowBranches = chips.filter((rf) => rf.type === 'branch').map((rf) => rf.name)
    if (armedBranch === currentBranch) {
      return rowBranches.find((n) => n !== currentBranch)
    }
    return rowBranches.includes(currentBranch) ? currentBranch : undefined
  })()
  // a merge that cannot succeed is not offered: when the armed branch is
  // already contained in the target branch the merge is a no-op ("already
  // up to date" — e.g. arming an old branch and eyeing main's tip), and
  // squash-merging into a NON-checked-out branch needs a worktree we
  // don't control. The server's typed error remains the final guard for
  // cases the loaded window can't see through.
  const mergeNoop = !!(armedBranch && mergeIntoBranch && armed && containsCommit(row.sha, armed.tipSha))
  const squashMergePossible = mergeIntoBranch === currentBranch
  // squash collapses the armed branch's tip DOWN TO this row: the target
  // must be an ancestor of the tip, else there is nothing to collapse
  const squashValid = !armed || containsCommit(armed.tipSha, row.sha)
  // does this row offer ANY hover-revealed action? drives the wrapper (and
  // the node's hover hint) so an armed selection paints zero buttons until
  // the user actually hovers a node
  const hasRowActions =
    showRebase || (showSquash && squashValid) || showMove || (!!mergeIntoBranch && !mergeNoop)
  // while this row's hover-revealed actions are showing, its branch chips
  // step aside (display:none) so the buttons hug the node without the chip
  // crowd — the chips return when the row is left ("hide branches on node
  // target"). The armed row never qualifies (it offers no actions), so the
  // selected chip — the action popup's anchor — is never hidden.
  const actionsRevealed = actionsVisible && !!armed && hasRowActions

  const onDragOver = (e: DragEvent) => {
    if ((!onMoveBranch && !onMoveTag) || !e.dataTransfer.types.includes(DRAG_TYPE)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    setDragOver(true)
  }
  const onDrop = (e: DragEvent) => {
    setDragOver(false)
    if (!onMoveBranch && !onMoveTag) return
    const raw = e.dataTransfer.getData(DRAG_TYPE)
    if (!raw) return
    e.preventDefault()
    try {
      const { kind, name, tipSha } = JSON.parse(raw) as { kind: 'branch' | 'tag'; name: string; tipSha?: string }
      if (!name || tipSha === row.sha) return
      if (kind === 'tag') onMoveTag?.(name, row.sha)
      else onMoveBranch?.(name, row.sha)
    } catch {
      /* malformed payload — ignore */
    }
  }

  return (
    <div
      className={`group flex h-full items-center pr-4 transition-all ${
        dimmed ? 'opacity-20' : ''
      } ${dragOver ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-400/50' : selected ? 'bg-zinc-800/60' : 'hover:bg-zinc-900/60'}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={() => setDragOver(false)}
      onMouseLeave={() => setActionsVisible(false)}
    >
      {/* lane node — outlined circle in the lane color; solid when selected;
       *  picking the node ITSELF (vs a ref chip) also grows it 20%.
       *  Same padding on every side keeps the circle centered on (laneX,
       *  ROW_H/2), the point the edge layer draws its lines through.
       *  Keyboard: focusable button semantics (Tab reaches nodes; Enter/Space
       *  selects) — the hover-revealed row actions remain mouse-only. */}
      <div
        className="lane-slide absolute cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/70 rounded-full"
        style={{ left: x - r - NODE_PAD, top: (ROW_H - 2 * (r + NODE_PAD)) / 2 }}
        onMouseEnter={() => {
          setNodeHovered(true)
          setActionsVisible(true)
        }}
        onMouseLeave={() => setNodeHovered(false)}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(row.sha)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            e.stopPropagation()
            onSelect(row.sha)
          }
        }}
        tabIndex={0}
        role="button"
        aria-label={`Commit ${row.sha.slice(0, 7)}: ${row.subject}`}
        title={`Select commit ${row.sha.slice(0, 7)}${hasRowActions ? ' — hover shows this row\u2019s actions' : ''}`}
        data-testid="graph-node"
      >
        <svg
          width={2 * (r + NODE_PAD)}
          height={2 * (r + NODE_PAD)}
          className="transition-transform duration-150 ease-out"
          style={{ transform: selected && !selectedRef ? 'scale(1.2)' : 'scale(1)' }}
        >
          {/* backing plate: covers the edge layer in the stroke/ring band so
           *  curves visually terminate at the node boundary instead of
           *  X-crossing the HEAD ring (they still run to the center, hidden) */}
          <circle cx={r + NODE_PAD} cy={r + NODE_PAD} r={r + (isHead ? 5.5 : 2.75)} fill="#18181b" />
          {isHead && (
            <circle cx={r + NODE_PAD} cy={r + NODE_PAD} r={r + 4} fill="none" stroke={color} strokeWidth={1.5} opacity={0.55} />
          )}
          <circle
            cx={r + NODE_PAD}
            cy={r + NODE_PAD}
            r={r}
            className="transition-[fill] duration-150"
            fill={selected || dragOver ? color : '#18181b'}
            stroke={color}
            strokeWidth={isHead ? 2.5 : 2}
          />
        </svg>
      </div>

      {/* group A — tag chips + subject/meta, hugging the node on the
       * TRUNK-FACING side ("text next to the tag" on commit hover). tree
       * mode: the whole message block lives here; left mode: only the tags
       * mirror to the node's left. row-reverse keeps the tag nearest the
       * node on the left side, the message continuing away from it. */}
      {(msgWithTags || tags.length > 0) && (
        <div
          className={`lane-slide absolute inset-y-0 flex items-center gap-2${tagSide === 'left' ? ' flex-row-reverse' : ''}`}
          style={
            tagSide === 'left'
              ? { left: 16, right: (graphW ?? 0) - (x - r - 10) }
              : { left: x + r + 10, right: 16 }
          }
        >
          {tags.length > 0 && (
            <div className="flex shrink-0 items-center gap-1" data-testid="row-tag-chips">
              {tags.map((rf) => (
                <Chip
                  key={rf.name}
                  icon={<Tag className="h-3 w-3" />}
                  label={tagPushed(rf.name) ? `${tagPrefix}/${rf.name}` : rf.name}
                  title={
                    tagPushed(rf.name)
                      ? `${rf.name} is on ${tagRemoteName ?? 'the remote'}`
                      : onMoveTag
                        ? `${rf.name} — drag onto a commit to move`
                        : undefined
                  }
                  className={
                    'bg-amber-400/10 text-amber-300 border-amber-400/30' +
                    (selectedRef?.kind === 'tag' && selectedRef.name === rf.name ? ' ring-1 ring-amber-400/70' : '')
                  }
                  onSelect={onSelect}
                  sha={row.sha}
                  refKind="tag"
                  refName={rf.name}
                  dragRef={onMoveTag && !tagPushed(rf.name) ? { kind: 'tag', name: rf.name } : undefined}
                />
              ))}
            </div>
          )}
          {msgWithTags && (
            <>
              {/* subject — compact mode hides it except HEAD; the span stays
                 in layout (flex-1) so the hover peek never reflows the row */}
              <span
                className={`min-w-0 flex-1 truncate text-sm text-zinc-200${subjectHide}${tagSide === 'left' ? ' text-right' : ''}`}
                title={row.subject}
              >
                {clipSubject(row.subject)}
              </span>
              <span className={`shrink-0 text-xs text-zinc-500${metaHide}`}>{row.author}</span>
              <span className={`w-8 shrink-0 text-right text-xs tabular-nums text-zinc-500${metaHide}`}>
                {relTime(row.commitDate)}
              </span>
              <span className={`w-[3.5rem] shrink-0 font-mono text-xs text-zinc-600 group-hover:text-zinc-400${metaHide}`}>
                {row.sha.slice(0, 7)}
              </span>
            </>
          )}
        </div>
      )}

      {/* group B — branch chips + armed-row action buttons on the AWAY side
       * (left mode: the right-of-node flow carries the message too). Branch
       * names hug their node; buttons trail outward. */}
      <div
        className={`lane-slide absolute inset-y-0 flex items-center gap-1.5${tagSide === 'right' ? ' flex-row-reverse' : ''}`}
        style={
          tagSide === 'right'
            ? { left: 16, right: (graphW ?? 0) - (x - r - 10) }
            : { left: x + r + 10, right: 16 }
        }
      >
      {/* branch/remote chips, one line: [branch + its remote twin][orphan
       * remotes] — tags sit on the node's other side now. Ref type reads
       * through COLOR, not name prefixes: the checked-out branch is red,
       * local branches green, remote-tracking branches blue with the bare
       * branch name as label (the tooltip keeps the full origin/x ref), tags
       * amber. Selection, drags and git refspecs all keep the full name via
       * refName. */}
      <div className={`flex shrink-0 items-center gap-1${actionsRevealed ? ' hidden' : ''}`} data-testid="row-chips">
        {shownBranches.map((rf) => {
          if (rf.type === 'branch') {
            const current = isHead && rf.name === currentBranch
            return (
              <Chip
                key={rf.name}
                icon={<GitBranch className="h-3 w-3" />}
                label={rf.name}
                title={`${rf.name}${current ? ' — current branch (HEAD)' : ''} — drag onto a commit to move`}
                className={
                  (current
                    ? 'bg-red-400/10 text-red-300 border-red-400/30 font-medium'
                    : 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30 font-medium') +
                  (selectedRef?.kind === 'branch' && selectedRef.name === rf.name
                    ? current
                      ? ' ring-1 ring-red-400/70'
                      : ' ring-1 ring-emerald-400/70'
                    : '')
                }
                onSelect={onSelect}
                sha={row.sha}
                refKind="branch"
                refName={rf.name}
                dragRef={onMoveBranch ? { kind: 'branch', name: rf.name } : undefined}
                onCheckout={onCheckout && rf.name !== currentBranch ? () => onCheckout(rf.name) : undefined}
              />
            )
          }
          return (
            <Chip
              key={rf.name}
              icon={<GitBranch className="h-3 w-3" />}
              label={rf.name.slice(rf.name.indexOf('/') + 1)}
              title={`${rf.name} — double-click to check out`}
              className={
                'bg-sky-400/10 text-sky-300/80 border-sky-400/20' +
                (selectedRef?.kind === 'remote-branch' && selectedRef.name === rf.name ? ' ring-1 ring-sky-400/70' : '')
              }
              onSelect={onSelect}
              sha={row.sha}
              refKind="remote-branch"
              refName={rf.name}
              onCheckout={onCheckout ? () => onCheckout(rf.name) : undefined}
            />
          )
        })}
        {overflow > 0 && (
          <button
            className="cursor-pointer rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
            onClick={(e) => {
              e.stopPropagation()
              setChipsExpanded(true)
            }}
            title={`Show ${overflow} more ref${overflow === 1 ? '' : 's'} on this commit`}
            data-testid="chip-overflow"
          >
            +{overflow}
          </button>
        )}
        {chipsExpanded && ordered.length > MAX_CHIPS && (
          <button
            className="cursor-pointer rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
            onClick={(e) => {
              e.stopPropagation()
              setChipsExpanded(false)
            }}
            title="Collapse the extra refs"
            data-testid="chip-collapse"
          >
            −
          </button>
        )}
      </div>

      {/* armed-ref target buttons — revealed by hovering the commit node,
       * hidden again on row leave (actionsVisible): [rebase] replays the
       * armed current branch onto this row; [squash] collapses the armed
       * (any local) branch down to it; [move to] points any armed ref here;
       * [merge]/[squash merge] fold the armed branch into this row's branch.
       * Hover previews draw on the graph via [data-action-preview]. */}
      {actionsRevealed && armed && (
        <div className="flex shrink-0 items-center gap-1.5" data-testid="row-actions">
          {showRebase && (
            <button
              className="shrink-0 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-300 hover:bg-violet-500/25"
              title={`Rebase "${armed.name}" onto ${row.sha.slice(0, 7)} — its commits are replayed after this one. Conflicts pause in the staging area.`}
              onClick={(e) => {
                e.stopPropagation()
                onRowAction!('rebase', row.sha)
              }}
              data-testid="row-rebase-button"
              data-action-preview="rebase"
            >
              rebase
            </button>
          )}
          {showSquash && squashValid && (
            <button
              className="shrink-0 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-300 hover:bg-violet-500/25"
              title={
                armedIsCurrent
                  ? `Squash "${armed.name}" down to ${row.sha.slice(0, 7)} — pick the commits, changes land staged`
                  : `Squash "${armed.name}" down to ${row.sha.slice(0, 7)} — one new commit replaces the segment (no checkout needed)`
              }
              onClick={(e) => {
                e.stopPropagation()
                onRowAction!('squash', row.sha)
              }}
              data-testid="row-squash-button"
              data-action-preview="squash"
            >
              squash
            </button>
          )}
          {showMove && (
            <button
              className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25"
              title={
                armed.remote
                  ? `Push ${armed.name} to ${row.sha.slice(0, 7)} (moves the remote branch)`
                  : `Move "${armed.name}" to ${row.sha.slice(0, 7)}`
              }
              onClick={(e) => {
                e.stopPropagation()
                onRowAction!('move', row.sha)
              }}
              data-testid="row-move-button"
              data-action-preview="move"
            >
              move to
            </button>
          )}

          {/* merge into this row's local branch, from the armed branch — hidden
           * entirely when the merge can only be a no-op (target already contains
           * the armed branch); squash merge additionally requires the target to
           * be checked out (it stages through the worktree) */}
          {mergeIntoBranch && armedBranch && !mergeNoop && (
            <>
              <button
                className="shrink-0 rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25"
                title={
                  mergeIntoBranch === currentBranch
                    ? `Merge "${armedBranch}" into "${mergeIntoBranch}" (fast-forward when possible; conflicts surface in the staging area)`
                    : `Merge "${armedBranch}" into "${mergeIntoBranch}" (fast-forward only — "${mergeIntoBranch}" is not checked out)`
                }
                onClick={(e) => {
                  e.stopPropagation()
                  onRowAction!('merge', row.sha, mergeIntoBranch)
                }}
                data-testid="row-merge-button"
                data-ghost-preview={row.sha}
                data-action-preview="merge"
              >
                merge
              </button>
              {squashMergePossible && (
                <button
                  className="shrink-0 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-300 hover:bg-violet-500/25"
                  title={`Squash-merge "${armedBranch}" into "${mergeIntoBranch}": stage all of its changes as one — no merge commit; you write the message`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRowAction!('squash-merge', row.sha, mergeIntoBranch)
                  }}
                  data-testid="row-squash-merge-button"
                  data-ghost-preview={row.sha}
                  data-action-preview="squash-merge"
                >
                  squash merge
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* left mode: the subject + meta ride in this right-of-node flow
       * (tree mode renders them in group A, next to the tags) */}
      {!msgWithTags && (
        <>
          {/* subject — compact mode hides it except HEAD; the span stays in
           * layout (flex-1) so toggling never reflows the row, hover reveals */}
          <span className={`min-w-0 flex-1 truncate text-sm text-zinc-200${subjectHide}`} title={row.subject}>
            {clipSubject(row.subject)}
          </span>

          {/* meta — compact mode fades these too; hover peeks */}
          <span className={`shrink-0 text-xs text-zinc-500${metaHide}`}>{row.author}</span>
          <span className={`w-8 shrink-0 text-right text-xs tabular-nums text-zinc-500${metaHide}`}>{relTime(row.commitDate)}</span>
          <span className={`w-[3.5rem] shrink-0 font-mono text-xs text-zinc-600 group-hover:text-zinc-400${metaHide}`}>
            {row.sha.slice(0, 7)}
          </span>
        </>
      )}
      </div>
    </div>
  )
}

function Chip({
  icon,
  label,
  className,
  onSelect,
  sha,
  refKind,
  refName,
  dragRef,
  onCheckout,
  title,
}: {
  icon: ReactNode
  label: string
  className: string
  onSelect: (sha: string, ref?: { kind: 'branch' | 'tag' | 'remote-branch'; name: string }) => void
  sha: string
  /** this chip's ref identity — clicking selects the ref, not just the commit */
  refKind: 'branch' | 'tag' | 'remote-branch'
  /** raw ref name (the label is a color-coded rendering — remote prefixes are
   *  display-only; every action goes through this full name) */
  refName: string
  /** set → the chip is draggable onto another row to move that branch/tag */
  dragRef?: { kind: 'branch' | 'tag'; name: string }
  /** set → double-click checks this branch out (non-current local branches) */
  onCheckout?: () => void
  /** optional hover tooltip */
  title?: string
}) {
  return (
    <button
      type="button"
      draggable={!!dragRef}
      onDragStart={(e) => {
        if (!dragRef) return
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: dragRef.kind, name: dragRef.name, tipSha: sha }))
        e.dataTransfer.effectAllowed = 'move'
      }}
      className={`inline-flex max-w-44 items-center gap-1 truncate rounded-md border px-1.5 py-0.5 text-[11px] hover:brightness-125 ${
        dragRef ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer'
      } ${className}`}
      title={title ?? (onCheckout ? `${label} — double-click to check out` : label)}
      onClick={(e) => {
        e.stopPropagation()
        onSelect(sha, { kind: refKind, name: refName })
      }}
      onDoubleClick={(e) => {
        e.stopPropagation()
        onCheckout?.()
      }}
      data-testid="graph-ref-chip"
      data-ref={`${refKind}:${refName}`}
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

export default memo(GraphRowInner)
