import { X, AlertCircle, CheckCircle2, Info } from 'lucide-react'
import { useUiStore } from '../../state/uiStore'

/**
 * Transient notifications, bottom-right. The container is pointer-events-none
 * and SO ARE the toasts — only each toast's dismiss button re-enables pointer
 * events, so an 8-second error toast never blocks the action bar underneath.
 * Announced politely for screen readers via the live region.
 */
export default function Toasts() {
  const { toasts, dismissToast } = useUiStore()

  return (
    <div
      className="pointer-events-none fixed bottom-4 right-4 z-50 flex w-96 flex-col gap-2"
      role="status"
      aria-live="polite"
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`flex items-start gap-2 rounded-lg border px-3 py-2 shadow-lg backdrop-blur ${
            t.kind === 'error'
              ? 'border-red-500/40 bg-red-950/80 text-red-100'
              : t.kind === 'success'
                ? 'border-emerald-500/40 bg-emerald-950/80 text-emerald-100'
                : 'border-zinc-600/40 bg-zinc-900/90 text-zinc-100'
          }`}
        >
          {t.kind === 'error' ? (
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          ) : t.kind === 'success' ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          ) : (
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">{t.title}</p>
            {t.detail && <pre className="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] opacity-80">{t.detail}</pre>}
          </div>
          <button
            className="pointer-events-auto rounded p-0.5 opacity-60 hover:opacity-100"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss notification"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}
