import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Archive, ChevronDown, ChevronRight, Loader2, Trash2 } from 'lucide-react'
import { api } from '../../lib/client'
import { useStash } from '../../api/hooks'
import { useUiStore } from '../../state/uiStore'
import { friendlyError } from '../../lib/gitErrors'
import { relTime } from '../../lib/time'
import type { StashEntry } from '../../lib/types'

const STATUS_TINT: Record<string, string> = {
  A: 'text-emerald-400',
  M: 'text-sky-400',
  D: 'text-red-400',
  R: 'text-violet-400',
}

/**
 * The stash stack, above the staging area: one row per stash — click a row
 * to list its files; apply / pop / drop from the row's action buttons.
 * Hidden entirely while the stack is empty.
 */
export default function StashSection({ path, onChanged }: { path: string; onChanged: () => void }) {
  const { data: stashes } = useStash(path)
  const stashOpen = useUiStore((s) => s.stashOpen)
  const toggleStash = useUiStore((s) => s.toggleStash)
  const toast = useUiStore((s) => s.toast)
  /** which stash row has its file list expanded */
  const [expanded, setExpanded] = useState<number | null>(null)
  /** busy key like "pop:0" — blocks duplicate clicks across the section */
  const [pendingKey, setPendingKey] = useState<string | null>(null)

  // like StagingPanel.runAction, but returns the settled promise so a dialog
  // onConfirm can keep its spinner up until the op finishes
  const run = (key: string, fn: () => Promise<unknown>): Promise<unknown> => {
    if (pendingKey) return Promise.resolve()
    setPendingKey(key)
    useUiStore.getState().beginOp('Stash')
    return fn()
      .then(onChanged)
      .catch((e: unknown) => {
        const { title, detail } = friendlyError(e)
        toast({ kind: 'error', title, detail })
        onChanged()
      })
      .finally(() => {
        setPendingKey(null)
        useUiStore.getState().endOp()
      })
  }

  if (!stashes || stashes.length === 0) return null

  return (
    <div className="border-b border-sky-500/15 bg-sky-500/[0.04]" data-testid="stash-section">
      <button
        className="flex w-full items-center gap-2 px-4 py-2 text-sm font-medium text-sky-200/90 hover:bg-sky-500/[0.06]"
        onClick={toggleStash}
        title={stashOpen ? 'Collapse the stash list' : 'Expand the stash list'}
      >
        {stashOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        <Archive className="h-3.5 w-3.5 text-sky-300/70" />
        Stashed changes
        <span className="rounded-full bg-sky-500/10 px-2 py-0.5 text-xs text-sky-200/70">
          {stashes.length}
        </span>
      </button>
      {stashOpen && (
        <ul className="flex flex-col gap-1 px-4 pb-2">
          {stashes.map((s) => (
            <StashRow
              key={s.index}
              stash={s}
              path={path}
              open={expanded === s.index}
              onToggle={() => setExpanded(expanded === s.index ? null : s.index)}
              pendingKey={pendingKey}
              run={run}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function StashRow({
  stash,
  path,
  open,
  onToggle,
  pendingKey,
  run,
}: {
  stash: StashEntry
  path: string
  open: boolean
  onToggle: () => void
  pendingKey: string | null
  run: (key: string, fn: () => Promise<unknown>) => Promise<unknown>
}) {
  // files are fetched on first expand and cached per stash index
  const { data: files, isLoading } = useQuery({
    queryKey: ['stash-files', path, stash.index],
    queryFn: () => api.stashFiles(path, stash.index),
    enabled: open,
    staleTime: Infinity,
  })

  return (
    <li className="overflow-hidden rounded-lg border border-sky-500/10 bg-zinc-950/40" data-testid="stash-row">
      <div className="flex items-center gap-2 px-2.5 py-1.5 text-xs">
        <button
          className="min-w-0 flex-1 cursor-default text-left"
          onClick={onToggle}
          title={open ? 'Hide the files in this stash' : 'Show the files in this stash'}
        >
          <span className="font-mono text-sky-200/80">stash@{'{'}{stash.index}{'}'}</span>
          <span className="ml-2 text-zinc-500">{relTime(stash.date)}</span>
          <span className="block truncate text-zinc-400" title={stash.subject}>
            {stash.subject}
          </span>
        </button>
        {pendingKey === `apply:${stash.index}` || pendingKey === `pop:${stash.index}` ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
        ) : (
          <>
            <button
              className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25 disabled:opacity-40"
              disabled={!!pendingKey}
              title="Apply the stash to the worktree (changes land unstaged; the stash is kept)"
              onClick={() => void run(`apply:${stash.index}`, () => api.stashApply(path, stash.index))}
              data-testid="stash-apply"
            >
              apply
            </button>
            <button
              className="rounded border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[11px] font-medium text-emerald-300 hover:bg-emerald-500/25 disabled:opacity-40"
              disabled={!!pendingKey}
              title="Apply the stash and drop it (on conflict the stash is kept)"
              onClick={() => void run(`pop:${stash.index}`, () => api.stashApply(path, stash.index, true))}
              data-testid="stash-pop"
            >
              pop
            </button>
          </>
        )}
        {pendingKey === `drop:${stash.index}` ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />
        ) : (
          <button
            className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-red-400 disabled:opacity-40"
            disabled={!!pendingKey}
            title={`Drop stash@{${stash.index}}`}
            onClick={() => {
              useUiStore.getState().setDialog({
                kind: 'confirm',
                title: `Drop stash@{${stash.index}}`,
                message: 'The stash is deleted from the stack. Changes already applied to the worktree stay; anything not applied is lost.',
                confirmLabel: 'Drop',
                danger: true,
                onConfirm: () => run(`drop:${stash.index}`, () => api.stashDrop(path, stash.index)),
              })
            }}
            data-testid="stash-drop"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {open && (
        <div className="border-t border-zinc-800/60 px-2.5 py-1.5">
          {isLoading ? (
            <p className="text-[11px] text-zinc-500">loading files…</p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {(files ?? []).map((f) => (
                <li key={f.path} className="flex items-center gap-2 text-[11px]" title={f.path}>
                  <span className={`w-3 shrink-0 font-mono ${STATUS_TINT[f.status] ?? 'text-zinc-400'}`}>
                    {f.status}
                  </span>
                  <span className="min-w-0 flex-1 truncate font-mono text-zinc-300">{f.path}</span>
                  {typeof f.additions === 'number' && <span className="shrink-0 text-emerald-500">+{f.additions}</span>}
                  {typeof f.deletions === 'number' && <span className="shrink-0 text-red-400">−{f.deletions}</span>}
                </li>
              ))}
              {(files ?? []).length === 0 && <li className="text-[11px] text-zinc-600">no files</li>}
            </ul>
          )}
        </div>
      )}
    </li>
  )
}
