import { describe, expect, it } from 'vitest'
import { orderRows } from './order'
import { assignLanes, buildEdges, type BranchTip } from './lanes'
import type { CommitRow } from './types'

function row(sha: string, parents: string[], commitDate: number): CommitRow {
  return { sha, parents, author: 't', authorDate: commitDate, commitDate, subject: sha }
}

describe('orderRows', () => {
  it('keeps a simple chain newest-first', () => {
    // a (newest) -> b -> c (oldest)
    const rows = [row('c', [], 100), row('b', ['c'], 200), row('a', ['b'], 300)]
    const ordered = orderRows(rows)
    expect(ordered.map((r) => r.sha)).toEqual(['a', 'b', 'c'])
  })

  it('interleaves branches by date while keeping topology', () => {
    //        a (300)
    //       / \
    //   b(250) d(280)
    //     |     |
    //   c(200) e(150)
    const rows = [
      row('c', [], 200),
      row('b', ['c'], 250),
      row('e', [], 150),
      row('d', ['e'], 280),
      row('a', ['b', 'd'], 300),
    ]
    const ordered = orderRows(rows)
    expect(ordered.map((r) => r.sha)).toEqual(['a', 'd', 'b', 'c', 'e'])
    // children before parents
    const idx = new Map(ordered.map((r, i) => [r.sha, i]))
    for (const r of ordered) {
      for (const p of r.parents) {
        expect(idx.get(p)!).toBeGreaterThan(idx.get(r.sha)!)
      }
    }
  })

  it('handles partial loads (dangling parents) deterministically', () => {
    const rows = [row('x', ['missing-parent'], 500), row('y', ['x'], 600)]
    const ordered = orderRows(rows)
    expect(ordered.map((r) => r.sha)).toEqual(['y', 'x'])
  })

  it('scales to 100k commits quickly', () => {
    // linear chain of 100k — worst case heap usage
    const rows: CommitRow[] = []
    for (let i = 0; i < 100_000; i++) {
      rows.push(row(`s${i}`, i === 0 ? [] : [`s${i - 1}`], 1_000_000 + i))
    }
    const t0 = performance.now()
    const ordered = orderRows(rows)
    const dt = performance.now() - t0
    expect(ordered.length).toBe(100_000)
    expect(ordered[0].sha).toBe('s99999')
    expect(dt).toBeLessThan(500) // generous CI margin; local usually < 50ms
  })
})

describe('assignLanes', () => {
  it('keeps the mainline at lane 0 and branches right', () => {
    // a -> b -> c on mainline; x branches off b
    const ordered = [
      row('a', ['b', 'x'], 300),
      row('x', ['b'], 250),
      row('b', ['c'], 200),
      row('c', [], 100),
    ]
    const { lanes, laneCount } = assignLanes(ordered)
    expect(lanes.get('a')).toBe(0)
    expect(lanes.get('b')).toBe(0)
    expect(lanes.get('c')).toBe(0)
    // x is a merge-parent continuation → own lane
    expect(lanes.get('x')).toBeGreaterThan(0)
    expect(laneCount).toBe(2)
  })

  it('consolidates lanes expecting the same parent', () => {
    // two branches converge: a<-x, a<-y (both parents of a... a is merge)
    const ordered = [row('a', ['m', 'n'], 300), row('m', ['z'], 200), row('n', ['z'], 210), row('z', [], 100)]
    const { lanes } = assignLanes(ordered)
    // m and n must occupy different lanes
    expect(lanes.get('m')).not.toBe(lanes.get('n'))
    // z consolidates back to one lane
    expect(lanes.get('z')).toBeDefined()
  })
})

describe('assignLanes with branch tips', () => {
  it('checked-out branch owns the trunk; branch tips open their own columns', () => {
    // the dependabot fan: 3 branches off the HEAD commit, trunk continues below
    const ordered = [
      row('d1', ['h'], 400),
      row('d2', ['h'], 350),
      row('d3', ['h'], 300),
      row('h', ['p'], 200), // HEAD
      row('p', [], 100),
    ]
    const tips: BranchTip[] = [
      { sha: 'h', current: true },
      { sha: 'd1', current: false },
      { sha: 'd2', current: false },
      { sha: 'd3', current: false },
    ]
    const { lanes, laneCount } = assignLanes(ordered, tips, 'h')
    // trunk holds the MIDDLE slot of the tree layout — HEAD is its column top
    expect(lanes.get('h')).toBe(2)
    expect(lanes.get('p')).toBe(2)
    // branches alternate sides, first ring double-spaced:
    // d1 → trunk+2 (right), d2 → trunk−2 (left), d3 → trunk+3
    expect(lanes.get('d1')).toBe(4)
    expect(lanes.get('d2')).toBe(0)
    expect(lanes.get('d3')).toBe(5)
    expect(laneCount).toBe(6)
  })

  it('a branch chain draws as one straight column', () => {
    // feature: f2 (tip) -> f1 -> trunk base b
    const ordered = [row('f2', ['f1'], 300), row('f1', ['b'], 250), row('b', [], 100)]
    const tips: BranchTip[] = [
      { sha: 'b', current: true },
      { sha: 'f2', current: false },
    ]
    const { lanes } = assignLanes(ordered, tips, 'b')
    expect(lanes.get('b')).toBe(0)
    expect(lanes.get('f1')).toBe(2)
    expect(lanes.get('f2')).toBe(2) // linear feature history: one column
  })

  it('a remote tip that is an ancestor of its local branch adds no lane', () => {
    const ordered = [row('f2', ['f1'], 300), row('f1', ['b'], 250), row('b', [], 100)]
    const tips: BranchTip[] = [
      { sha: 'b', current: true },
      { sha: 'f2', current: false },
      { sha: 'f1', current: false }, // origin/feature behind local
    ]
    const { lanes, laneCount } = assignLanes(ordered, tips, 'b')
    expect(lanes.get('f1')).toBe(2)
    expect(lanes.get('f2')).toBe(2)
    expect(laneCount).toBe(3)
  })

  it('scales to 100k commits with 50 side branches', () => {
    const rows: CommitRow[] = []
    for (let i = 0; i < 100_000; i++) {
      rows.push(row(`s${i}`, i === 0 ? [] : [`s${i - 1}`], 1_000_000 + i))
    }
    const tips: BranchTip[] = [{ sha: 's99999', current: true }]
    for (let i = 0; i < 50; i++) {
      const sha = `b${i}`
      rows.push(row(sha, ['s99999'], 2_000_000 + i))
      tips.push({ sha, current: false })
    }
    const t0 = performance.now()
    const ordered = orderRows(rows)
    const { laneCount } = assignLanes(ordered, tips, 's99999')
    const dt = performance.now() - t0
    expect(laneCount).toBe(53) // 50 branches, first ring double-spaced (±2..±26)
    expect(dt).toBeLessThan(500)
  })
})

describe('buildEdges', () => {
  it('links commits to their parents and marks dangling ones', () => {
    const ordered = [row('a', ['b'], 300), row('b', [], 200)]
    const { lanes } = assignLanes(ordered)
    const edges = buildEdges(ordered, lanes)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ fromIdx: 0, toIdx: 1, dangling: false })
  })

  it('creates dangling stubs for unloaded parents', () => {
    const ordered = [row('a', ['missing'], 300)]
    const { lanes } = assignLanes(ordered)
    const edges = buildEdges(ordered, lanes)
    expect(edges[0].dangling).toBe(true)
  })
})
