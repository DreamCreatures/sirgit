import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, GitBranch, RefreshCw, CloudDownload, Download, Loader2 } from 'lucide-react'
import { api, pollOp } from '../../lib/client'
import { useRefs, useStatus, useConfig } from '../../api/hooks'
import { useRepoEvents } from '../../lib/ws'
import { useGraphStore } from '../../state/graphStore'
import { useUiStore, type SelectedRef } from '../../state/uiStore'
import { friendlyError } from '../../lib/gitErrors'
import GraphView from '../graph/GraphView'
import RefsPanel from '../refs/RefsPanel'
import StagingPanel from '../staging/StagingPanel'
import { SelectionActions } from '../graph/SelectionActions'
import SquashModal from '../graph/SquashModal'
import CommitDetail from '../commit/CommitDetail'

/**
 * The repository screen: refs panel + staging + virtualized graph, all live
 * via one WebSocket (change events → O(delta) graph sync + query invalidation).
 */
export default function RepoPage() {
  const [searchParams] = useSearchParams()
  const path = searchParams.get('path') ?? ''
  const toast = useUiStore((s) => s.toast)
  const qc = useQueryClient()
  const { data: config } = useConfig()
  const netBusy = useUiStore((s) => s.netBusy)
  const busyLabel = useUiStore((s) => (s.busyCount > 0 ? s.busyLabel : null))
  const ghostPreview = useUiStore((s) => s.ghostPreview)
  const selectedSha = useUiStore((s) => s.selectedSha)
  const detailsSha = useUiStore((s) => s.detailsSha)

  const reset = useGraphStore((s) => s.reset)
  const applyDelta = useGraphStore((s) => s.applyDelta)

  const { data: refs } = useRefs(path)
  const { data: statusSnap } = useStatus(path)
  const fetchedOnce = useRef(false)

  // load graph on open / path change
  useEffect(() => {
    if (!path) return
    fetchedOnce.current = false
    useUiStore.getState().select(null)
    useUiStore.getState().clearScrollTo()
    reset(path)
  }, [path, reset])

  // auto-fetch once on open (never on watch events — kills ungit's fetch storms)
  useEffect(() => {
    if (!refs || fetchedOnce.current) return
    fetchedOnce.current = true
    if (config?.autoFetchOnOpen && refs.remotes.length > 0) {
      void api
        .fetch(path)
        .then(({ opId }) => pollOp(opId))
        .then(() => {
          void qc.invalidateQueries({ queryKey: ['refs', path] })
          void applyDelta()
        })
        .catch(() => {
          /* offline is fine on open */
        })
    }
  }, [refs, config, path, qc, applyDelta])

  useRepoEvents(path || null, (ev) => {
    switch (ev.type) {
      case 'changed':
        void applyDelta()
        void qc.invalidateQueries({ queryKey: ['refs', path] })
        void qc.invalidateQueries({ queryKey: ['status', path] })
        void qc.invalidateQueries({ queryKey: ['stash', path] })
        break
      case 'credentials-request':
        useUiStore.getState().setCredentialsRequest({ opId: ev.opId!, remote: ev.remote! })
        break
      case 'op-progress':
        if (ev.done) {
          void qc.invalidateQueries({ queryKey: ['refs', path] })
          void qc.invalidateQueries({ queryKey: ['status', path] })
          void qc.invalidateQueries({ queryKey: ['stash', path] })
          void applyDelta()
        }
        break
    }
  })

  // branch tips drive lane assignment (checked-out branch owns the trunk)
  useEffect(() => {
    if (!refs) return
    useGraphStore.getState().setGraphRefs(
      (refs.branches ?? []).map((b) => ({ sha: b.sha, current: b.name === refs.head?.branch })),
      refs.head?.sha ?? null,
    )
  }, [refs])

  // ref chips by sha for the graph
  const refBySha = useMemo(() => {
    const m = new Map<string, import('../../lib/types').RefInfo[]>()
    const push = (list: import('../../lib/types').RefInfo[] | undefined) => {
      for (const r of list ?? []) {
        const arr = m.get(r.sha) ?? []
        arr.push(r)
        m.set(r.sha, arr)
      }
    }
    push(refs?.branches)
    push(refs?.remoteBranches)
    push(refs?.tags)
    return m
  }, [refs])

  // Header fetch/pull operate on the checked-out branch — push lives on the
  // branch/tag action bar (select a ref chip to push it). Pull is disabled
  // when HEAD is detached: there is no branch to fast-forward.
  const selectedRef = useUiStore((s) => s.selectedRef)
  const selBranch =
    selectedRef?.kind === 'branch'
      ? (refBySha.get(selectedSha ?? '') ?? []).find((r) => r.type === 'branch' && r.name === selectedRef.name)
      : undefined
  const currentBranch = refs?.head?.branch
  const pullBranch = currentBranch ?? null
  // the prospective next commit: something staged, or an in-flight merge /
  // rebase / cherry-pick / revert waiting on conflict resolution → dashed ghost node
  const nextCommit =
    !!statusSnap &&
    (statusSnap.inMerge ||
      statusSnap.inRebase ||
      statusSnap.inCherry ||
      statusSnap.inRevert ||
      statusSnap.files.some((f) => f.indexStatus !== '.' && f.indexStatus !== '?'))

  // hovering any action that would create a commit (Commit, merge/squash merge,
  // Rebase, Revert, …) previews the would-be node as a dashed ghost anchored
  // above the action's TARGET commit — buttons opt in by carrying the target
  // sha in [data-ghost-preview]
  useEffect(() => {
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-ghost-preview]')
      const sha = el?.getAttribute('data-ghost-preview') ?? null
      useUiStore.getState().setGhostPreview(sha && sha.length >= 7 ? sha : null)
    }
    document.addEventListener('mouseover', over)
    return () => document.removeEventListener('mouseover', over)
  }, [])

  // hovering a row action button ([rebase]/[squash]/[<- move]/[merge]) draws
  // the operation preview on the graph — op from the button, target row from
  // [data-sha], subject from the armed selection
  useEffect(() => {
    const over = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.('[data-action-preview]')
      const s = useUiStore.getState()
      if (!el || !s.selectedRef || !s.selectedSha) {
        if (s.actionPreview) s.setActionPreview(null)
        return
      }
      const op = el.getAttribute('data-action-preview')
      const targetSha = el.closest('[data-sha]')?.getAttribute('data-sha')
      if (!op || !targetSha) {
        if (s.actionPreview) s.setActionPreview(null)
        return
      }
      s.setActionPreview({
        op: op as 'move' | 'rebase' | 'squash' | 'merge' | 'squash-merge',
        targetSha,
        subjectTipSha: s.selectedSha,
        subjectBranch: s.selectedRef.name,
      })
    }
    document.addEventListener('mouseover', over)
    return () => document.removeEventListener('mouseover', over)
  }, [])

  const handleNodeClick = (sha: string, ref?: SelectedRef) => {
    useUiStore.getState().select(sha, ref)
    // while the details drawer is open, row clicks navigate it (browsing mode)
    if (useUiStore.getState().detailsSha !== null) {
      useUiStore.getState().setDetailsSha(sha)
    }
  }

  // the armed ref (a selected branch/remote chip): selecting it IS arming —
  // rows grow target buttons, hover previews draw, one click executes
  const armedRef =
    selectedRef && selectedSha
      ? selectedRef.kind === 'remote-branch'
        ? { name: selectedRef.name, tipSha: selectedSha, remote: true }
        : selectedRef.kind === 'branch'
          ? { name: selectedRef.name, tipSha: selectedSha }
          : null
      : null

  /** is `ancestor` reachable from `from` via first parents (loaded window)? */
  const isAncestorOf = (ancestor: string, from: string): boolean => {
    const rows = useGraphStore.getState().rowsBySha
    let cursor: string | undefined = from
    for (let i = 0; i < 500 && cursor; i++) {
      if (cursor === ancestor) return true
      cursor = rows.get(cursor)?.parents[0]
    }
    return false
  }

  /** rebase the checked-out branch onto a commit — immediate (ungit's fluidity):
   *  the hover preview is the confirmation; conflicts pause in the staging area */
  const rebaseOnto = (ontoSha: string) => {
    if (!currentBranch) return
    useUiStore.getState().beginOp('Rebase')
    void api
      .rebaseStart(path, ontoSha)
      .then(() => {
        toast({ kind: 'success', title: `Rebased ${currentBranch} onto ${ontoSha.slice(0, 7)}` })
        refreshAll()
      })
      .catch((e: unknown) => {
        const { title, detail } = friendlyError(e)
        if (/conflict/i.test(`${title} ${detail ?? ''}`)) {
          toast({ kind: 'info', title: 'Rebase paused — resolve conflicts in the staging area' })
        } else {
          toast({ kind: 'error', title, detail })
        }
        refreshAll()
      })
      .finally(() => useUiStore.getState().endOp())
  }

  // one dispatcher for every row action button
  const onRowAction = (action: 'move' | 'rebase' | 'squash' | 'merge' | 'squash-merge', sha: string, intoBranch?: string) => {
    if (!armedRef) return
    if (action === 'move') {
      if (armedRef.remote) moveRemoteRefTo(armedRef.name, sha)
      else moveBranchTo(armedRef.name, sha)
    } else if (action === 'rebase') {
      rebaseOnto(sha)
    } else if (action === 'squash') {
      useUiStore.getState().setSquashModal({ branch: armedRef.name, branchTipSha: armedRef.tipSha, targetSha: sha })
    } else if (intoBranch) {
      mergeInto(intoBranch, action === 'squash-merge')
    }
  }

  // move a branch (row button, or a dragged branch chip). A forward move of
  // a NON-current branch is a pure ref update — immediate, like ungit (the
  // hover preview is the confirmation). Anything that can lose work (moving
  // backward, or the checked-out branch whose reset --hard wipes the
  // worktree) still confirms.
  const moveBranchTo = (branch: string, targetSha: string) => {
    const isCurrent = currentBranch === branch
    const tip = refs?.branches.find((b) => b.name === branch)?.sha
    const forward = !!tip && isAncestorOf(tip, targetSha)
    const run = () => {
      useUiStore.getState().beginOp('Move')
      void api
        .branchMove(path, branch, targetSha)
        .then(() => {
          toast({ kind: 'success', title: `Moved ${branch} to ${targetSha.slice(0, 7)}` })
          refreshAll()
        })
        .catch((e: unknown) => {
          const { title: t, detail: d } = friendlyError(e)
          toast({ kind: 'error', title: t, detail: d })
          refreshAll()
        })
        .finally(() => useUiStore.getState().endOp())
    }
    if (forward && !isCurrent) {
      run()
      return
    }
    useUiStore.getState().setDialog({
      kind: 'confirm',
      danger: true,
      title: `Move branch "${branch}"`,
      message:
        `"${branch}" will point at ${targetSha.slice(0, 7)} — commits unique to it become unreachable (recoverable via reflog).` +
        (isCurrent ? '\n\nIt is the checked-out branch: this runs reset --hard and discards uncommitted changes.' : ''),
      confirmLabel: 'Move',
      onConfirm: run,
    })
  }
  // moving a REMOTE branch (origin/x) = pushing <sha>:<branch> to that remote
  const moveRemoteRefTo = (remoteRef: string, targetSha: string) => {
    const slash = remoteRef.indexOf('/')
    const remote = remoteRef.slice(0, slash)
    const branch = remoteRef.slice(slash + 1)
    useUiStore.getState().setDialog({
      kind: 'confirm',
      title: `Move ${remoteRef} to ${targetSha.slice(0, 7)}`,
      message:
        `Pushes ${targetSha.slice(0, 7)} to "${branch}" on ${remote} — git push ${remote} <sha>:${branch}.\n\n` +
        'The remote rejects non-fast-forward updates, so nothing already published can be lost this way; fetch first if the branch moved.',
      confirmLabel: 'Push',
      // returns the netOp promise → the dialog stays up with a spinner until
      // the push completes (netOp never rejects; it toasts errors itself)
      onConfirm: () =>
        netOp(
          () => api.push(path, remote, `${targetSha}:refs/heads/${branch}`),
          `${remoteRef} moved to ${targetSha.slice(0, 7)}`,
        ),
    })
  }
  // merge the armed branch into another branch (row buttons) — immediate:
  // fast-forwards and merges are recoverable, conflicts surface in the
  // staging area, and the hover preview already showed the merge commit
  const mergeInto = (into: string, squash: boolean) => {
    if (!selBranch) return
    const from = selBranch.name
    useUiStore.getState().beginOp(squash ? 'Squash merge' : 'Merge')
    void api
      .branchMerge(path, from, into, squash)
      .then((res) => {
        if (squash && res?.title) {
          // changes staged + messages gathered server-side: prefill amend-style
          useUiStore.getState().setCommitPrefill({ title: res.title, body: res.body ?? '' })
          toast({ kind: 'info', title: `Squash-merged ${from} into ${into} — message prefilled, review and commit` })
        } else if (squash) {
          toast({ kind: 'info', title: `Squash-merged ${from} into ${into} — changes staged, write one commit` })
        } else {
          toast({ kind: 'success', title: `Merged ${from} into ${into}` })
        }
        refreshAll()
      })
      .catch((e: unknown) => {
        const { title: t, detail: d } = friendlyError(e)
        toast({ kind: 'error', title: t, detail: d })
        refreshAll()
      })
      .finally(() => useUiStore.getState().endOp())
  }

  // Esc disarms: closes the action popup / selection (dialogs and modals
  // dismiss themselves first)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const s = useUiStore.getState()
      if (s.dialog || s.squashModal) return
      if (s.selectedSha !== null) s.select(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // details drawer: outside click (not drawer, not rows) closes it and the selection
  useEffect(() => {
    if (!detailsSha) return
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('[data-testid="commit-drawer"]')) return
      if (t.closest('[data-testid="graph-node"]') || t.closest('[data-testid="graph-ref-chip"]')) return
      if (t.closest('[data-testid="selection-popup"]')) return
      if (t.closest('[data-action-preview]')) return
      if (t.closest('[data-testid="app-dialog"]')) return
      useUiStore.getState().setDetailsSha(null)
      useUiStore.getState().select(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [detailsSha])

  const refreshAll = () => {
    void qc.invalidateQueries({ queryKey: ['refs', path] })
    void qc.invalidateQueries({ queryKey: ['status', path] })
    void qc.invalidateQueries({ queryKey: ['stash', path] })
    void applyDelta()
  }

  const netOp = async (fn: () => Promise<{ opId: string }>, done: string) => {
    const label = done.replace(' complete', '')
    useUiStore.getState().beginOp(label)
    useUiStore.getState().setNetBusy(label)
    try {
      const { opId } = await fn()
      await pollOp(opId)
      toast({ kind: 'success', title: done })
      void qc.invalidateQueries({ queryKey: ['refs', path] })
      void qc.invalidateQueries({ queryKey: ['status', path] })
      void qc.invalidateQueries({ queryKey: ['stash', path] })
      void applyDelta()
    } catch (e) {
      const { title, detail } = friendlyError(e)
      toast({ kind: 'error', title, detail })
    } finally {
      useUiStore.getState().setNetBusy(null)
      useUiStore.getState().endOp()
    }
  }

  // double-click checkout on branch chips (same op as the action-bar button)
  const checkoutBranch = (name: string) => {
    useUiStore.getState().beginOp('Checkout')
    void api
      .checkout(path, name)
      .then(() => {
        toast({ kind: 'success', title: `Checked out ${name}` })
        // bring the new HEAD into view — the tip may sit far off-screen
        const sha =
          refs?.branches.find((b) => b.name === name)?.sha ?? refs?.tags.find((t) => t.name === name)?.sha
        if (sha) useUiStore.getState().requestScrollTo(sha)
        refreshAll()
      })
      .catch((e: unknown) => {
        const { title, detail } = friendlyError(e)
        toast({ kind: 'error', title, detail })
        refreshAll()
      })
      .finally(() => useUiStore.getState().endOp())
  }

  const repoName = path.split('/').filter(Boolean).pop() ?? path

  return (
    <div className="flex h-full flex-col">
      {/* header */}
      <header className="flex h-12 shrink-0 items-center gap-3 border-b border-zinc-800 bg-zinc-900/60 px-4">
        <Link to="/" className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200" title="Back to repositories">
          <ArrowLeft className="h-4 w-4" />
        </Link>
        <span className="font-medium text-zinc-100">{repoName}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-zinc-600">{path}</span>

        {refs?.head?.branch && (
          <span className="flex items-center gap-1 rounded-md bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-300">
            <GitBranch className="h-3 w-3" /> {refs.head.branch}
            {refs.upstream && (refs.ahead > 0 || refs.behind > 0) && (
              <span className="text-emerald-500/80">
                {refs.ahead > 0 && ` ↑${refs.ahead}`}
                {refs.behind > 0 && ` ↓${refs.behind}`}
              </span>
            )}
          </span>
        )}
        {refs?.head?.detached && (
          <span className="rounded-md bg-amber-400/10 px-2 py-0.5 text-xs text-amber-300">
            detached at {refs.head.sha?.slice(0, 7)}
          </span>
        )}

        {(netBusy || busyLabel) && (
          <span
            className="flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-xs text-emerald-300"
            aria-live="polite"
            data-testid="net-status"
          >
            <Loader2 className="h-3 w-3 animate-spin" /> {netBusy ?? busyLabel}…
          </span>
        )}

        <div className="flex items-center gap-1">
          <HeaderButton
            icon={<CloudDownload className="h-3.5 w-3.5" />}
            label="Fetch"
            busy={netBusy === 'Fetch'}
            disabled={!!netBusy}
            onClick={() => void netOp(() => api.fetch(path), 'Fetch complete')}
            testid="fetch-button"
          />
          <HeaderButton
            icon={<Download className="h-3.5 w-3.5" />}
            label="Pull"
            title={pullBranch ? `Pull the current branch (${pullBranch})` : 'No checked-out branch to pull (detached HEAD)'}
            busy={netBusy === 'Pull'}
            disabled={!!netBusy || !pullBranch}
            onClick={() => {
              if (!pullBranch) return
              void netOp(() => api.pull(path, pullBranch), 'Pull complete')
            }}
          />
          <HeaderButton
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            label="Refresh"
            busy={!!netBusy}
            disabled={!!netBusy}
            onClick={() => {
              void qc.invalidateQueries({ queryKey: ['refs', path] })
              void qc.invalidateQueries({ queryKey: ['status', path] })
              void applyDelta()
            }}
          />
        </div>
      </header>

      {/* body — commit drawer is an absolute overlay anchored here, so the graph keeps its full width */}
      <div className="relative flex min-h-0 flex-1">
        <RefsPanel path={path} />
        <main className="flex min-w-0 flex-1 flex-col">
          <StagingPanel path={path} headSha={refs?.head?.sha} headBranch={currentBranch} />
          <div className="relative min-h-0 flex-1">
            <GraphView
              refBySha={refBySha}
          remoteTags={refs?.remoteTags ?? []}
              headSha={refs?.head?.sha ?? null}
              nextCommit={nextCommit}
              ghostTarget={ghostPreview}
              currentBranch={currentBranch}
              selectedRef={selectedRef}
              onNodeClick={handleNodeClick}
              onCheckout={checkoutBranch}
              armedRef={armedRef}
              onRowAction={onRowAction}
              onMoveBranch={moveBranchTo}
              renderActions={(sha) => (
                <SelectionActions
                  path={path}
                  sha={sha}
                  rowRefs={refBySha.get(sha) ?? []}
                  selectedRef={selectedRef}
                  remoteBranchNames={refs?.remoteBranches.map((r) => r.name) ?? []}
                  localBranchNames={refs?.branches.map((b) => b.name) ?? []}
                  currentBranch={currentBranch}
                  headSha={refs?.head?.sha}
                  onRefresh={refreshAll}
                />
              )}
            />
          </div>
        </main>
        <CommitDetail path={path} />
      </div>

      <SquashModal path={path} rowsBySha={useGraphStore.getState().rowsBySha} currentBranch={currentBranch} onDone={refreshAll} />
    </div>
  )
}

function HeaderButton({
  icon,
  label,
  onClick,
  busy,
  disabled,
  title,
  testid,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  busy?: boolean
  disabled?: boolean
  title?: string
  testid?: string
}) {
  return (
    <button
      className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs ${
        disabled
          ? 'cursor-not-allowed bg-zinc-800/60 text-zinc-500'
          : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
      }`}
      onClick={() => !disabled && onClick()}
      data-testid={testid}
      aria-busy={busy || undefined}
      title={title}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : icon}
      {label}
    </button>
  )
}