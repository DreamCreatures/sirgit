/** Compact relative time — graph rows, stash entries, toasts. */
export function relTime(ts: number): string {
  const diff = Date.now() / 1000 - ts
  if (diff < 60) return 'now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h`
  if (diff < 86400 * 30) return `${Math.floor(diff / 86400)}d`
  if (diff < 86400 * 365) return `${Math.floor(diff / (86400 * 30))}mo`
  return `${Math.floor(diff / (86400 * 365))}y`
}
