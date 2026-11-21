import type { CommitRow } from './types'

/**
 * Display order over the loaded rows: newest-first with a topological
 * guarantee (children strictly above their parents) — git's --date-order
 * semantics, computed client-side in O(N log N).
 */
export function orderRows(rows: CommitRow[]): CommitRow[] {
  const bySha = new Map<string, CommitRow>()
  for (const r of rows) bySha.set(r.sha, r)

  // remainingChildren[p] = number of loaded rows having p as a parent
  const remainingChildren = new Map<string, number>()
  for (const r of rows) {
    for (const p of r.parents) {
      if (bySha.has(p)) {
        remainingChildren.set(p, (remainingChildren.get(p) ?? 0) + 1)
      }
    }
  }

  const heap = new MaxHeap<CommitRow>((a, b) => {
    if (a.commitDate !== b.commitDate) return a.commitDate - b.commitDate
    if (a.authorDate !== b.authorDate) return a.authorDate - b.authorDate
    return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0
  })

  for (const r of rows) {
    if ((remainingChildren.get(r.sha) ?? 0) === 0) heap.push(r)
  }

  const out: CommitRow[] = []
  while (heap.size > 0) {
    const r = heap.pop()!
    out.push(r)
    for (const p of r.parents) {
      const rem = remainingChildren.get(p)
      if (rem === undefined) continue
      const next = rem - 1
      remainingChildren.set(p, next)
      if (next === 0) heap.push(bySha.get(p)!)
    }
  }

  // safety: cycles shouldn't exist in git, but never drop rows if they did
  if (out.length !== rows.length) {
    const placed = new Set(out.map((r) => r.sha))
    const rest = rows.filter((r) => !placed.has(r.sha))
    rest.sort((a, b) => b.commitDate - a.commitDate)
    return [...out, ...rest]
  }
  return out
}

/** Minimal binary max-heap keyed by a comparator (higher = better). */
class MaxHeap<T> {
  private items: T[] = []
  size = 0

  constructor(private compare: (a: T, b: T) => number) {}

  get sizeValue(): number {
    return this.size
  }

  push(item: T): void {
    this.items.push(item)
    this.size++
    let i = this.items.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.compare(this.items[i], this.items[parent]) > 0) {
        ;[this.items[i], this.items[parent]] = [this.items[parent], this.items[i]]
        i = parent
      } else break
    }
  }

  pop(): T | undefined {
    if (this.items.length === 0) return undefined
    const top = this.items[0]
    const last = this.items.pop()!
    this.size = this.items.length
    if (this.items.length > 0) {
      this.items[0] = last
      let i = 0
      for (;;) {
        const l = 2 * i + 1
        const r = 2 * i + 2
        let best = i
        if (l < this.items.length && this.compare(this.items[l], this.items[best]) > 0) best = l
        if (r < this.items.length && this.compare(this.items[r], this.items[best]) > 0) best = r
        if (best === i) break
        ;[this.items[i], this.items[best]] = [this.items[best], this.items[i]]
        i = best
      }
    }
    return top
  }
}
