import { useGraphStore } from '../state/graphStore'

/**
 * Is `ancestorSha` reachable from `fromSha` through the loaded rows' parents
 * (full DAG walk, not first-parent — containment is topological)? Shared by
 * merge no-op detection (GraphRow), remote-checkout fast-forward/divergence
 * decisions (RepoPage) and squash validation (SquashModal).
 *
 * Bounded; a parent outside the loaded window reads as "not contained", so
 * the server's typed error remains the final guard.
 */
export function containsCommit(fromSha: string, ancestorSha: string): boolean {
  const rows = useGraphStore.getState().rowsBySha
  const seen = new Set<string>()
  const stack = [fromSha]
  while (stack.length > 0 && seen.size < 5000) {
    const cur = stack.pop()!
    if (cur === ancestorSha) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    const row = rows.get(cur)
    if (!row) continue
    stack.push(...row.parents)
  }
  return false
}
