import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  RotateCcw,
  Plus,
  Minus,
  Check,
  AlertTriangle,
  Archive,
  Loader2,
  MoreHorizontal,
} from 'lucide-react'
import { api } from '../../lib/client'
import { useStatus } from '../../api/hooks'
import { useUiStore } from '../../state/uiStore'
import { useGraphStore } from '../../state/graphStore'
import { friendlyError } from '../../lib/gitErrors'
import DiffView from '../commit/DiffView'
import StashSection from './StashSection'

type FileAction = 'stage' | 'unstage' | 'discard' | 'resolve'

interface GroupFile {
  path: string
  origPath?: string
  indexStatus: string
  worktreeStatus: string
  additions?: number
  deletions?: number
  conflict: boolean
  untracked: boolean
}

/**
 * Staging area: file groups (staged / changed / untracked / conflicted) with
 * stage-unstage-discard-resolve actions, inline diffs, and the commit box.
 * variant="overlay" floats it over the commit map for extra room ([v] toggle).
 */
export default function StagingPanel({
  path,
  headSha,
  headBranch,
}: {
  path: string
  headSha?: string
  headBranch?: string
}) {
  const { data: status, isLoading } = useStatus(path)
  const stagingOpen = useUiStore((s) => s.stagingOpen)
  const toggleStaging = useUiStore((s) => s.toggleStaging)
  const stagingExpanded = useUiStore((s) => s.stagingExpanded)
  const setStagingExpanded = useUiStore((s) => s.setStagingExpanded)
  const toast = useUiStore((s) => s.toast)
  const qc = useQueryClient()

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [amend, setAmend] = useState(false)
  const commitPrefill = useUiStore((s) => s.commitPrefill)
  const titleRef = useRef<HTMLInputElement>(null)

  // squash merge landed its changes staged, with the gathered commit messages —
  // prefill the box amend-style; the user reviews and commits
  useEffect(() => {
    if (!commitPrefill) return
    setAmend(false)
    setTitle(commitPrefill.title)
    setBody(commitPrefill.body)
    useUiStore.getState().setCommitPrefill(null)
    titleRef.current?.focus()
  }, [commitPrefill])

  // amend checkbox: load HEAD's message into the fields; uncheck clears them
  const onAmendChange = (checked: boolean) => {
    setAmend(checked)
    if (checked && headSha) {
      void api
        .commitDetail(path, headSha)
        .then((d) => {
          setTitle(d.subject)
          setBody(d.body)
        })
        .catch(() => undefined)
    } else if (!checked) {
      setTitle('')
      setBody('')
    }
  }
  const [stagedOpen, setStagedOpen] = useState(true)
  const [othersOpen, setOthersOpen] = useState(true)
  const [openDiffs, setOpenDiffs] = useState<Set<string>>(new Set())
  /** busy key like "stage:src/a.ts" or "continue" — blocks duplicate clicks */
  const [pendingKey, setPendingKey] = useState<string | null>(null)

  // changes column: when its content outgrows the default bar height, show a
  // "⋯ more" affordance that grows the panel inline for more room
  const changesRef = useRef<HTMLDivElement>(null)
  const [overflowing, setOverflowing] = useState(false)
  useLayoutEffect(() => {
    const el = changesRef.current
    if (!el) return
    const check = () => setOverflowing(el.scrollHeight > el.clientHeight + 4)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [status?.files, stagedOpen, othersOpen, openDiffs])

  const runAction = (key: string, fn: () => Promise<unknown>) => {
    if (pendingKey) return
    setPendingKey(key)
    useUiStore.getState().beginOp('Working')
    fn()
      .then(invalidate)
      .catch((e: unknown) => {
        const { title, detail } = friendlyError(e)
        toast({ kind: 'error', title, detail })
      })
      .finally(() => {
        setPendingKey(null)
        useUiStore.getState().endOp()
      })
  }

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['status', path] })
    void qc.invalidateQueries({ queryKey: ['refs', path] })
    void qc.invalidateQueries({ queryKey: ['stash', path] })
    void qc.invalidateQueries({ queryKey: ['stash-files', path] })
    void useGraphStore.getState().applyDelta()
  }

  const afterOp = {
    onSuccess: invalidate,
    onError: (e: unknown) => {
      const { title, detail } = friendlyError(e)
      toast({ kind: 'error', title, detail })
    },
  }

  const commitMut = useMutation({
    mutationFn: () =>
      // amend rewrites the existing commit — allow message-only amends of
      // empty commits (git otherwise refuses with "would make it empty")
      api.commit(path, body.trim() ? `${title.trim()}\n\n${body.trim()}` : title.trim(), amend, amend),
    onSuccess: () => {
      setTitle('')
      setBody('')
      setAmend(false)
      toast({ kind: 'success', title: amend ? 'Commit amended' : 'Commit created' })
      invalidate()
    },
    onError: (e: unknown) => {
      const { title: t, detail } = friendlyError(e)
      toast({ kind: 'error', title: t, detail })
    },
  })

  const files = status?.files ?? []
  const staged = useMemo(
    () => files.filter((f) => f.indexStatus !== '.' && f.indexStatus !== '?'),
    [files],
  )
  const unstaged = useMemo(
    () => files.filter((f) => f.indexStatus === '.' && !f.untracked && f.worktreeStatus !== '.'),
    [files],
  )
  const untracked = useMemo(() => files.filter((f) => f.untracked), [files])
  const conflicts = useMemo(() => files.filter((f) => f.conflict), [files])

  const inProgress = (status?.inMerge ?? false) || (status?.inRebase ?? false) || (status?.inCherry ?? false) || (status?.inRevert ?? false)
  // amend doesn't need staged changes (it reuses HEAD's tree) — message edits alone are a valid amend
  const canCommit = (staged.length > 0 || amend) && title.trim().length > 0 && conflicts.length === 0
  // nothing to commit → no commit box: with a clean worktree the changes pane
  // takes the full width (the box returns as soon as something is staged)
  const hideCommit = files.length === 0 && !inProgress && !isLoading

  const toggleDiff = (p: string) => {
    setOpenDiffs((prev) => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p)
      else next.add(p)
      return next
    })
  }

  return (
    <section className="relative border-b border-zinc-800 bg-zinc-900/30" data-testid="staging">
      {/* stash stack — above the staging header, hidden while empty */}
      <StashSection path={path} onChanged={invalidate} />
      <div>
        <div className="flex w-full items-center gap-2 px-4 py-2 hover:bg-zinc-900/60">
          <button
            className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium text-zinc-300"
            onClick={toggleStaging}
            title={stagingOpen ? 'Collapse the staging area' : 'Expand the staging area'}
          >
            {stagingOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            Staging
            <span className="rounded-full bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400">
              {staged.length} staged · {unstaged.length + untracked.length} unstaged
            </span>
            {conflicts.length > 0 && (
              <span className="flex items-center gap-1 rounded-full bg-red-500/15 px-2 py-0.5 text-xs text-red-300">
                <AlertTriangle className="h-3 w-3" /> {conflicts.length} conflicted
              </span>
            )}
          </button>
          {/* bulk actions: stash everything / stage everything / unstage everything */}
          <button
            className="flex items-center gap-1 rounded-md border border-sky-500/40 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25 disabled:opacity-40"
            title="Stash every change — tracked and untracked (git stash push -u). Restores it from the Stashed changes section above."
            disabled={pendingKey !== null || (unstaged.length === 0 && untracked.length === 0 && staged.length === 0)}
            onClick={() => runAction('stash:__all', () => api.stashPush(path))}
            data-testid="stash-all"
          >
            {pendingKey === 'stash:__all' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Archive className="h-3.5 w-3.5" />}
            stash
          </button>
          <button
            className="flex items-center gap-1 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
            title="Stage every change for the next commit (git add .)"
            disabled={pendingKey === 'stage:__all' || (unstaged.length === 0 && untracked.length === 0)}
            onClick={() => runAction('stage:__all', () => api.stage(path, ['.']))}
            data-testid="stage-all"
          >
            {pendingKey === 'stage:__all' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
            select all
          </button>
          <button
            className="flex items-center gap-1 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-300 hover:bg-red-500/25 disabled:opacity-40"
            title="Unstage everything (changes stay in the worktree)"
            disabled={pendingKey === 'unstage:__all' || staged.length === 0}
            onClick={() => runAction('unstage:__all', () => api.unstage(path, staged.map((f) => f.path)))}
            data-testid="unstage-all"
          >
            {pendingKey === 'unstage:__all' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Minus className="h-3.5 w-3.5" />}
            deselect all
          </button>
        </div>

        {stagingOpen && (
          <div className="px-4 pb-3">
          {/* collapsed: [commit box 1/3 | changes 2/3] side by side at the
              compact bar height. expanded ([v]): full-width stacked rows —
              the commit message, then the changes with all the remaining
              room (up to 75% of the viewport) for reviewing diffs.
              Nothing to commit (clean tree) → the box is hidden entirely. */}
          <div className={`flex gap-3 ${stagingExpanded ? 'flex-col max-h-[75vh]' : 'items-stretch max-h-56'}`}>
            {!hideCommit && (
            <div className={stagingExpanded ? 'shrink-0' : 'scroll-thin w-1/3 min-w-[240px] shrink-0 overflow-y-auto'}>
          {/* commit box */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3">
            <input
              ref={titleRef}
              className="w-full rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-600"
              placeholder={`Commit title${headBranch ? ` → ${headBranch}` : ''}…`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && canCommit) commitMut.mutate()
              }}
              data-testid="commit-input"
            />
            <textarea
              className="mt-2 w-full resize-y rounded-md border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-emerald-600"
              placeholder="Description (optional)…"
              rows={3}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              data-testid="commit-body"
            />
            <div className="mt-2 flex items-center gap-3">
              <button
                className="flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-40"
                disabled={!canCommit || commitMut.isPending}
                onClick={() => commitMut.mutate()}
                data-testid="commit-button"
                data-ghost-preview={headSha}
                title="Creates the next commit — hover previews it as the dashed node above HEAD"
              >
                {commitMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                {amend ? 'Amend commit' : 'Commit'}
              </button>
              <label
                className="flex items-center gap-1.5 text-xs text-zinc-400"
                title="Rewrite the last commit — your current changes (staged or not) fold into it; the message box loads its message for editing"
              >
                <input
                  type="checkbox"
                  checked={amend}
                  onChange={(e) => onAmendChange(e.target.checked)}
                  className="accent-emerald-600"
                />
                Amend
              </label>
              <span className="ml-auto text-xs text-zinc-600">Enter to commit</span>
            </div>
          </div>
            </div>
            )}

            {/* changes — right two thirds, scrolls independently */}
            <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
              <div ref={changesRef} className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          {isLoading && <p className="py-2 text-xs text-zinc-500">loading status…</p>}

          {inProgress && (
            <div className="mb-3 flex items-center justify-between rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              <span>
                {status?.inMerge
                  ? 'Merge'
                  : status?.inRebase
                    ? 'Rebase'
                    : status?.inRevert
                      ? 'Revert'
                      : 'Cherry-pick'}{' '}
                in progress — resolve conflicts, then continue.
              </span>
              <span className="flex gap-2">
                {status?.inRebase ? (
                  <>
                    <ContinueAbort
                      abortTitle="Abort rebase"
                      abortMessage="Stops the rebase and restores the branch to where it was. Conflict resolutions that were not committed are lost."
                      onContinue={() => api.rebaseContinue(path)}
                      onAbort={() => api.rebaseAbort(path)}
                      ghostTarget={headSha}
                      {...afterOp}
                    />
                  </>
                ) : status?.inRevert ? (
                  <ContinueAbort
                    abortTitle="Abort revert"
                    abortMessage="Stops the revert and restores the branch to where it was. Conflict resolutions that were not committed are lost."
                    onContinue={() => api.revertContinue(path)}
                    onAbort={() => api.revertAbort(path)}
                    ghostTarget={headSha}
                    {...afterOp}
                  />
                ) : (
                  <ContinueAbort
                    abortTitle="Abort merge"
                    abortMessage="Stops the merge and restores the branch to the pre-merge state. Conflict resolutions that were not committed are lost."
                    onContinue={() => api.mergeContinue(path)}
                    onAbort={() => api.mergeAbort(path)}
                    ghostTarget={headSha}
                    {...afterOp}
                  />
                )}
              </span>
            </div>
          )}

          <FileGroup
            title="Staged"
            open={stagedOpen}
            onToggle={() => setStagedOpen(!stagedOpen)}
            files={staged}
            path={path}
            pendingKey={pendingKey}
            openDiffs={openDiffs}
            toggleDiff={toggleDiff}
            onAction={(file, action) => {
              if (action === 'unstage') runAction(`unstage:${file}`, () => api.unstage(path, [file]))
              if (action === 'discard') {
                useUiStore.getState().setDialog({
                  kind: 'confirm',
                  title: `Discard ${file}`,
                  message: 'Resets the file to HEAD — the staged changes and the file content are lost. This cannot be undone.',
                  confirmLabel: 'Discard',
                  danger: true,
                  onConfirm: () => runAction(`discard:${file}`, () => api.discard(path, [file], [])),
                })
              }
            }}
          />
          <FileGroup
            title="Changed"
            open={othersOpen}
            onToggle={() => setOthersOpen(!othersOpen)}
            files={unstaged}
            path={path}
            pendingKey={pendingKey}
            openDiffs={openDiffs}
            toggleDiff={toggleDiff}
            onAction={(file, action) => {
              if (action === 'stage') runAction(`stage:${file}`, () => api.stage(path, [file]))
              if (action === 'discard') {
                useUiStore.getState().setDialog({
                  kind: 'confirm',
                  title: `Discard changes to ${file}`,
                  message: 'The uncommitted changes to this file are lost. This cannot be undone.',
                  confirmLabel: 'Discard',
                  danger: true,
                  onConfirm: () => runAction(`discard:${file}`, () => api.discard(path, [file], [])),
                })
              }
            }}
          />
          <FileGroup
            title="Untracked"
            open={othersOpen}
            onToggle={() => setOthersOpen(!othersOpen)}
            files={untracked}
            path={path}
            pendingKey={pendingKey}
            openDiffs={openDiffs}
            toggleDiff={toggleDiff}
            onAction={(file, action) => {
              if (action === 'stage') runAction(`stage:${file}`, () => api.stage(path, [file]))
              if (action === 'discard') {
                useUiStore.getState().setDialog({
                  kind: 'confirm',
                  title: `Delete ${file}`,
                  message: 'This untracked file is deleted. This cannot be undone.',
                  confirmLabel: 'Delete',
                  danger: true,
                  onConfirm: () => runAction(`discard:${file}`, () => api.discard(path, [file], [file])),
                })
              }
            }}
          />
          {conflicts.length > 0 && (
            <FileGroup
              title="Conflicted"
              open
              onToggle={() => undefined}
              files={conflicts}
              path={path}
              pendingKey={pendingKey}
              openDiffs={openDiffs}
              toggleDiff={toggleDiff}
              onAction={(file, action) => {
                if (action === 'stage' || action === 'resolve') {
                  runAction(`resolve:${file}`, () => api.resolve(path, [file]))
                }
              }}
            />
          )}

          {!isLoading && files.length === 0 && (
            <p className="py-6 text-center text-xs text-zinc-600">no changes — worktree clean</p>
          )}
              </div>
              {/* scroll-boundary fade: the thin scrollbar is nearly invisible,
                  without it the internally-scrolling list reads as clipped */}
              <div className="pointer-events-none absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-zinc-900 to-transparent" />
              {overflowing && !stagingExpanded && (
                <button
                  className="flex w-full items-center justify-center gap-1.5 border-t border-zinc-800 bg-zinc-900/80 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
                  title="More changes than fit — grow the staging area"
                  onClick={() => setStagingExpanded(true)}
                  data-testid="changes-overflow"
                >
                  <MoreHorizontal className="h-3.5 w-3.5" /> more changes below — expand
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      </div>

      {/* drawer-pull handle on the bottom-center edge: grows the staging
          section inline (taller commit box + changes) / shrinks it back */}
      <button
        className="absolute bottom-[-9px] left-1/2 z-10 flex h-[18px] w-16 -translate-x-1/2 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-zinc-400 shadow-md hover:bg-zinc-800 hover:text-zinc-200"
        title={stagingExpanded ? 'Shrink the staging area back to the compact bar' : 'Grow the staging area for more room'}
        onClick={() => setStagingExpanded(!stagingExpanded)}
        data-testid="staging-expand"
      >
        {stagingExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
      </button>
    </section>
  )
}

function ContinueAbort({
  abortTitle,
  abortMessage,
  onContinue,
  onAbort,
  ghostTarget,
  onSuccess,
  onError,
}: {
  abortTitle: string
  abortMessage: string
  onContinue: () => Promise<unknown>
  onAbort: () => Promise<unknown>
  /** the commit lands on HEAD — hovering Continue previews the ghost above it */
  ghostTarget?: string
  onSuccess: () => void
  onError: (e: unknown) => void
}) {
  const [pending, setPending] = useState<'continue' | 'abort' | null>(null)
  const run = (kind: 'continue' | 'abort', fn: () => Promise<unknown>) => {
    if (pending) return
    setPending(kind)
    void fn()
      .then(onSuccess)
      .catch(onError)
      .finally(() => setPending(null))
  }
  return (
    <>
      <button
        className={`flex items-center gap-1 rounded px-2 py-1 text-white ${pending ? 'bg-emerald-600/60' : 'bg-emerald-600 hover:bg-emerald-500'}`}
        disabled={!!pending}
        onClick={() => run('continue', onContinue)}
        data-ghost-preview={ghostTarget}
        title="Finishes the in-flight commit — hover previews it as the dashed node above HEAD"
      >
        {pending === 'continue' && <Loader2 className="h-3 w-3 animate-spin" />} Continue
      </button>
      <button
        className={`flex items-center gap-1 rounded px-2 py-1 text-zinc-200 ${pending ? 'bg-zinc-700/60' : 'bg-zinc-700 hover:bg-zinc-600'}`}
        disabled={!!pending}
        onClick={() => {
          // abort discards uncommitted conflict resolution — confirm first
          useUiStore.getState().setDialog({
            kind: 'confirm',
            title: abortTitle,
            message: abortMessage,
            confirmLabel: 'Abort',
            danger: true,
            onConfirm: () => run('abort', onAbort),
          })
        }}
      >
        {pending === 'abort' && <Loader2 className="h-3 w-3 animate-spin" />} Abort
      </button>
    </>
  )
}

function FileGroup({
  title,
  open,
  onToggle,
  files,
  path,
  openDiffs,
  toggleDiff,
  onAction,
  pendingKey,
}: {
  title: string
  open: boolean
  onToggle: () => void
  files: GroupFile[]
  path: string
  openDiffs: Set<string>
  toggleDiff: (p: string) => void
  onAction: (file: string, action: FileAction) => void
  pendingKey: string | null
}) {
  const busy = pendingKey !== null
  if (files.length === 0) return null
  return (
    <div className="mb-2">
      <button className="flex w-full items-center gap-1.5 py-1 text-xs font-medium text-zinc-400" onClick={onToggle}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
        <span className="text-zinc-600">({files.length})</span>
      </button>
      {open && (
        <ul className="divide-y divide-zinc-800/60 overflow-hidden rounded-lg border border-zinc-800/80">
          {files.map((f) => (
            <li key={f.path} className="bg-zinc-900/40 px-2.5 py-1.5 text-xs">
              <div className="flex items-center gap-2">
                <button
                  className="min-w-0 flex-1 truncate text-left font-mono text-zinc-300 hover:text-emerald-400"
                  onClick={() => toggleDiff(f.path)}
                  title={f.path}
                >
                  {f.origPath && <span className="text-zinc-500">{f.origPath} → </span>}
                  {f.path}
                </button>
                {typeof f.additions === 'number' && <span className="shrink-0 text-emerald-500">+{f.additions}</span>}
                {typeof f.deletions === 'number' && <span className="shrink-0 text-red-400">−{f.deletions}</span>}
                {pendingKey === `resolve:${f.path}` || pendingKey === `stage:${f.path}` ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                ) : f.conflict ? (
                  <button
                    className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-emerald-400"
                    title="Mark resolved (git add)"
                    onClick={() => !busy && onAction(f.path, 'resolve')}
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                ) : f.indexStatus === '.' ? (
                  <button
                    className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-emerald-400"
                    title="Stage file"
                    onClick={() => !busy && onAction(f.path, 'stage')}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </button>
                ) : (
                  <button
                    className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-emerald-400"
                    title="Unstage file"
                    onClick={() => !busy && onAction(f.path, 'unstage')}
                  >
                    <Minus className="h-3.5 w-3.5" />
                  </button>
                )}
                {!f.conflict &&
                  (pendingKey === `discard:${f.path}` ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
                  ) : (
                    <button
                      className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-red-400"
                      title="Discard changes"
                      onClick={() => !busy && onAction(f.path, 'discard')}
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  ))}
              </div>
              {openDiffs.has(f.path) && (
                <div className="mt-1.5">
                  <InlineDiff path={path} file={f.path} staged={f.indexStatus !== '.'} onClose={() => toggleDiff(f.path)} />
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function InlineDiff({
  path,
  file,
  staged,
  onClose,
}: {
  path: string
  file: string
  staged: boolean
  onClose: () => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['worktree-diff', path, file, staged],
    queryFn: () => api.worktreeDiff(path, file, staged),
  })
  return (
    <div className="rounded-lg border border-zinc-800/60 p-1">
      <div className="flex justify-end px-1 pb-1">
        <button className="text-[10px] text-zinc-500 hover:text-zinc-300" onClick={onClose}>
          close diff
        </button>
      </div>
      {isLoading ? <p className="px-2 py-1 text-xs text-zinc-500">loading…</p> : <DiffView diff={data ?? ''} />}
    </div>
  )
}
