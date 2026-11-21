import { useUiStore } from '../state/uiStore'

/**
 * Click-blockade while any repo-altering op runs (push, checkout, rebase,
 * move, commit…): a veil above the graph popups (z-45) but below
 * dialogs/modals/toasts (z-50), so their own flows keep working — a
 * dialog's spinner stays clickable-side, and a credentials prompt raised
 * mid-push can still be filled. The dark tint + cursor-wait make the
 * locked state visible (an invisible blockade reads as dead buttons);
 * the header chip names the running op.
 */
export default function BusyOverlay() {
  const busy = useUiStore((s) => s.busyCount > 0)
  if (!busy) return null
  return <div className="fixed inset-0 z-[45] cursor-wait bg-black/25" aria-hidden data-testid="busy-overlay" />
}
