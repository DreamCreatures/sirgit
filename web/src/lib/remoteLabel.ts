/**
 * Display-only remote-name abbreviation: any remote segment longer than 3
 * letters shortens to its first 3 (`origin` → `ori`, `upstream` → `ups`;
 * short names like `up` stay whole). Chip labels use it; selection, drags
 * and git refspecs always keep the full name.
 */
export function abbrevRemote(name: string): string {
  return name.length > 3 ? name.slice(0, 3) : name
}

/** Abbreviate the remote segment of a full remote-branch ref (`origin/x` → `ori/x`). */
export function abbrevRemoteRef(ref: string): string {
  const slash = ref.indexOf('/')
  return slash < 0 ? ref : abbrevRemote(ref.slice(0, slash)) + ref.slice(slash)
}
