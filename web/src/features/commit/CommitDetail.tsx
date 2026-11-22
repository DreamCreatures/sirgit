import { useEffect, useState } from 'react'
import Resizer from '../../ui/Resizer'
import { useQuery } from '@tanstack/react-query'
import { X, Copy, FileText } from 'lucide-react'
import { api } from '../../lib/client'
import { useUiStore } from '../../state/uiStore'
import { friendlyError } from '../../lib/gitErrors'
import DiffView from './DiffView'

/** Right drawer: selected commit's metadata + per-file diffs (lazy). Slides over the graph — the graph keeps its full width. */
export default function CommitDetail({ path }: { path: string }) {
  const selectedSha = useUiStore((s) => s.detailsSha)
  const setDetailsSha = useUiStore((s) => s.setDetailsSha)
  const storedWidth = useUiStore((s) => s.commitDetailWidth)
  const setWidth = useUiStore((s) => s.setCommitDetailWidth)
  const toast = useUiStore((s) => s.toast)

  const { data, isLoading, error } = useQuery({
    queryKey: ['commit', path, selectedSha],
    queryFn: () => api.commitDetail(path, selectedSha!),
    enabled: !!selectedSha,
  })

  // responsive width: tablets/phones get the drawer FULL-width; desktops
  // START at half the viewport on every open (user: "I always have to expand
  // it to max to see the changes clearer") — a hand-dragged wider width is
  // respected, and after opening the drawer can still be dragged narrower
  const [vw, setVw] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth))
  useEffect(() => {
    const onResize = () => setVw(window.innerWidth)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  useEffect(() => {
    if (!selectedSha || vw < 768) return
    const half = Math.min(Math.round(vw * 0.5), 820)
    if (storedWidth < half) setWidth(half)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boost on each open only
  }, [selectedSha])
  const width = vw < 768 ? vw : storedWidth

  if (!selectedSha) return null

  return (
    <aside
      className="animate-drawer-in absolute inset-y-0 right-0 z-30 flex flex-col border-l border-zinc-800 bg-zinc-900 shadow-2xl"
      style={{ width }}
      data-testid="commit-drawer"
    >
      <Resizer side="right" currentWidth={width} onResize={setWidth} />
      <header className="flex items-start justify-between gap-2 border-b border-zinc-800 px-4 py-3">
        <div className="min-w-0">
          {/* wraps — this drawer is where you READ the commit; a truncated
           *  one-liner makes long titles (with no body to fall back on)
           *  unreadable */}
          <p className="break-words text-sm font-medium leading-snug text-zinc-100">{data?.subject ?? '…'}</p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {data ? (
              <>
                {data.authorName} · {new Date(data.authorDate * 1000).toLocaleString()} ·{' '}
                <button
                  className="font-mono hover:text-emerald-400"
                  onClick={() => {
                    void navigator.clipboard.writeText(data.sha)
                    toast({ kind: 'success', title: 'SHA copied' })
                  }}
                >
                  {data.sha.slice(0, 10)}
                  <Copy className="ml-1 inline h-3 w-3" />
                </button>
              </>
            ) : (
              selectedSha.slice(0, 10)
            )}
          </p>
        </div>
        <button className="rounded p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300" onClick={() => setDetailsSha(null)} data-testid="drawer-close">
          <X className="h-4 w-4" />
        </button>
      </header>

      <div className="scroll-thin flex-1 overflow-y-auto px-4 py-3">
        {error && <p className="text-sm text-red-400">{friendlyError(error).title}</p>}
        {isLoading && <p className="text-sm text-zinc-500">loading…</p>}
        {data && (
          <>
            {data.body && <pre className="mb-3 whitespace-pre-wrap text-xs text-zinc-400">{data.body}</pre>}
            <p className="mb-2 text-xs text-zinc-500">
              <span className="text-emerald-400">+{data.additions}</span>{' '}
              <span className="text-red-400">−{data.deletions}</span> · {data.files.length} file
              {data.files.length === 1 ? '' : 's'}
              {data.parents.length > 0 && (
                <>
                  {' '}
                  · parent{data.parents.length > 1 ? 's' : ''}:{' '}
                  {data.parents.map((p) => (
                    <button
                      key={p}
                      className="mr-1 font-mono text-zinc-400 underline-offset-2 hover:text-emerald-400 hover:underline"
                      onClick={() => setDetailsSha(p)}
                    >
                      {p.slice(0, 7)}
                    </button>
                  ))}
                </>
              )}
            </p>
            <FileList path={path} sha={selectedSha} files={data.files.map((f) => ({ path: f.path, status: f.status }))} />
          </>
        )}
      </div>
    </aside>
  )
}

function FileList({
  path,
  sha,
  files,
}: {
  path: string
  sha: string
  files: { path: string; status: string }[]
}) {
  const [openFile, setOpenFile] = useState<string | null>(null)
  const { data: diff, isLoading } = useQuery({
    queryKey: ['commit-diff', path, sha, openFile],
    queryFn: () => api.commitFileDiff(path, sha, openFile!),
    enabled: !!openFile,
  })

  return (
    <div className="flex flex-col gap-1">
      {files.map((f) => (
        <div key={f.path}>
          <button
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-zinc-800 ${
              openFile === f.path ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300'
            }`}
            onClick={() => setOpenFile(openFile === f.path ? null : f.path)}
          >
            <StatusBadge status={f.status} />
            <span className="truncate font-mono">{f.path}</span>
            <FileText className="ml-auto h-3 w-3 shrink-0 text-zinc-600" />
          </button>
          {openFile === f.path && (
            <div className="mt-1 px-1 pb-1">
              {isLoading ? (
                <p className="px-2 py-2 text-xs text-zinc-500">loading diff…</p>
              ) : (
                <DiffView diff={diff ?? ''} />
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const color =
    status === 'A' ? 'text-emerald-400' : status === 'D' ? 'text-red-400' : status === 'R' ? 'text-amber-400' : 'text-sky-400'
  return <span className={`w-3 shrink-0 text-center font-mono ${color}`}>{status}</span>
}
