import { useState } from 'react'
import { Upload, Trash2, Pencil, GitBranch, Tag as TagIcon, CornerUpLeft, FileText, Loader2, ArrowUpFromLine, Undo2, GitCommitVertical } from 'lucide-react'
import { api, pollOp, GitRequestError } from '../../lib/client'
import type { RefInfo } from '../../lib/types'
import { useUiStore, type SelectedRef } from '../../state/uiStore'
import { friendlyError } from '../../lib/gitErrors'

/**
 * Contextual actions for what the user clicked — a branch/tag/remote ref or
 * the commit node itself — rendered inside the floating popup that GraphView
 * anchors over the selected row. Ref selections show ref actions; node
 * selections show commit actions (Details, create branch/tag).
 */
export interface SelectionActionsProps {
  path: string
  sha: string
  /** refs carried by this commit (remote chips on a plain-node popup, etc.) */
  rowRefs: RefInfo[]
  selectedRef: SelectedRef | null
  remoteBranchNames: string[]
  /** local branch names — a remote checkout whose local exists is a plain checkout */
  localBranchNames: string[]
  currentBranch?: string
  headSha?: string
  onRefresh: () => void
}

export function SelectionActions({
  path,
  sha,
  rowRefs,
  selectedRef,
  remoteBranchNames,
  localBranchNames,
  currentBranch,
  headSha,
  onRefresh,
}: SelectionActionsProps) {
  const toast = useUiStore((s) => s.toast)
  /** spinner on the Push button while its network op runs */
  const [pushing, setPushing] = useState(false)

  // every helper marks the global busy guard: while any repo-altering op
  // runs, the BusyOverlay blocks other actions app-wide
  const run = (fn: () => Promise<unknown>) => {
    useUiStore.getState().beginOp('Working')
    fn()
      .then(() => onRefresh())
      .catch((e: unknown) => {
        const { title, detail } = friendlyError(e)
        toast({ kind: 'error', title, detail })
        onRefresh()
      })
      .finally(() => useUiStore.getState().endOp())
  }

  /** Immediate rebase/revert-style op: conflicts pause the operation (they
   *  surface via the staging banner), so a conflicted run is info, not error */
  const runWithConflicts = (fn: () => Promise<unknown>, done: string, gerund: string): Promise<unknown> => {
    useUiStore.getState().beginOp(gerund)
    return fn()
      .then(() => toast({ kind: 'success', title: done }))
      .catch((e: unknown) => {
        const { title, detail } = friendlyError(e)
        if (/conflict/i.test(`${title} ${detail ?? ''}`)) {
          toast({ kind: 'info', title: `${gerund} paused — resolve conflicts in the staging area` })
        } else {
          toast({ kind: 'error', title, detail })
        }
      })
      .finally(() => {
        onRefresh()
        useUiStore.getState().endOp()
      })
  }

  /** like run(), but returns the settled promise so an AppDialog onConfirm
   *  keeps the modal open with a spinner until the op finishes */
  const runAsync = (fn: () => Promise<unknown>): Promise<unknown> => {
    useUiStore.getState().beginOp('Working')
    return fn()
      .then(() => onRefresh())
      .catch((e: unknown) => {
        const { title, detail } = friendlyError(e)
        toast({ kind: 'error', title, detail })
        onRefresh()
      })
      .finally(() => useUiStore.getState().endOp())
  }

  /** dialog variant of run(): REJECTS on failure so AppDialog keeps the
   *  modal open and shows the error inline — the user fixes the input
   *  (name taken, protected ref) instead of retyping it after a toast */
  const runInDialog = (fn: () => Promise<unknown>): Promise<unknown> => {
    useUiStore.getState().beginOp('Working')
    return fn()
      .then(() => onRefresh())
      .finally(() => useUiStore.getState().endOp())
  }

  /** remote branch → local: plain checkout when that local branch already
   *  exists (checkout -b would fail with "already exists"), tracking
   *  create-and-checkout otherwise */
  const checkoutRemote = (local: string, remote: string) =>
    localBranchNames.includes(local) ? api.checkout(path, local) : api.checkout(path, local, remote)

  /** Push with busy state, error toasts, and a force-push offer on non-fast-forward. */
  const runPush = (remote: string, refspec: string) => {
    // returns the settled promise so dialog onConfirms keep their spinner up
    const attempt = (force: boolean) => {
      useUiStore.getState().beginOp('Push')
      useUiStore.getState().setNetBusy('Push')
      setPushing(true)
      return pollOpAfter(api.push(path, remote, refspec, force))
    }
    const pollOpAfter = (started: Promise<{ opId: string }>) =>
      started
        .then(({ opId }) => pollOp(opId))
        .then(() => toast({ kind: 'success', title: 'Push complete' }))
        .catch((e: unknown) => {
          if (e instanceof GitRequestError && e.code === 'non-fast-forward' && !refspec.includes('refs/tags/')) {
            useUiStore.getState().setDialog({
              kind: 'confirm',
              danger: true,
              title: 'Push rejected — remote has diverged',
              message:
                'The remote branch has commits this branch does not.\n\nForce push overwrites the remote with your branch. It uses --force-with-lease, which refuses if the remote moved since the last fetch.',
              confirmLabel: 'Force push',
              onConfirm: () => attempt(true),
            })
          } else {
            const { title, detail } = friendlyError(e)
            toast({ kind: 'error', title, detail })
          }
        })
        .finally(() => {
          useUiStore.getState().setNetBusy(null)
          useUiStore.getState().endOp()
          setPushing(false)
          onRefresh()
        })
    return attempt(false)
  }

  const openDetails = () => useUiStore.getState().setDetailsSha(sha)
  // the selected ref, resolved against the commit's actual refs (guards ref renames/moves)
  const selBranch =
    selectedRef?.kind === 'branch'
      ? rowRefs.find((r) => r.type === 'branch' && r.name === selectedRef.name)
      : undefined
  const selTag =
    selectedRef?.kind === 'tag' ? rowRefs.find((r) => r.type === 'tag' && r.name === selectedRef.name) : undefined
  const selRemote =
    selectedRef?.kind === 'remote-branch'
      ? rowRefs.find((r) => r.type === 'remote-branch' && r.name === selectedRef.name)
      : undefined
  const isCurrent = selBranch?.name === currentBranch
  // local branch and its origin/ counterpart on the same commit → nothing to push
  const inSync =
    !!selBranch && rowRefs.some((r) => r.type === 'remote-branch' && r.name.endsWith('/' + selBranch.name))
  const btn = 'flex items-center gap-1 rounded-md px-2 py-1 text-xs'

  return (
    <>
      <button
        className={`${btn} bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25`}
        title="Show commit details in the side drawer (author, files, diffs)"
        onClick={openDetails}
        data-testid="details-button"
      >
        <FileText className="h-3.5 w-3.5" /> Details
      </button>

      {/* plain node: create branch / create tag */}
      {!selBranch && !selTag && !selRemote && (
        <>
          {rowRefs.some((r) => r.type === 'remote-branch') && (
            <button
              className={`${btn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}
              onClick={() => {
                const rb = rowRefs.find((r) => r.type === 'remote-branch')!
                const remote = rb.name.split('/')[0]
                const local = rb.name.slice(remote.length + 1)
                if (localBranchNames.includes(local)) {
                  run(() => checkoutRemote(local, remote))
                  return
                }
                useUiStore.getState().setDialog({
                  kind: 'confirm',
                  title: 'Checkout remote branch',
                  message: `Create local branch "${local}" tracking ${rb.name} and check it out?`,
                  confirmLabel: 'Checkout',
                  onConfirm: () => run(() => checkoutRemote(local, remote)),
                })
              }}
            >
              <CornerUpLeft className="h-3.5 w-3.5" /> Checkout remote
            </button>
          )}
          <button
            className={`${btn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}
            onClick={() => {
              useUiStore.getState().setDialog({
                kind: 'prompt',
                title: 'New branch at this commit',
                initial: '',
                confirmLabel: 'Create',
                note: 'Runs git branch <name> <sha> — the branch is created here without checking it out. Use its [Checkout] action to switch to it.',
                onConfirm: (name) => runInDialog(() => api.branchCreate(path, name, sha)),
              })
            }}
          >
            <GitBranch className="h-3.5 w-3.5" /> Branch
          </button>
          <button
            className={`${btn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}
            onClick={() => {
              useUiStore.getState().setDialog({
                kind: 'prompt',
                title: 'New tag at this commit',
                initial: '',
                confirmLabel: 'Create',
                onConfirm: (name) => runInDialog(() => api.tagCreate(path, name, sha)),
              })
            }}
          >
            <TagIcon className="h-3.5 w-3.5" /> Tag
          </button>
          {/* commit-level actions (GitUp-style commit bar): immediate — each
           * creates a new commit on the current branch (hover previews the
           * ghost node above HEAD); conflicts pause in the staging area.
           * Neither is offered on the HEAD commit itself: cherry-picking it
           * onto its own branch is a no-op, reverting it is Uncommit. */}
          {currentBranch && headSha !== sha && (
            <>
              <button
                className={`${btn} bg-violet-500/15 text-violet-300 hover:bg-violet-500/25`}
                title={`Cherry-pick ${sha.slice(0, 7)} onto "${currentBranch}" — a new commit with the same changes`}
                data-ghost-preview={headSha}
                onClick={() => void runWithConflicts(() => api.cherryPick(path, sha), `Cherry-picked ${sha.slice(0, 7)} onto ${currentBranch}`, 'Cherry-pick')}
              >
                <GitCommitVertical className="h-3.5 w-3.5" /> Cherry-pick
              </button>
              <button
                className={`${btn} bg-amber-500/15 text-amber-300 hover:bg-amber-500/25`}
                title={`Revert ${sha.slice(0, 7)} on "${currentBranch}" — creates a new commit undoing its changes`}
                data-ghost-preview={headSha}
                onClick={() => void runWithConflicts(() => api.revert(path, sha), `Reverted ${sha.slice(0, 7)}`, 'Revert')}
              >
                <Undo2 className="h-3.5 w-3.5" /> Revert
              </button>
            </>
          )}
        </>
      )}

      {/* branch actions */}
      {selBranch && (
        <>
          {/* the graph's only push entry point (topbar/panel push removed):
              offered for every branch except when origin/<branch> already
              points at this same commit — then there is nothing to push */}
          {!inSync && (
            <button
              className={`${btn} bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 disabled:opacity-50`}
              title={`Push ${selBranch.name} to ${remoteBranchNames[0]?.split('/')[0] ?? 'origin'}`}
              disabled={pushing}
              onClick={() => runPush(remoteBranchNames[0]?.split('/')[0] ?? 'origin', selBranch.name)}
            >
              {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Push
            </button>
          )}
          {!isCurrent && (
            <button
              className={`${btn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}
              title={`Checkout ${selBranch.name}`}
              onClick={() => run(() => api.checkout(path, selBranch.name))}
            >
              <CornerUpLeft className="h-3.5 w-3.5" /> Checkout
            </button>
          )}
          {!isCurrent && currentBranch && (
            <button
              className={`${btn} bg-violet-500/15 text-violet-300 hover:bg-violet-500/25`}
              title={`Rebase "${currentBranch}" (the checked-out branch) onto ${selBranch.name} — its commits are replayed after ${selBranch.name}'s tip`}
              data-ghost-preview={sha}
              onClick={() => void runWithConflicts(() => api.rebaseStart(path, selBranch.name), `Rebased ${currentBranch} onto ${selBranch.name}`, 'Rebase')}
            >
              <ArrowUpFromLine className="h-3.5 w-3.5" /> Rebase
            </button>
          )}
          {/* Squash/Move targets live on the graph rows now: selecting this
           * chip armed them — [squash]/[rebase]/[<- move] buttons + hover
           * previews (the popup round-trip is gone) */}
          {isCurrent && headSha === sha && (
            <button
              className={`${btn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}
              title="Drop the last commit, keep its changes"
              onClick={() => {
                useUiStore.getState().setDialog({
                  kind: 'confirm',
                  title: `Uncommit from "${selBranch.name}"`,
                  message: 'Drops the last commit; its changes return to the staging area.',
                  confirmLabel: 'Uncommit',
                  onConfirm: () => run(() => api.uncommit(path)),
                })
              }}
            >
              <CornerUpLeft className="h-3.5 w-3.5" /> Uncommit
            </button>
          )}
          <button
            className={`${btn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}
            title="Rename local branch (new ref at the same commit, old one deleted)"
            onClick={() => {
              useUiStore.getState().setDialog({
                kind: 'prompt',
                title: `Rename branch "${selBranch.name}"`,
                initial: selBranch.name,
                confirmLabel: 'Rename',
                note: 'Creates a new branch at the same commit and deletes the old one. Local only.',
                onConfirm: (newName) => {
                  if (newName !== selBranch.name) return runInDialog(() => api.branchRename(path, selBranch.name, newName))
                },
              })
            }}
          >
            <Pencil className="h-3.5 w-3.5" /> Rename
          </button>
          {!isCurrent && (
            <button
              className={`${btn} bg-red-500/15 text-red-300 hover:bg-red-500/25`}
              title={`Delete ${selBranch.name} — commits unique to it may be dropped`}
              onClick={() => {
                useUiStore.getState().setDialog({
                  kind: 'confirm',
                  title: `Delete branch "${selBranch.name}"`,
                  message: 'Commits unique to this branch will become unreachable (they disappear from the graph).',
                  confirmLabel: 'Delete',
                  danger: true,
                  onConfirm: () => run(() => api.branchDelete(path, selBranch.name, true)),
                })
              }}
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete
            </button>
          )}
        </>
      )}

      {/* remote branch actions (origin/x chip selected) */}
      {selRemote && !selBranch && !selTag && (
        <>
          {/* checkout only when it would do something: hidden when the local
           *  branch it resolves to is the one already checked out */}
          {selRemote.name.slice(selRemote.name.indexOf('/') + 1) !== currentBranch && (
            <button
              className={`${btn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}
              title={
                localBranchNames.includes(selRemote.name.slice(selRemote.name.indexOf('/') + 1))
                  ? `Check out local branch "${selRemote.name.slice(selRemote.name.indexOf('/') + 1)}"`
                  : `Create local branch "${selRemote.name.split('/').slice(1).join('/')}" tracking ${selRemote.name} and check it out`
              }
              onClick={() => {
                const remote = selRemote.name.split('/')[0]
                const local = selRemote.name.slice(remote.length + 1)
                // local branch exists → plain switch, immediate (same as a local
                // chip's double-click); only the create-tracking case confirms
                if (localBranchNames.includes(local)) {
                  run(() => checkoutRemote(local, remote))
                  return
                }
                useUiStore.getState().setDialog({
                  kind: 'confirm',
                  title: 'Checkout remote branch',
                  message: `Create local branch "${local}" tracking ${selRemote.name} and check it out?`,
                  confirmLabel: 'Checkout',
                  // returns the promise → the dialog spins until the checkout lands
                  onConfirm: () => runAsync(() => checkoutRemote(local, remote)),
                })
              }}
            >
              <CornerUpLeft className="h-3.5 w-3.5" /> Checkout
            </button>
          )}
          {currentBranch && (
            <button
              className={`${btn} bg-violet-500/15 text-violet-300 hover:bg-violet-500/25`}
              title={`Rebase "${currentBranch}" (the checked-out branch) onto ${selRemote.name}`}
              data-ghost-preview={sha}
              onClick={() => void runWithConflicts(() => api.rebaseStart(path, selRemote.name), `Rebased ${currentBranch} onto ${selRemote.name}`, 'Rebase')}
            >
              <ArrowUpFromLine className="h-3.5 w-3.5" /> Rebase
            </button>
          )}
          <button
            className={`${btn} bg-red-500/15 text-red-300 hover:bg-red-500/25`}
            title={`Delete ${selRemote.name} on the remote — git push <remote> --delete <branch>. Any local branch tracking it stays.`}
            disabled={pushing}
            onClick={() => {
              const remote = selRemote.name.split('/')[0]
              const local = selRemote.name.slice(remote.length + 1)
              useUiStore.getState().setDialog({
                kind: 'confirm',
                danger: true,
                title: `Delete ${selRemote.name}`,
                message:
                  `Deletes the branch on the remote — git push ${remote} --delete ${local}.\n\n` +
                  'Local branches (tracking or not) are untouched; commits unique to the remote branch become unreachable there. The remote refuses if this is its default branch.',
                confirmLabel: 'Delete',
                // returns the runPush promise → the dialog spins until the push settles
                onConfirm: () => runPush(remote, `:refs/heads/${local}`),
              })
            }}
          >
            {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />} Delete
          </button>
          {/* remote Move targets live on the graph rows (armed remote chip) */}
        </>
      )}

      {/* tag actions */}
      {selTag && !selBranch && (
        <>
          <button
            className={`${btn} bg-sky-500/15 text-sky-300 hover:bg-sky-500/25 disabled:opacity-50`}
            title={`Push tag ${selTag.name}`}
            disabled={pushing}
            onClick={() =>
              runPush(remoteBranchNames[0]?.split('/')[0] ?? 'origin', `refs/tags/${selTag.name}:refs/tags/${selTag.name}`)
            }
          >
            {pushing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Push tag
          </button>
          <button
            className={`${btn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}
            title={`Checkout ${selTag.name} (detached HEAD)`}
            onClick={() => run(() => api.checkout(path, selTag.name))}
          >
            <CornerUpLeft className="h-3.5 w-3.5" /> Checkout
          </button>
          <button
            className={`${btn} bg-zinc-800 text-zinc-200 hover:bg-zinc-700`}
            title="Rename tag (new ref at the same commit, old one deleted)"
            onClick={() => {
              useUiStore.getState().setDialog({
                kind: 'prompt',
                title: `Rename tag "${selTag.name}"`,
                initial: selTag.name,
                confirmLabel: 'Rename',
                note: 'Creates a new tag at the same commit and deletes the old one.',
                onConfirm: (newName) => {
                  if (newName !== selTag.name) return runInDialog(() => api.tagRename(path, selTag.name, newName))
                },
              })
            }}
          >
            <Pencil className="h-3.5 w-3.5" /> Rename
          </button>
          <button
            className={`${btn} bg-red-500/15 text-red-300 hover:bg-red-500/25`}
            title={`Delete tag ${selTag.name}`}
            onClick={() => {
              useUiStore.getState().setDialog({
                kind: 'confirm',
                title: `Delete tag "${selTag.name}"`,
                confirmLabel: 'Delete',
                danger: true,
                onConfirm: () => run(() => api.tagDelete(path, selTag.name)),
              })
            }}
          >
            <Trash2 className="h-3.5 w-3.5" /> Delete
          </button>
        </>
      )}
    </>
  )
}
