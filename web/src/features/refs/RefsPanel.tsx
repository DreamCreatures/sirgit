import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GitBranch, GitMerge, Tag, Globe, Plus, Trash2, ChevronDown, ChevronRight, Loader2, Pencil } from 'lucide-react'
import { api, pollOp } from '../../lib/client'
import Resizer from '../../ui/Resizer'
import { useRefs } from '../../api/hooks'
import { useGraphStore } from '../../state/graphStore'
import { useUiStore } from '../../state/uiStore'
import { friendlyError } from '../../lib/gitErrors'

/**
 * Left panel: branches, remote branches, tags — with checkout, delete,
 * create-branch/tag, remote management, and per-remote fetch (click a remote
 * row). Repo-wide Fetch/Pull live in the top header only. The panel header
 * carries the branch-list filter (all | track | untrack | recent) — SIDEBAR-ONLY:
 * the graph map always shows every branch.
 */
export default function RefsPanel({
  path,
  onCheckout,
}: {
  path: string
  /** guarded checkout (RepoPage): a dirty worktree asks bring/stash first */
  onCheckout: (name: string, trackFrom?: string) => void
}) {
  const width = useUiStore((s2) => s2.refsPanelWidth)
  const collapsed = useUiStore((s2) => s2.refsPanelCollapsed)
  const setWidth = useUiStore((s2) => s2.setRefsPanelWidth)
  const setCollapsed = useUiStore((s2) => s2.setRefsPanelCollapsed)
  const branchFilter = useUiStore((s2) => s2.branchFilter)
  const setBranchFilter = useUiStore((s2) => s2.setBranchFilter)
  // tip dates for the "recent" filter — tips of live branches are always in
  // the loaded window; a branch whose tip row isn't loaded is old by
  // definition, so missing reads as not-recent
  const rowsBySha = useGraphStore((s2) => s2.rowsBySha)
  const { data, isError: refsError } = useRefs(path)
  const toast = useUiStore((s) => s.toast)
  const qc = useQueryClient()

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['refs', path] })
  }

  const opMut = useMutation({
    mutationFn: async (fn: () => Promise<unknown>) => {
      useUiStore.getState().beginOp('Working')
      try {
        return await fn()
      } finally {
        useUiStore.getState().endOp()
      }
    },
    onSuccess: invalidate,
    onError: (e: unknown) => {
      const { title, detail } = friendlyError(e)
      toast({ kind: 'error', title, detail })
    },
  })
  const refOpBusy = opMut.isPending

  /** rename-prompt runner: rejects on failure (AppDialog shows the error
   * inline) and marks the global busy guard; refreshes on success */
  const dialogOp = (fn: () => Promise<unknown>): Promise<unknown> => {
    useUiStore.getState().beginOp('Working')
    return fn().then(invalidate).finally(() => useUiStore.getState().endOp())
  }

  /** net-op core: busy guard + netBusy around fn + op polling — shared by the
   *  dialog runner (below) and the sidebar's netMut; callers layer their own
   *  invalidate/toast/dialog handling on the settled promise */
  const runNetOp = async (fn: () => Promise<{ opId: string }>, label: string) => {
    useUiStore.getState().beginOp(label)
    useUiStore.getState().setNetBusy(label)
    try {
      const { opId } = await fn()
      await pollOp(opId)
    } finally {
      useUiStore.getState().setNetBusy(null)
      useUiStore.getState().endOp()
    }
  }

  /** network-op runner for dialog onConfirms (remote-branch delete): returns
   * the SETTLED promise so the dialog keeps its spinner until the push lands;
   * failure rejects → AppDialog shows it inline (no duplicate toast) */
  const netDialogOp = (fn: () => Promise<{ opId: string }>, label: string): Promise<unknown> =>
    runNetOp(fn, label).then(invalidate)

  const netMut = useMutation({
    mutationFn: ({ fn, label }: { fn: () => Promise<{ opId: string }>; label: string }) => runNetOp(fn, label),
    onSuccess: () => {
      toast({ kind: 'success', title: 'Remote operation completed' })
      invalidate()
    },
    onError: (e: unknown) => {
      const { title, detail } = friendlyError(e)
      toast({ kind: 'error', title, detail })
      invalidate()
    },
  })
  const netBusy = useUiStore((s2) => s2.netBusy)

  if (collapsed) {
    return (
      <button
        className="flex w-8 shrink-0 flex-col items-center justify-center border-r border-zinc-800 bg-zinc-900/30 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300"
        onClick={() => setCollapsed(false)}
        title="Show branches panel"
        data-testid="refs-panel-expand"
      >
        <span className="rotate-90 text-[10px] font-medium tracking-widest">refs</span>
      </button>
    )
  }

  if (!data) {
    // a failed fetch (moved/deleted repo) must not hang on "loading refs…"
    return (
      <aside className="relative flex w-64 shrink-0 flex-col items-center justify-center gap-3 border-r border-zinc-800 bg-zinc-900/30 px-3 text-center text-xs">
        <Resizer side="left" currentWidth={width} onResize={setWidth} />
        {refsError ? (
          <>
            <p className="text-red-300">Can’t read refs — the repository may be missing or moved.</p>
            <a
              href="/"
              className="rounded-md bg-zinc-800 px-3 py-1.5 text-zinc-200 hover:bg-zinc-700"
              data-testid="refs-error-back"
            >
              Back to repositories
            </a>
          </>
        ) : (
          'loading refs…'
        )}
      </aside>
    )
  }

  const branches = data.branches ?? []
  const remoteBranches = data?.remoteBranches ?? []
  const tags = data?.tags ?? []
  const remotes = data?.remotes ?? []
  const head = data?.head

  /**
   * Section ordering (user rule: "selected on top" = HEAD, not map
   * selection): the pinned ref floats to the top — the checked-out branch
   * in Branches, its <remote>/<current> twin in Remote branches — and the
   * rest sort by tip date, latest first (an unloaded tip reads as ancient
   * and sorts last; date ties fall back to name). Tags have no HEAD — pure
   * date order. Remotes are just names — no dates, they stay alphabetical.
   */
  const pinAndSort = <T extends { name: string; sha: string }>(list: T[], isPinned: (r: T) => boolean): T[] =>
    [...list].sort((a, b) => {
      const aPin = isPinned(a) ? 1 : 0
      const bPin = isPinned(b) ? 1 : 0
      if (aPin !== bPin) return bPin - aPin
      const da = rowsBySha.get(a.sha)?.commitDate ?? 0
      const db = rowsBySha.get(b.sha)?.commitDate ?? 0
      if (da !== db) return db - da
      return a.name.localeCompare(b.name)
    })

  // sidebar-only branch filter — a cleanup tool: track = local branches with
  // an upstream or a <remote>/<name> twin (delete once their remote merged);
  // untrack = created locally, never pushed (review and prune). recent = the
  // branches CHECKED OUT most recently (HEAD reflog, still existing, capped
  // 10) — where you switched to, not which branch got new commits. The
  // checked-out branch is always listed and pinned on top.
  const RECENT_MAX = 10
  const isTracked = (b: (typeof branches)[number]) =>
    b.upstream != null || remoteBranches.some((r) => r.name.endsWith(`/${b.name}`))
  const visibleBranches =
    branchFilter === 'recent'
      ? (() => {
          const recentIdx = new Map((data.recentBranches ?? []).map((n, i) => [n, i]))
          const kept = branches
            .filter((b) => b.name === head?.branch || recentIdx.has(b.name))
            // -1 floats HEAD first even when no reflog names it (fresh clone)
            .sort((a, b) => (recentIdx.get(a.name) ?? -1) - (recentIdx.get(b.name) ?? -1))
          return kept.slice(0, RECENT_MAX)
        })()
      : pinAndSort(
          branches.filter((b) => {
            if (branchFilter === 'all') return true
            if (b.name === head?.branch) return true
            return branchFilter === 'track' ? isTracked(b) : !isTracked(b)
          }),
          (b) => b.name === head?.branch,
        )
  const sortedRemoteBranches = pinAndSort(
    remoteBranches,
    (r) => !!head?.branch && r.name.endsWith(`/${head.branch}`),
  )
  const sortedTags = pinAndSort(tags, () => false)
  const branchCountLabel =
    visibleBranches.length === branches.length
      ? `${branches.length}`
      : `${visibleBranches.length}/${branches.length}`

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/30 text-sm"
      style={{ width }}
    >
      <Resizer side="left" currentWidth={width} onResize={setWidth} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
      {/* header: the branch-list filter + collapse. The old Fetch/Pull
       * buttons here duplicated the top header's (same testid twice) — the
       * header ones are canonical now; per-remote fetch is a remote-row click */}
      <div className="mb-3 flex items-center gap-1.5">
        <div className="flex overflow-hidden rounded-md border border-zinc-700/80" data-testid="branch-filter">
          {(
            [
              ['all', 'All', 'All local branches'],
              ['track', 'Track', 'Local branches with an upstream or a remote twin (<remote>/<branch>)'],
              ['untrack', 'Untrack', 'Local branches with no upstream and no remote twin — created locally, never pushed'],
              ['recent', 'Recent', 'The last 10 branches you checked out (still existing)'],
            ] as const
          ).map(([value, label, title]) => (
            <button
              key={value}
              className={`px-2 py-1 text-[11px] leading-none ${
                branchFilter === value
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
              }`}
              onClick={() => setBranchFilter(value)}
              title={title}
              data-testid={`branch-filter-${value}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          className="ml-auto rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
          onClick={() => setCollapsed(true)}
          title="Collapse the refs panel"
          data-testid="refs-panel-collapse"
        >
          ⟨
        </button>
      </div>

      <Section title={`Branches (${branchCountLabel})`}>
        {visibleBranches.map((b) => (
          <RefRow
            key={b.name}
            icon={<GitBranch className="h-3.5 w-3.5" />}
            name={b.name}
            current={head?.branch === b.name}
            sha={b.sha}
            refKind="branch"
            disabled={refOpBusy}
            onClick={() => useUiStore.getState().select(b.sha, { kind: 'branch', name: b.name })}
            onDoubleClick={() => {
              // every dblclick jumps the graph to the branch's commit —
              // including the CURRENT branch (the only way to find a buried
              // HEAD on an old project); other branches check out on top
              useUiStore.getState().requestScrollTo(b.sha)
              if (head?.branch !== b.name) onCheckout(b.name)
            }}
            onRename={() => {
              useUiStore.getState().setDialog({
                kind: 'prompt',
                title: `Rename branch "${b.name}"`,
                initial: b.name,
                confirmLabel: 'Rename',
                note: 'Creates a new branch at the same commit and deletes the old one. Local only.',
                onConfirm: (newName) => {
                  // rejects on failure so the dialog shows the error inline
                  // and the user picks another name right away
                  if (newName !== b.name) return dialogOp(() => api.branchRename(path, b.name, newName))
                },
              })
            }}
            onDelete={
              // git refuses to delete the checked-out branch — don't offer it
              head?.branch === b.name
                ? undefined
                : () => {
                    useUiStore.getState().setDialog({
                      kind: 'confirm',
                      title: `Delete branch "${b.name}"`,
                      message: 'Commits unique to this branch will become unreachable (they disappear from the graph).',
                      confirmLabel: 'Delete',
                      danger: true,
                      onConfirm: () => opMut.mutate(() => api.branchDelete(path, b.name, true)),
                    })
                  }
            }
          />
        ))}
        {branches.length === 0 && <p className="px-2 py-1 text-xs text-zinc-600">no branches (no commits yet)</p>}
        {branches.length > 0 && visibleBranches.length === 0 && (
          <p className="px-2 py-1 text-xs text-zinc-600">no branches match the filter</p>
        )}
      </Section>

      <Section title={`Remote branches (${remoteBranches.length})`}>
        {sortedRemoteBranches.map((b) => {
          const remote = b.name.split('/')[0]
          const localName = b.name.slice(remote.length + 1)
          const hasLocal = branches.some((lb) => lb.name === localName)
          return (
            <RefRow
              key={b.name}
              icon={<GitMerge className="h-3.5 w-3.5" />}
              name={b.name}
              current={false}
              sha={b.sha}
              refKind="remote-branch"
              disabled={refOpBusy}
              onClick={() => useUiStore.getState().select(b.sha, { kind: 'remote-branch', name: b.name })}
              onDoubleClick={() => {
                useUiStore.getState().requestScrollTo(b.sha)
                if (!hasLocal) {
                  useUiStore.getState().setDialog({
                    kind: 'confirm',
                    title: 'Checkout remote branch',
                    message: `Create local branch "${localName}" tracking ${b.name} and check it out?`,
                    confirmLabel: 'Checkout',
                    // a dirty worktree asks bring/stash next (chained dialog)
                    onConfirm: () => Promise.resolve(onCheckout(localName, remote)),
                  })
                } else {
                  onCheckout(localName)
                }
              }}
              onDelete={() => {
                // same op as the graph-side remote delete (SelectionActions):
                // git push <remote> --delete <branch> — local branches stay
                useUiStore.getState().setDialog({
                  kind: 'confirm',
                  danger: true,
                  title: `Delete ${b.name}`,
                  message:
                    `Deletes the branch on the remote — git push ${remote} --delete ${localName}.\n\n` +
                    'Local branches (tracking or not) are untouched; commits unique to the remote branch become unreachable there. The remote refuses if this is its default branch.',
                  confirmLabel: 'Delete',
                  onConfirm: () => netDialogOp(() => api.push(path, remote, `:refs/heads/${localName}`), `Delete ${b.name}`),
                })
              }}
            />
          )
        })}
        {remoteBranches.length === 0 && <p className="px-2 py-1 text-xs text-zinc-600">none — fetch to discover</p>}
      </Section>

      <Section title={`Tags (${tags.length})`}>
        {sortedTags.map((t) => (
          <RefRow
            key={t.name}
            icon={<Tag className="h-3.5 w-3.5" />}
            name={t.name}
            current={false}
            sha={t.sha}
            refKind="tag"
            disabled={refOpBusy}
            onClick={() => useUiStore.getState().select(t.sha, { kind: 'tag', name: t.name })}
              onDoubleClick={() => {
                useUiStore.getState().requestScrollTo(t.sha)
                onCheckout(t.name)
              }}
            onRename={() => {
              useUiStore.getState().setDialog({
                kind: 'prompt',
                title: `Rename tag "${t.name}"`,
                initial: t.name,
                confirmLabel: 'Rename',
                note: 'Creates a new tag at the same commit and deletes the old one.',
                onConfirm: (newName) => {
                  if (newName !== t.name) return dialogOp(() => api.tagRename(path, t.name, newName))
                },
              })
            }}
            onDelete={() => {
              useUiStore.getState().setDialog({
                kind: 'confirm',
                title: `Delete tag "${t.name}"`,
                confirmLabel: 'Delete',
                danger: true,
                onConfirm: () => opMut.mutate(() => api.tagDelete(path, t.name)),
              })
            }}
          />
        ))}
        {tags.length === 0 && <p className="px-2 py-1 text-xs text-zinc-600">no tags</p>}
      </Section>

      <Section title={`Remotes (${remotes.length})`}>
        {remotes.map((r) => (
          <RefRow
            key={r}
            icon={<Globe className="h-3.5 w-3.5" />}
            name={r}
            current={false}
            disabled={netBusy !== null}
            onClick={() => !netBusy && netMut.mutate({ fn: () => api.fetch(path, r), label: `Fetch ${r}` })}
            onDelete={undefined}
          />
        ))}
        {remotes.length === 0 && <p className="px-2 py-1 text-xs text-zinc-600">no remotes</p>}
      </Section>

      </div>

      {/* sticky footer: always reachable regardless of list length */}
      <div className="flex shrink-0 flex-col gap-1 border-t border-zinc-800 bg-zinc-900 px-3 py-2">
        <button
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${refOpBusy ? 'text-zinc-600' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
          disabled={refOpBusy}
          onClick={() => {
            useUiStore.getState().setDialog({
              kind: 'prompt',
              title: 'New branch at HEAD',
              initial: '',
              confirmLabel: 'Create',
              onConfirm: (name) => void opMut.mutateAsync(() => api.branchCreate(path, name, head?.sha ?? '', true)),
            })
          }}
          title="Create a branch at HEAD and check it out"
        >
          {refOpBusy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />} New branch at HEAD
        </button>
        <button
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${refOpBusy ? 'text-zinc-600' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'}`}
          disabled={refOpBusy}
          onClick={() => {
            useUiStore.getState().setDialog({
              kind: 'prompt',
              title: 'New tag at HEAD',
              initial: '',
              confirmLabel: 'Create',
              onConfirm: (name) => void opMut.mutateAsync(() => api.tagCreate(path, name, head?.sha ?? '')),
            })
          }}
          title="Create a tag at HEAD"
        >
          <Plus className="h-3 w-3" /> New tag at HEAD
        </button>
      </div>
    </aside>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(true)
  return (
    <div className="mb-2">
      <button className="flex w-full items-center gap-1 py-1 text-xs font-medium text-zinc-400" onClick={() => setOpen(!open)}>
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        {title}
      </button>
      {open && <ul>{children}</ul>}
    </div>
  )
}

function RefRow({
  icon,
  name,
  current,
  sha,
  refKind,
  disabled,
  onClick,
  onDoubleClick,
  onRename,
  onDelete,
}: {
  icon: ReactNode
  name: string
  current: boolean
  sha?: string
  /** this row's ref identity — a click selects the ref, not just its commit */
  refKind?: 'branch' | 'tag' | 'remote-branch'
  disabled?: boolean
  onClick?: () => void
  onDoubleClick?: () => void
  onRename?: () => void
  onDelete?: () => void
}) {
  const selectedSha = useUiStore((s2) => s2.selectedSha)
  const selectedRef = useUiStore((s2) => s2.selectedRef)
  // highlight the picked ref; a plain node selection highlights rows at that sha too
  const isSelected =
    sha !== undefined &&
    (selectedRef && refKind ? selectedRef.kind === refKind && selectedRef.name === name : selectedSha === sha)
  return (
    <li
      className={`group flex items-center gap-1.5 rounded px-2 py-1 ${
        disabled ? 'opacity-50' : isSelected ? 'bg-zinc-800 ring-1 ring-emerald-500/40' : 'hover:bg-zinc-800/70'
      }`}
    >
      <span className={current ? 'text-emerald-400' : 'text-zinc-500'}>{icon}</span>
      <button
        className={`min-w-0 flex-1 cursor-default truncate text-left text-xs ${current ? 'font-medium text-emerald-300' : 'text-zinc-300'} ${onClick && !disabled ? 'hover:text-emerald-400' : ''}`}
        onClick={() => !disabled && onClick?.()}
        onDoubleClick={() => !disabled && onDoubleClick?.()}
        title={name + (onClick ? ' — click to select, double-click to checkout' : '')}
      >
        {name}
        {current && <span className="ml-1 text-[10px] text-emerald-500">✓</span>}
      </button>
      {onRename && !disabled && (
        <button
          className="hidden rounded p-0.5 text-zinc-600 hover:text-sky-400 group-hover:block"
          onClick={onRename}
          title={`Rename ${name} (creates a new ref, deletes the old one)`}
        >
          <Pencil className="h-3 w-3" />
        </button>
      )}
      {onDelete && !disabled && (
        <button
          className="hidden rounded p-0.5 text-zinc-600 hover:text-red-400 group-hover:block"
          onClick={onDelete}
          title={`Delete ${name}`}
        >
          <Trash2 className="h-3 w-3" />
        </button>
      )}
    </li>
  )
}

