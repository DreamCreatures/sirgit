import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, Scissors, ArrowRight } from 'lucide-react'
import { api } from '../../lib/client'
import type { CommitRow } from '../../lib/types'
import { useUiStore } from '../../state/uiStore'
import { friendlyError } from '../../lib/gitErrors'

/**
 * Squash confirmation modal with commit selection:
 *   from <branch tip> ──── N commits ───▶ onto <base>
 * The listed commits each carry a checkbox; the selection is the segment
 * from the tip (unchecking a commit also unchecks everything older — the
 * squash replaces one contiguous run). The base updates live: it is the
 * parent of the oldest selected commit, so unselected older commits stay on
 * the branch untouched.
 */
export default function SquashModal({
  path,
  rowsBySha,
  currentBranch,
  onDone,
}: {
  path: string
  rowsBySha: Map<string, CommitRow>
  currentBranch?: string
  onDone: () => void
}) {
  const modal = useUiStore((s) => s.squashModal)
  const setSquashModal = useUiStore((s) => s.setSquashModal)
  const toast = useUiStore((s) => s.toast)

  const squashed: CommitRow[] = useMemo(() => {
    if (!modal) return []
    // walk first-parent chain from the branch tip until the target
    const out: CommitRow[] = []
    let cursor: string | undefined = modal.branchTipSha
    while (cursor && cursor !== modal.targetSha) {
      const row = rowsBySha.get(cursor)
      if (!row) break // parent outside loaded window — count what we have
      out.push(row)
      cursor = row.parents[0]
    }
    return out
  }, [modal, rowsBySha])

  /** how many commits from the tip are selected (the squash segment) */
  const [segLen, setSegLen] = useState<number | null>(null)
  const selectedCount = squashed.length === 0 ? 0 : (segLen ?? squashed.length)

  // effective base: parent of the oldest selected commit (== the clicked
  // target when everything is selected and the walk reached it)
  const oldestSelected = selectedCount > 0 ? squashed[selectedCount - 1] : undefined
  const effectiveBase = oldestSelected?.parents[0] ?? null

  if (!modal) return null
  const soft = modal.branch === currentBranch

  const toggleAt = (i: number) => {
    // checked → drop it and everything older; unchecked → check up to it
    setSegLen(i < selectedCount ? i : i + 1)
  }

  const commit = () => {
    if (!effectiveBase) return
    setSquashModal(null)
    useUiStore.getState().beginOp('Squash')
    void api
      .squash(path, modal.branch, effectiveBase)
      .then((res) => {
        if (soft && res?.title) {
          // soft path: changes staged + messages gathered server-side —
          // prefill the commit box amend-style, the user reviews and commits
          useUiStore.getState().setCommitPrefill({ title: res.title, body: res.body ?? '' })
          toast({ kind: 'info', title: `Squashed ${selectedCount} commits — message prefilled, review and commit` })
        } else if (soft) {
          toast({ kind: 'info', title: `Squashed ${selectedCount} commits — changes staged, write one commit` })
        } else {
          toast({ kind: 'success', title: `Squashed ${selectedCount} commits into one on ${modal.branch}` })
        }
        onDone()
      })
      .catch((e: unknown) => {
        const { title, detail } = friendlyError(e)
        toast({ kind: 'error', title, detail })
        onDone()
      })
      .finally(() => useUiStore.getState().endOp())
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" data-testid="squash-modal">
      <div className="w-[520px] rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
        <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-100">
          <Scissors className="h-4 w-4 text-amber-400" /> Squash <span className="font-mono">{modal.branch}</span>
        </h2>

        {/* from ──── N commits ───▶ onto */}
        <div className="mt-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="shrink-0 text-center">
            <div className="mx-auto h-3 w-3 rounded-full bg-emerald-500" />
            <p className="mt-1 font-mono text-[10px] text-zinc-500">{modal.branchTipSha.slice(0, 7)}</p>
            <p className="text-[10px] text-zinc-600">from</p>
          </div>
          <div className="relative mx-2 min-w-0 flex-1 pb-3">
            <div className="h-0.5 w-full rounded bg-zinc-700" />
            <ArrowRight className="absolute -right-1 -top-[7px] bg-zinc-950 text-zinc-500" size={16} />
            <span className="absolute left-1/2 top-1 -translate-x-1/2 whitespace-nowrap rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300">
              {selectedCount} commit{selectedCount === 1 ? '' : 's'}
            </span>
          </div>
          <div className="shrink-0 text-center">
            <div className="mx-auto h-3 w-3 rounded-full bg-zinc-500" />
            <p className="mt-1 font-mono text-[10px] text-zinc-500">
              {effectiveBase ? effectiveBase.slice(0, 7) : '—'}
            </p>
            <p className="text-[10px] text-zinc-600">onto</p>
          </div>
        </div>

        {squashed.length > 0 && (
          <ul className="mt-3 max-h-56 overflow-y-auto rounded-lg border border-zinc-800 bg-zinc-950/60">
            {squashed.map((r, i) => (
              <SquashedCommitRow
                key={r.sha}
                path={path}
                row={r}
                checked={i < selectedCount}
                onToggle={() => toggleAt(i)}
                autoExpand={i === 0 && selectedCount <= 5}
              />
            ))}
          </ul>
        )}
        <p className="mt-1.5 text-[11px] text-zinc-600">
          The selection is the run from the tip — unchecking a commit unchecks everything below it; those older commits
          stay on the branch.
        </p>

        <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-xs text-zinc-400">
          {soft ? (
            <>
              Soft reset: the {selectedCount} selected commit{selectedCount === 1 ? '' : 's'} leave{' '}
              <b className="text-zinc-200">{modal.branch}</b> and their combined changes return to the staging area for
              one new commit.
            </>
          ) : (
            <>
              One new commit (same tree as <b className="text-zinc-200">{modal.branch}</b>&apos;s tip) replaces the{' '}
              {selectedCount} selected on top of{' '}
              <span className="font-mono">{effectiveBase ? effectiveBase.slice(0, 7) : '—'}</span> — the ref moves to
              it, older commits stay.
            </>
          )}
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700"
            onClick={() => setSquashModal(null)}
            data-testid="squash-cancel"
          >
            Cancel
          </button>
          <button
            className="rounded-lg bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-40"
            disabled={selectedCount === 0 || !effectiveBase}
            onClick={commit}
            data-testid="squash-commit"
            data-ghost-preview={modal.branchTipSha}
          >
            Squash {selectedCount} {selectedCount === 1 ? 'commit' : 'commits'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** One squashed commit: selection checkbox + title + full message, expandable per row. */
function SquashedCommitRow({
  path,
  row,
  checked,
  onToggle,
  autoExpand,
}: {
  path: string
  row: CommitRow
  checked: boolean
  onToggle: () => void
  autoExpand: boolean
}) {
  const [open, setOpen] = useState(autoExpand)
  const { data } = useQuery({
    queryKey: ['commit', path, row.sha],
    queryFn: () => api.commitDetail(path, row.sha),
    enabled: open,
  })
  const body = data?.body?.trim()

  return (
    <li className={`border-b border-zinc-800/50 px-3 py-1.5 text-xs last:border-0 ${checked ? '' : 'opacity-40'}`}>
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          className="accent-amber-600"
          title={checked ? 'Exclude this commit (and older) from the squash' : 'Include up to this commit in the squash'}
          data-testid={`squash-check-${row.sha.slice(0, 7)}`}
        />
        <button
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => setOpen(!open)}
          title={open ? 'Hide commit message' : 'Show full commit message'}
        >
          {body ? (
            open ? (
              <ChevronDown className="h-3 w-3 shrink-0 text-zinc-500" />
            ) : (
              <ChevronRight className="h-3 w-3 shrink-0 text-zinc-500" />
            )
          ) : (
            <span className="w-3 shrink-0" />
          )}
          <span className="w-14 shrink-0 font-mono text-zinc-600">{row.sha.slice(0, 7)}</span>
          <span className="min-w-0 flex-1 truncate font-medium text-zinc-200">{row.subject}</span>
        </button>
      </div>
      {open && body && (
        <pre className="mt-1 ml-[3.6rem] whitespace-pre-wrap break-words rounded bg-zinc-900/70 px-2 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-400">
          {body}
        </pre>
      )}
    </li>
  )
}
