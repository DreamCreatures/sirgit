import { useEffect, useRef, useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { useUiStore } from '../state/uiStore'
import { friendlyError } from '../lib/gitErrors'

/**
 * In-app confirm/prompt modal — replaces window.confirm/prompt, which are
 * suppressed in embedded browsers (window.prompt throws there, so rename,
 * create and delete flows silently did nothing). Esc cancels, Enter submits.
 *
 * An onConfirm that returns a Promise keeps the dialog open: the confirm
 * button spins and everything is locked until it settles, so long ops
 * (pushes, remote checkouts) get an explicit loading state. A REJECTED
 * promise also keeps the dialog open — the error shows inline so the user
 * fixes the input (branch name taken, protected ref) instead of retyping
 * everything after a toast.
 */
export default function AppDialog() {
  const dialog = useUiStore((s) => s.dialog)
  const setDialog = useUiStore((s) => s.setDialog)
  const [value, setValue] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<{ title: string; detail?: string } | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (dialog?.kind === 'prompt') {
      setValue(dialog.initial)
      setError(null)
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [dialog])

  useEffect(() => {
    if (!dialog) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !submitting) setDialog(null)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [dialog, setDialog, submitting])

  if (!dialog) return null

  const confirm = () => {
    if (submitting) return
    const close = () => setDialog(null)
    const result =
      dialog.kind === 'prompt'
        ? value.trim()
          ? dialog.onConfirm(value.trim())
          : undefined
        : dialog.onConfirm()
    if (result === undefined) {
      close()
      return
    }
    // async op: spinner until it settles. Success closes; rejection keeps
    // the dialog open with the error inline — the input stays editable
    setSubmitting(true)
    setError(null)
    void Promise.resolve(result)
      .then(() => {
        setSubmitting(false)
        close()
      })
      .catch((e: unknown) => {
        setSubmitting(false)
        setError(friendlyError(e))
        inputRef.current?.focus()
        inputRef.current?.select()
      })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !submitting) setDialog(null)
      }}
      data-testid="app-dialog"
    >
      <div className="w-[400px] rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
        <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-100">
          {dialog.kind === 'confirm' && dialog.danger && <TriangleAlert className="h-4 w-4 shrink-0 text-red-400" />}
          {dialog.title}
        </h2>

        {dialog.kind === 'confirm' && dialog.message && (
          <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-zinc-400">{dialog.message}</p>
        )}
        {dialog.kind === 'prompt' && (
          <>
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value)
                if (error) setError(null)
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirm()
              }}
              className={`mt-3 w-full rounded-lg border bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none ${
                error ? 'border-red-500/60 focus:border-red-500' : 'border-zinc-700 focus:border-emerald-500/60'
              }`}
              data-testid="app-dialog-input"
            />
            {dialog.note && <p className="mt-2 text-xs text-zinc-500">{dialog.note}</p>}
          </>
        )}

        {error && (
          <div
            className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
            data-testid="app-dialog-error"
          >
            <p className="font-medium">{error.title}</p>
            {error.detail && <p className="mt-0.5 whitespace-pre-wrap leading-relaxed text-red-300/70">{error.detail}</p>}
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-lg bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
            onClick={() => setDialog(null)}
            disabled={submitting}
            data-testid="app-dialog-cancel"
          >
            Cancel
          </button>
          <button
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50 ${
              dialog.kind === 'confirm' && dialog.danger
                ? 'bg-red-600 hover:bg-red-500'
                : 'bg-emerald-600 hover:bg-emerald-500'
            }`}
            onClick={confirm}
            disabled={submitting || (dialog.kind === 'prompt' && !value.trim())}
            // commit-creating dialogs opt in — hovering the confirm previews
            // the would-be commit as the dashed ghost above its target sha
            data-ghost-preview={dialog.ghostPreview ?? undefined}
            data-testid="app-dialog-confirm"
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            {dialog.confirmLabel ?? (dialog.kind === 'prompt' ? 'OK' : 'Confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
