import { memo, useState, type DragEvent, type ReactNode } from 'react'
import { GitBranch, Tag } from 'lucide-react'
import type { CommitRow, RefInfo } from '../../lib/types'
import { relTime } from '../../lib/time'
import { abbrevRemote, abbrevRemoteRef } from '../../lib/remoteLabel'
import { useGraphStore } from '../../state/graphStore'
import { ROW_H, laneX } from './GraphView'
import { laneColor } from './GraphEdges'

/**
 * Is `ancestorSha` reachable from `fromSha` through the loaded rows' parents
 * (full DAG walk, not first-parent — containment is topological)? Used to
 * detect no-op merges: the armed branch is already contained in the target.
 * Bounded; a parent outside the loaded window reads as "not contained", so
 * the server's clear error remains the final guard.
 */
function containsCommit(fromSha: string, ancestorSha: string): boolean {
  const rows = useGraphStore.getState().rowsBySha
  const seen = new Set<string>()
  const stack = [fromSha]
  while (stack.length > 0 && seen.size < 5000) {
    const cur = stack.pop()!
    if (cur === ancestorSha) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    const row = rows.get(cur)
    if (!row) continue
    stack.push(...row.parents)
  }
  return false
}

interface GraphRowProps {
  row: CommitRow
  lane: number
  refs?: RefInfo[]
  /** tag names known to be on the remote — pushed tags render as <remote-abbrev>/<tag> */
  remoteTags?: string[]
  /** the remote the remoteTags cache came from (raw name — the pushed-tag prefix) */
  remoteTagRemote?: string | null
  isHead: boolean
  /** the checked-out branch — the only chip allowed to say (HEAD) */
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
   * every other row grows contextual target buttons (ungit's drop-action
   * model: one click on the target row instead of a popup round-trip).
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

const MAX_CHIPS = 4 // [tag][branch][ori/twin][branch] fits before the +N chip
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
 * branch/remote chip ARMS it: rows grow contextual target buttons
 * ([rebase][squash] while the current branch is armed, [<- move] always,
 * [merge][squash merge] on the receiving branch's row), and local branch
 * chips can still be dragged onto a row to move the branch.
 */
function GraphRowInner({
  row,
  lane,
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
  const x = laneX(lane)
  // the working branch's tip (HEAD) reads at 50% bigger than branch nodes;
  // plain commits stay smallest
  const r = isHead ? 15 : (refs?.some((rf) => rf.type === 'branch' && !rf.name.includes('/')) === true) ? 10 : 8
  const chips = refs ?? []
  // Chip order: [tags…][branch, its remote twin, branch, …][orphan remotes].
  // Pushed-tag truth: the server's ls-remote cache (refreshed after every
  // fetch/push/pull) when it has data; before any network op ran through
  // sirgit, fall back to the row heuristic — every chip on a row points at
  // the SAME commit, so a tag riding a row that carries a remote chip is
  // on the remote. Either way only the pushed form is shown (never both,
  // unlike branches which keep local + remote visible).
  const knownRemoteTags = remoteTags != null && remoteTags.length > 0
  const rowHasRemote = chips.some((rf) => rf.type === 'remote-branch')
  const tagPushed = (name: string) => (knownRemoteTags ? remoteTags!.includes(name) : rowHasRemote)
  // the remote a pushed tag's prefix names: the ls-remote cache's remote
  // when it's authoritative, else the remote chip riding the row
  const rowRemoteName = chips.find((rf) => rf.type === 'remote-branch')?.name.split('/')[0]
  const tagRemoteName = knownRemoteTags ? (remoteTagRemote ?? rowRemoteName) : rowRemoteName
  const tagPrefix = abbrevRemote(tagRemoteName ?? 'origin')
  const tags = chips.filter((rf) => rf.type === 'tag')
  const ordered: typeof chips = []
  const paired = new Set<string>()
  for (const rf of chips) {
    if (rf.type !== 'branch') continue
    ordered.push(rf)
    paired.add(rf.name)
    const twin = chips.find((o) => o.type === 'remote-branch' && o.name === `origin/${rf.name}`)
    if (twin) {
      ordered.push(twin)
      paired.add(twin.name)
    }
  }
  for (const rf of chips) {
    if (rf.type !== 'tag' && !paired.has(rf.name)) ordered.push(rf)
  }
  const shown = [...tags, ...ordered].slice(0, MAX_CHIPS)
  const overflow = tags.length + ordered.length - shown.length
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
      className={`group flex h-full items-center border-b border-zinc-900/80 pr-4 transition-all ${
        dimmed ? 'opacity-20' : ''
      } ${dragOver ? 'bg-emerald-500/10 ring-1 ring-inset ring-emerald-400/50' : selected ? 'bg-zinc-800/60' : 'hover:bg-zinc-900/60'}`}
      style={{ paddingLeft: x + r + 10 }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDragLeave={() => setDragOver(false)}
    >
      {/* lane node — outlined circle in the lane color; solid when selected;
       *  picking the node ITSELF (vs a ref chip) also grows it 20%.
       *  Same padding on every side keeps the circle centered on (laneX,
       *  ROW_H/2), the point the edge layer draws its lines through. */}
      <div
        className="absolute cursor-pointer"
        style={{ left: x - r - NODE_PAD, top: (ROW_H - 2 * (r + NODE_PAD)) / 2 }}
        onClick={(e) => {
          e.stopPropagation()
          onSelect(row.sha)
        }}
        title={`Select commit ${row.sha.slice(0, 7)}`}
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
            fill={selected ? color : '#18181b'}
            stroke={color}
            strokeWidth={isHead ? 2.5 : 2}
          />
        </svg>
      </div>

      {/* ref chips, one line: [tags][branch + its remote twin][orphan remotes].
       * Remote names abbreviate to 3 letters in LABELS ONLY (origin/main →
       * ori/main) — selection, drags and git refspecs all keep the full name
       * via refName. A pushed tag renders as <abbrev>/<tag> only. */}
      <div className="mr-2 flex shrink-0 items-center gap-1" data-testid="row-chips">
        {shown.map((rf) =>
          rf.type === 'tag' ? (
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
          ) : rf.type === 'branch' ? (
            <Chip
              key={rf.name}
              icon={<GitBranch className="h-3 w-3" />}
              label={rf.name + (isHead && rf.name === currentBranch ? ' (HEAD)' : '')}
              className={
                'bg-emerald-400/10 text-emerald-300 border-emerald-400/30 font-medium' +
                (selectedRef?.kind === 'branch' && selectedRef.name === rf.name ? ' ring-1 ring-emerald-400/70' : '')
              }
              onSelect={onSelect}
              sha={row.sha}
              refKind="branch"
              refName={rf.name}
              dragRef={onMoveBranch ? { kind: 'branch', name: rf.name } : undefined}
              onCheckout={onCheckout && rf.name !== currentBranch ? () => onCheckout(rf.name) : undefined}
            />
          ) : (
            <Chip
              key={rf.name}
              icon={<GitBranch className="h-3 w-3" />}
              label={abbrevRemoteRef(rf.name)}
              title={rf.name}
              className={
                'bg-sky-400/10 text-sky-300/80 border-sky-400/20' +
                (selectedRef?.kind === 'remote-branch' && selectedRef.name === rf.name ? ' ring-1 ring-sky-400/70' : '')
              }
              onSelect={onSelect}
              sha={row.sha}
              refKind="remote-branch"
              refName={rf.name}
            />
          ),
        )}
        {overflow > 0 && (
          <span className="rounded border border-zinc-700 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] text-zinc-400">
            +{overflow}
          </span>
        )}
      </div>

      {/* armed-ref target buttons: [rebase] replays the armed current branch
       * onto this row; [squash] collapses the armed (any local) branch down
       * to it; [<- move] points any armed ref here. Hover previews draw on
       * the graph via [data-action-preview]. */}
      {showRebase && armed && (
        <button
          className="mr-1 shrink-0 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-300 hover:bg-violet-500/25"
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
      {showSquash && armed && squashValid && (
        <button
          className="mr-1 shrink-0 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-300 hover:bg-violet-500/25"
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
      {showMove && armed && (
        <button
          className="mr-2 shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-300 hover:bg-amber-500/25"
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
          {'<- move'} {armed.name}
        </button>
      )}

      {/* merge into this row's local branch, from the armed branch — hidden
       * entirely when the merge can only be a no-op (target already contains
       * the armed branch); squash merge additionally requires the target to
       * be checked out (it stages through the worktree) */}
      {mergeIntoBranch && onRowAction && armedBranch && !mergeNoop && (
        <>
          <button
            className="mr-1 shrink-0 rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25"
            title={
              mergeIntoBranch === currentBranch
                ? `Merge "${armedBranch}" into "${mergeIntoBranch}" (fast-forward when possible; conflicts surface in the staging area)`
                : `Merge "${armedBranch}" into "${mergeIntoBranch}" (fast-forward only — "${mergeIntoBranch}" is not checked out)`
            }
            onClick={(e) => {
              e.stopPropagation()
              onRowAction('merge', row.sha, mergeIntoBranch)
            }}
            data-testid="row-merge-button"
            data-ghost-preview={row.sha}
            data-action-preview="merge"
          >
            merge
          </button>
          {squashMergePossible && (
            <button
              className="mr-2 shrink-0 rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 text-[11px] font-medium text-violet-300 hover:bg-violet-500/25"
              title={`Squash-merge "${armedBranch}" into "${mergeIntoBranch}": stage all of its changes as one — no merge commit; you write the message`}
              onClick={(e) => {
                e.stopPropagation()
                onRowAction('squash-merge', row.sha, mergeIntoBranch)
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

      {/* subject */}
      <span className="min-w-0 flex-1 truncate text-sm text-zinc-200">{row.subject}</span>

      {/* meta */}
      <span className="ml-3 shrink-0 text-xs text-zinc-500">{row.author}</span>
      <span className="ml-2 w-8 shrink-0 text-right text-xs tabular-nums text-zinc-500">{relTime(row.commitDate)}</span>
      <span className="ml-2 w-[3.5rem] shrink-0 font-mono text-xs text-zinc-600 group-hover:text-zinc-400">
        {row.sha.slice(0, 7)}
      </span>
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
  /** raw ref name (label may carry the (HEAD) suffix or the abbreviated remote) */
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
    >
      {icon}
      <span className="truncate">{label}</span>
    </button>
  )
}

export default memo(GraphRowInner)
