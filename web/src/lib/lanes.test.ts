import { describe, expect, it } from 'vitest'
import { assignLanes, buildEdges } from './lanes'
import type { CommitRow } from './types'

const row = (sha: string, ...parents: string[]): CommitRow => ({
  sha,
  parents,
  author: 'T',
  authorDate: 0,
  commitDate: 0,
  subject: sha,
})

describe('assignLanes (branch chains)', () => {
  it('centers the trunk and alternates side branches left/right', () => {
    // newest-first display order; trunk t3→t2→t1, a1 rides on t2, b-chain on t1
    const ordered = [
      row('a1', 't2'),
      row('t3', 't2'),
      row('b2', 'b1'),
      row('b1', 't1'),
      row('t2', 't1'),
      row('t1'),
    ]
    const { lanes, laneCount } = assignLanes(
      ordered,
      [
        { sha: 't3', current: true },
        { sha: 'a1', current: false },
        { sha: 'b2', current: false },
      ],
      't3',
    )
    expect(laneCount).toBe(5)
    expect(lanes.get('t1')).toBe(2)
    expect(lanes.get('t2')).toBe(2)
    expect(lanes.get('t3')).toBe(2) // trunk holds the middle slot
    expect(lanes.get('a1')).toBe(4) // first side branch fans right, double-spaced (+2)
    expect(lanes.get('b1')).toBe(0) // second fans left (−2)
    expect(lanes.get('b2')).toBe(0)
  })

  it('fans four side branches symmetrically around the trunk', () => {
    const ordered = [row('c1', 't1'), row('c2', 't1'), row('c3', 't1'), row('c4', 't1'), row('t1')]
    const { lanes, laneCount } = assignLanes(
      ordered,
      [
        { sha: 't1', current: true },
        { sha: 'c1', current: false },
        { sha: 'c2', current: false },
        { sha: 'c3', current: false },
        { sha: 'c4', current: false },
      ],
      't1',
    )
    expect(laneCount).toBe(7)
    expect(lanes.get('t1')).toBe(3) // middle slot
    expect(lanes.get('c1')).toBe(5) // +2
    expect(lanes.get('c2')).toBe(1) // −2
    expect(lanes.get('c3')).toBe(6) // +3
    expect(lanes.get('c4')).toBe(0) // −3
  })

  it('keeps a single-branch history in one lane', () => {
    const ordered = [row('t2', 't1'), row('t1')]
    const { lanes, laneCount } = assignLanes(ordered, [{ sha: 't2', current: true }], 't2')
    expect(laneCount).toBe(1)
    expect([...lanes.values()].every((l) => l === 0)).toBe(true)
  })

  it("left mode anchors the trunk at lane 0 and stacks branches right by recency", () => {
    const ordered = [
      row('a1', 't2'),
      row('t3', 't2'),
      row('b2', 'b1'),
      row('b1', 't1'),
      row('t2', 't1'),
      row('t1'),
    ]
    const tips = [
      { sha: 't3', current: true },
      { sha: 'a1', current: false },
      { sha: 'b2', current: false },
    ]
    const { lanes, laneCount } = assignLanes(ordered, tips, 't3', 'left')
    expect(laneCount).toBe(3)
    expect(lanes.get('t1')).toBe(0) // trunk leftmost
    expect(lanes.get('t3')).toBe(0)
    expect(lanes.get('a1')).toBe(1) // newest side tip closest
    expect(lanes.get('b1')).toBe(2)
    expect(lanes.get('b2')).toBe(2)
  })

  it('stacks chains beyond the fan to the right instead of widening the band', () => {
    // 12 side chains: first 10 alternate ±2..±6, the rest stack right of the
    // fan — merge-heavy repos must not push the trunk off-screen
    const ordered: CommitRow[] = [row('t1')]
    const tips: { sha: string; current: boolean }[] = [{ sha: 't1', current: true }]
    for (let i = 1; i <= 12; i++) {
      ordered.unshift(row(`c${i}`, 't1'))
      tips.push({ sha: `c${i}`, current: false })
    }
    const { lanes } = assignLanes(ordered, tips, 't1', 'tree')
    expect(lanes.get('t1')).toBe(6) // trunk: 5 left-side fan chains + spacing
    // display order is c12 (newest) → c1: the fan fills c12..c3, then the
    // overflow stacks right
    expect(lanes.get('c12')).toBe(8) // fan chain #1 → right +2
    expect(lanes.get('c11')).toBe(4) // fan chain #2 → left −2
    expect(lanes.get('c3')).toBe(0) // fan chain #10 → left −6 (outermost)
    expect(lanes.get('c2')).toBe(13) // beyond fan: fanRight(6)+1 + left(6)
    expect(lanes.get('c1')).toBe(14) // fanRight(6)+2 + left(6)
  })

  it('falls back to topology-only lanes without tips', () => {
    // merge commit m(x, y): extra parent opens its own lane, r consolidates
    const ordered = [row('m', 'x', 'y'), row('x', 'r'), row('y', 'r'), row('r')]
    const { lanes, laneCount } = assignLanes(ordered)
    expect(laneCount).toBe(2)
    expect(lanes.get('m')).toBe(0)
    expect(lanes.get('x')).toBe(0)
    expect(lanes.get('y')).toBe(1)
    expect(lanes.get('r')).toBe(0)
  })
})

describe('buildEdges', () => {
  it('marks parents outside the loaded set as dangling stubs', () => {
    const ordered = [row('a', 'z'), row('z', 'w')] // w is beyond the loaded window
    const { lanes } = assignLanes(ordered, [{ sha: 'a', current: true }], 'a')
    const edges = buildEdges(ordered, lanes)
    expect(edges).toHaveLength(2)
    expect(edges.find((e) => e.fromIdx === 0 && e.toIdx === 1 && !e.dangling)).toBeTruthy()
    expect(edges.find((e) => e.fromIdx === 1)).toMatchObject({ dangling: true, toIdx: -1 })
  })
})
