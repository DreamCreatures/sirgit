import { useState } from 'react'
import { useNavigate } from 'react-router'
import { FolderGit2, Download, Plus, Trash2, ArrowRight, GitBranch } from 'lucide-react'
import { api, pollOp } from '../../lib/client'
import { useUiStore } from '../../state/uiStore'
import { friendlyError } from '../../lib/gitErrors'

function cleanPath(p: string): string {
  return p.trim()
}

export default function HomePage() {
  const navigate = useNavigate()
  const { recentRepos, addRecentRepo, removeRecentRepo, toast } = useUiStore()
  const [pathInput, setPathInput] = useState('')
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDest, setCloneDest] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  const openRepo = async (rawPath: string) => {
    const path = cleanPath(rawPath)
    if (!path) return
    setBusy(path)
    try {
      const qs = await api.quickstatus(path)
      if (qs.type === 'repo' || qs.type === 'bare') {
        addRecentRepo(path)
        navigate(`/repository?path=${encodeURIComponent(path)}`)
      } else if (qs.type === 'uninited') {
        setBusy(null)
        useUiStore.getState().setDialog({
          kind: 'confirm',
          title: 'Initialize repository',
          message: `"${path}" is not a git repository. Initialize one here?`,
          confirmLabel: 'Init',
          onConfirm: () => {
            void api
              .init(path)
              .then(() => {
                addRecentRepo(path)
                navigate(`/repository?path=${encodeURIComponent(path)}`)
              })
              .catch((e: unknown) => {
                const { title: t, detail: d } = friendlyError(e)
                toast({ kind: 'error', title: t, detail: d })
              })
          },
        })
      } else {
        setBusy(null)
        // the path does not exist yet — offer to create it and init a repo there
        useUiStore.getState().setDialog({
          kind: 'confirm',
          title: 'Create repository',
          message: `"${path}" does not exist. Create the directory and initialize a git repository there?`,
          confirmLabel: 'Create + init',
          onConfirm: () =>
            api
              .createDir(path)
              .then(() => api.init(path))
              .then(() => {
                addRecentRepo(path)
                navigate(`/repository?path=${encodeURIComponent(path)}`)
              })
              .catch((e: unknown) => {
                const { title: t, detail: d } = friendlyError(e)
                toast({ kind: 'error', title: t, detail: d })
              }),
        })
      }
    } catch (e) {
      const { title, detail } = friendlyError(e)
      toast({ kind: 'error', title, detail })
    } finally {
      setBusy(null)
    }
  }

  const doClone = async () => {
    if (!cloneUrl.trim()) return
    const dest = cleanPath(cloneDest) || cloneUrl.split('/').pop()?.replace(/\.git$/, '') || 'repo'
    setBusy('clone')
    try {
      const { opId } = await api.clone(cloneUrl.trim(), dest)
      await pollOp(opId)
      addRecentRepo(dest)
      navigate(`/repository?path=${encodeURIComponent(dest)}`)
    } catch (e) {
      const { title, detail } = friendlyError(e)
      toast({ kind: 'error', title, detail })
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col gap-8 px-6 py-14">
      <header className="flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-600/20">
          <GitBranch className="h-5 w-5 text-emerald-400" />
        </div>
        <div>
          <h1 className="text-xl font-semibold text-zinc-100">sirgit</h1>
          <p className="text-sm text-zinc-500">A fast, lightweight git graph for your machine</p>
        </div>
      </header>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Open a repository</h2>
        <div className="flex gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-emerald-600"
            placeholder="/absolute/path/to/repo"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void openRepo(pathInput)}
            autoFocus
          />
          <button
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            disabled={!pathInput.trim() || !!busy}
            onClick={() => void openRepo(pathInput)}
          >
            <ArrowRight className="h-4 w-4" /> Open
          </button>
        </div>
        {busy && busy !== 'clone' && <p className="mt-2 text-xs text-zinc-500">checking {busy}…</p>}
      </section>

      <section className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="mb-3 flex items-center gap-2 text-sm font-medium text-zinc-400">
          <Download className="h-4 w-4" /> Clone a repository
        </h2>
        <div className="flex flex-col gap-2">
          <input
            className="w-full rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-emerald-600"
            placeholder="https://github.com/user/repo.git"
            value={cloneUrl}
            onChange={(e) => setCloneUrl(e.target.value)}
          />
          <div className="flex gap-2">
            <input
              className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-emerald-600"
              placeholder="Destination directory (optional)"
              value={cloneDest}
              onChange={(e) => setCloneDest(e.target.value)}
            />
            <button
              className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
              disabled={!cloneUrl.trim() || !!busy}
              onClick={() => void doClone()}
            >
              Clone
            </button>
          </div>
          {busy === 'clone' && <p className="text-xs text-zinc-500">cloning…</p>}
        </div>
      </section>

      {recentRepos.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium text-zinc-400">Recent repositories</h2>
          <ul className="divide-y divide-zinc-800/60 overflow-hidden rounded-xl border border-zinc-800">
            {recentRepos.map((r) => (
              <li key={r} className="flex items-center gap-3 bg-zinc-900/40 px-4 py-2.5 hover:bg-zinc-900">
                <FolderGit2 className="h-4 w-4 shrink-0 text-zinc-500" />
                <button
                  className="min-w-0 flex-1 truncate text-left font-mono text-sm text-zinc-200 hover:text-emerald-400"
                  onClick={() => void openRepo(r)}
                  title={r}
                >
                  {r}
                </button>
                <button
                  className="rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
                  onClick={() => removeRecentRepo(r)}
                  title="Remove from list"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {recentRepos.length === 0 && (
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-800 px-4 py-6 text-sm text-zinc-500">
          <Plus className="h-4 w-4" /> No repositories yet — open a path above to get started.
        </p>
      )}
    </div>
  )
}
