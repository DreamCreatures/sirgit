import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GitBranch, GitMerge, Tag, Globe, Plus, Trash2, Download, ChevronDown, ChevronRight, CloudDownload, Loader2, Pencil} from 'lucide-react'
import { api, pollOp } from '../../lib/client'
import Resizer from '../../ui/Resizer'
import { useRefs } from '../../api/hooks'
import { useUiStore } from '../../state/uiStore'
import { friendlyError } from '../../lib/gitErrors'

/**
 * Left panel: branches, remote branches, tags — with checkout, delete,
 * create-branch/tag, remote management, and fetch/pull actions (push lives
 * on the selected branch's action bar in the graph).
 */
export default function RefsPanel({ path }: { path: string }) {
  const width = useUiStore((s2) => s2.refsPanelWidth)
  const collapsed = useUiStore((s2) => s2.refsPanelCollapsed)
  const setWidth = useUiStore((s2) => s2.setRefsPanelWidth)
  const setCollapsed = useUiStore((s2) => s2.setRefsPanelCollapsed)
  const { data } = useRefs(path)
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
   *  inline) and marks the global busy guard; refreshes on success */
  const dialogOp = (fn: () => Promise<unknown>): Promise<unknown> => {
    useUiStore.getState().beginOp('Working')
    return fn().then(invalidate).finally(() => useUiStore.getState().endOp())
  }

  const netMut = useMutation({
    mutationFn: async ({ fn, label }: { fn: () => Promise<{ opId: string }>; label: string }) => {
      useUiStore.getState().beginOp(label)
      useUiStore.getState().setNetBusy(label)
      try {
        const { opId } = await fn()
        await pollOp(opId)
      } finally {
        useUiStore.getState().setNetBusy(null)
        useUiStore.getState().endOp()
      }
    },
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
    return (
      <aside className="relative flex w-64 shrink-0 items-center justify-center border-r border-zinc-800 bg-zinc-900/30 text-xs text-zinc-500">
        <Resizer side="left" currentWidth={width} onResize={setWidth} />
        loading refs…
      </aside>
    )
  }

  const branches = data.branches ?? []
  const remoteBranches = data?.remoteBranches ?? []
  const tags = data?.tags ?? []
  const remotes = data?.remotes ?? []
  const head = data?.head

  return (
    <aside
      className="relative flex shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/30 text-sm"
      style={{ width }}
    >
      <Resizer side="left" currentWidth={width} onResize={setWidth} />
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-3 py-3">
      {/* actions */}
      <div className="mb-3 flex items-center gap-1.5">
        <button
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs ${netBusy ? 'cursor-not-allowed bg-zinc-800/60 text-zinc-500' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'}`}
          title="Fetch from all remotes"
          onClick={() => !netBusy && netMut.mutate({ fn: () => api.fetch(path), label: 'Fetch' })}
          data-testid="fetch-button"
        >
          {netBusy === 'Fetch' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5" />} Fetch
        </button>
        <button
          className={`flex items-center gap-1 rounded-md px-2 py-1 text-xs ${netBusy ? 'cursor-not-allowed bg-zinc-800/60 text-zinc-500' : 'bg-zinc-800 text-zinc-200 hover:bg-zinc-700'}`}
          title="Pull (fetch + fast-forward)"
          onClick={() => !netBusy && netMut.mutate({ fn: () => api.pull(path), label: 'Pull' })}
        >
          {netBusy === 'Pull' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Pull
        </button>
        <button
          className="ml-auto rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
          onClick={() => setCollapsed(true)}
          title="Collapse the refs panel"
          data-testid="refs-panel-collapse"
        >
          ⟨
        </button>
      </div>

      <Section title={`Branches (${branches.length})`}>
        {branches.map((b) => (
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
              if (head?.branch !== b.name)
                opMut.mutate(async () => {
                  await api.checkout(path, b.name)
                  useUiStore.getState().requestScrollTo(b.sha)
                })
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
      </Section>

      <Section title={`Remote branches (${remoteBranches.length})`}>
        {remoteBranches.map((b) => {
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
                if (!hasLocal) {
                  useUiStore.getState().setDialog({
                    kind: 'confirm',
                    title: 'Checkout remote branch',
                    message: `Create local branch "${localName}" tracking ${b.name} and check it out?`,
                    confirmLabel: 'Checkout',
                    onConfirm: () => opMut.mutate(() => api.checkout(path, localName, remote)),
                  })
                } else {
                  opMut.mutate(() => api.checkout(path, localName))
                }
              }}
              onDelete={undefined}
            />
          )
        })}
        {remoteBranches.length === 0 && <p className="px-2 py-1 text-xs text-zinc-600">none — fetch to discover</p>}
      </Section>

      <Section title={`Tags (${tags.length})`}>
        {tags.map((t) => (
          <RefRow
            key={t.name}
            icon={<Tag className="h-3.5 w-3.5" />}
            name={t.name}
            current={false}
            sha={t.sha}
            refKind="tag"
            disabled={refOpBusy}
            onClick={() => useUiStore.getState().select(t.sha, { kind: 'tag', name: t.name })}
            onDoubleClick={() =>
              opMut.mutate(async () => {
                await api.checkout(path, t.name)
                useUiStore.getState().requestScrollTo(t.sha)
              })
            }
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

