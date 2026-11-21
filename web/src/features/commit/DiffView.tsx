import { useMemo } from 'react'

interface Hunk {
  header: string
  lines: { type: 'context' | 'add' | 'del' | 'meta'; text: string; oldNo?: number; newNo?: number }[]
}

/** Minimal unified-diff parser — enough for per-file git diffs. */
function parseUnified(text: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | null = null
  let oldNo = 0
  let newNo = 0

  for (const line of text.split('\n')) {
    if (line.startsWith('@@')) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line)
      oldNo = m ? parseInt(m[1], 10) : 0
      newNo = m ? parseInt(m[2], 10) : 0
      current = { header: line, lines: [] }
      hunks.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      current.lines.push({ type: 'meta', text: line })
      continue
    }
    if (line.startsWith('+')) {
      current.lines.push({ type: 'add', text: line.slice(1), newNo: newNo++ })
    } else if (line.startsWith('-')) {
      current.lines.push({ type: 'del', text: line.slice(1), oldNo: oldNo++ })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      current.lines.push({ type: 'meta', text: line })
    } else {
      current.lines.push({ type: 'context', text: line.slice(1), oldNo: oldNo++, newNo: newNo++ })
    }
  }
  return hunks
}

export default function DiffView({ diff }: { diff: string }) {
  const hunks = useMemo(() => parseUnified(diff), [diff])

  if (hunks.length === 0) {
    return <p className="px-4 py-3 text-sm text-zinc-600">No textual changes (binary or identical).</p>
  }

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950 font-mono text-xs">
      {hunks.map((h, hi) => (
        <div key={hi}>
          <div className="border-b border-zinc-800/70 bg-zinc-900/70 px-3 py-1 text-zinc-400 select-none">
            {h.header}
          </div>
          {h.lines.map((l, li) => (
            <div
              key={li}
              className={
                l.type === 'add'
                  ? 'bg-emerald-500/10 text-emerald-300'
                  : l.type === 'del'
                    ? 'bg-red-500/10 text-red-300'
                    : l.type === 'meta'
                      ? 'text-zinc-600'
                      : 'text-zinc-400'
              }
            >
              <span className="inline-block w-10 select-none px-1 text-right text-zinc-600">
                {l.oldNo ?? ''}
              </span>
              <span className="inline-block w-10 select-none px-1 text-right text-zinc-600">
                {l.newNo ?? ''}
              </span>
              <span className="whitespace-pre-wrap break-all">{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
