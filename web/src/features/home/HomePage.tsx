import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useNavigate } from 'react-router'
import { useQuery } from '@tanstack/react-query'
import { Folder, FolderGit2, Download, Plus, Trash2, ArrowRight, GitBranch } from 'lucide-react'
import { api, pollOp } from '../../lib/client'
import type { DirEntry } from '../../lib/types'
import { useUiStore } from '../../state/uiStore'
import { friendlyError } from '../../lib/gitErrors'

function cleanPath(p: string): string {
  return p.trim()
}

export default function HomePage() {
  const navigate = useNavigate()
  const { recentRepos, addRecentRepo, removeRecentRepo, clearRecentRepos, repos, addRepos, removeRepo, clearRepos, toast } =
    useUiStore()
  const [pathInput, setPathInput] = useState(() => useUiStore.getState().backSeedPath ?? '')
  useEffect(() => {
    // seeded by the repo page's back arrow (the previous repo's parent dir).
    // Consume AFTER mount — clearing the store during render makes React
    // discard and retry the first render, and the retry would read null
    useUiStore.getState().setBackSeedPath(null)
  }, [])
  const [cloneUrl, setCloneUrl] = useState('')
  const [cloneDest, setCloneDest] = useState('')
  const [busy, setBusy] = useState<string | null>(null)

  // --- ungit-style sibling autocomplete: as you type a path, list the typed
  // directory's children so switching to a SIBLING repo is a click away ---
  const [suggest, setSuggest] = useState<{ dir: string; entries: DirEntry[] } | null>(null)
  const [highlight, setHighlight] = useState(0)
  // arrows moved the highlight → Enter/Tab complete the pick; a plain Enter
  // (nothing touched) still opens the typed path
  const [touched, setTouched] = useState(false)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => {
      const v = pathInput.trim()
      const slash = v.lastIndexOf('/')
      if (!v || slash < 0) {
        setSuggest(null)
        return
      }
      const dir = v.slice(0, slash + 1)
      const typed = v.slice(slash + 1).toLowerCase()
      api
        .fsList(dir)
        .then((entries) => {
          setSuggest({ dir, entries: entries.filter((e) => e.name.toLowerCase().startsWith(typed)) })
          setHighlight(0)
          setTouched(false)
        })
        .catch(() => setSuggest(null))
    }, 120)
    return () => clearTimeout(t)
  }, [pathInput])

  const pickEntry = (e: DirEntry) => {
    if (!suggest) return
    // trailing slash invites drilling deeper (the effect lists its children)
    setPathInput(suggest.dir + e.name + '/')
    setHighlight(0)
    setTouched(false)
    inputRef.current?.focus()
  }

  /**
   * Submit a working directory: imports its valid repos into the list below
   * (a single repo path imports just itself; multiple roots accumulate over
   * time, deduped by directory). Submitting never navigates — rows in the
   * list do. Only dead-end paths fall into the init/create dialogs.
   */
  const submitPath = async (rawPath: string) => {
    const path = cleanPath(rawPath)
    if (!path) return
    setBusy(path)
    try {
      const qs = await api.quickstatus(path)
      if (qs.type === 'repo' || qs.type === 'bare') {
        addRepos([qs.gitRootPath ?? path])
        toast({ kind: 'success', title: 'Added to repositories', detail: qs.gitRootPath ?? path })
      } else if (qs.type === 'uninited') {
        const subs = qs.subRepos ?? []
        if (subs.length > 0) {
          addRepos(subs)
          toast({ kind: 'success', title: `Imported ${subs.length} repositor${subs.length === 1 ? 'y' : 'ies'}`, detail: path })
        } else {
          setBusy(null)
          useUiStore.getState().setDialog({
            kind: 'confirm',
            title: 'Initialize repository',
            message: `"${path}" is not a git repository and holds no repos. Initialize one here?`,
            confirmLabel: 'Init',
            onConfirm: () => {
              void api
                .init(path)
                .then(() => {
                  addRepos([path])
                  navigate(`/repository?path=${encodeURIComponent(path)}`)
                })
                .catch((e: unknown) => {
                  const { title: t, detail: d } = friendlyError(e)
                  toast({ kind: 'error', title: t, detail: d })
                })
            },
          })
        }
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
                addRepos([path])
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

  /** click a row in either list → open that repository */
  const openFromList = (path: string) => {
    addRecentRepo(path)
    navigate(`/repository?path=${encodeURIComponent(path)}`)
  }

  const onPathKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (suggest && suggest.entries.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((h) => Math.min(h + 1, suggest.entries.length - 1))
        setTouched(true)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((h) => Math.max(h - 1, 0))
        setTouched(true)
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && touched) {
        e.preventDefault()
        pickEntry(suggest.entries[highlight])
        return
      }
      if (e.key === 'Escape') {
        setSuggest(null)
        return
      }
    }
    if (e.key === 'Enter') void submitPath(pathInput)
  }

  const doClone = async () => {
    if (!cloneUrl.trim()) return
    const dest = cleanPath(cloneDest) || cloneUrl.split('/').pop()?.replace(/\.git$/, '') || 'repo'
    setBusy('clone')
    try {
      const { opId } = await api.clone(cloneUrl.trim(), dest)
      await pollOp(opId)
      // clones join the repository list by default (user rule), land in
      // recent, and open straight away
      addRepos([dest])
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
        <h2 className="mb-3 text-sm font-medium text-zinc-400">Add a working directory</h2>
        <div className="relative flex gap-2">
          <input
            ref={inputRef}
            className="min-w-0 flex-1 rounded-lg border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm outline-none placeholder:text-zinc-600 focus:border-emerald-600"
            placeholder="/parent/directory — or a single repo's absolute path"
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={onPathKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            autoFocus
            data-testid="path-input"
          />
          <button
            className="flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
            disabled={!pathInput.trim() || !!busy}
            onClick={() => void submitPath(pathInput)}
            data-testid="add-directory"
          >
            <ArrowRight className="h-4 w-4" /> Add
          </button>
          {focused && suggest && suggest.entries.length > 0 && (
            <ul
              className="absolute left-0 right-24 top-full z-20 mt-1 max-h-72 overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 py-1 shadow-2xl"
              data-testid="path-suggest"
            >
              {suggest.entries.slice(0, 50).map((en, i) => (
                <li key={en.name}>
                  <button
                    className={`flex w-full items-center gap-2 px-3 py-1.5 text-left font-mono text-sm ${
                      i === highlight ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-300 hover:bg-zinc-800/60'
                    }`}
                    onMouseDown={(e) => {
                      // preventDefault keeps the input's focus (no blur race)
                      e.preventDefault()
                      pickEntry(en)
                    }}
                    onMouseEnter={() => setHighlight(i)}
                    title={suggest.dir + en.name}
                  >
                    {en.git ? (
                      <FolderGit2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
                    ) : (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
                    )}
                    <span className="truncate">{en.name}</span>
                    {en.git && <span className="ml-auto shrink-0 text-[10px] text-emerald-500/80">git</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
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

      {/* repositories — the growing union of every imported root + clones */}
      {repos.length > 0 ? (
        <section data-testid="repo-list">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-400">Repositories</h2>
            <button
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              onClick={clearRepos}
              title="Clear the whole repository list"
              data-testid="clear-repos"
            >
              <Trash2 className="h-3 w-3" /> Clear
            </button>
          </div>
          <ul className="divide-y divide-zinc-800/60 overflow-hidden rounded-xl border border-zinc-800">
            {repos.map((r) => (
              <RepoListRow key={r} path={r} onOpen={() => openFromList(r)} onRemove={() => removeRepo(r)} testid="repo-row" />
            ))}
          </ul>
        </section>
      ) : (
        <p className="flex items-center gap-2 rounded-xl border border-dashed border-zinc-800 px-4 py-6 text-sm text-zinc-500">
          <Plus className="h-4 w-4" /> No repositories yet — add a working directory above to import its repos.
        </p>
      )}

      {/* recent — last visited, top 10 */}
      {recentRepos.length > 0 && (
        <section data-testid="recent-repos">
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-400">Recent</h2>
            <button
              className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-300"
              onClick={clearRecentRepos}
              title="Clear the recent list"
              data-testid="clear-recent"
            >
              <Trash2 className="h-3 w-3" /> Clear
            </button>
          </div>
          <ul className="divide-y divide-zinc-800/60 overflow-hidden rounded-xl border border-zinc-800">
            {recentRepos.slice(0, 10).map((r) => (
              <RepoListRow key={r} path={r} onOpen={() => openFromList(r)} onRemove={() => removeRecentRepo(r)} testid="recent-repo" />
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}

/**
 * One repository row (shared by the repositories list and recent). Validates
 * the path server-side (quickstatus, cached) and renders ONLY real
 * repositories — deleted or de-inited paths silently leave the view while
 * their entries stay until individually removed or the list is cleared.
 */
function RepoListRow({
  path,
  onOpen,
  onRemove,
  testid,
}: {
  path: string
  onOpen: () => void
  onRemove: () => void
  testid: string
}) {
  const qs = useQuery({
    queryKey: ['quickstatus', path],
    queryFn: () => api.quickstatus(path),
    staleTime: 5 * 60_000,
    retry: false,
  })
  if (!qs.data || (qs.data.type !== 'repo' && qs.data.type !== 'bare')) return null
  return (
    <li className="flex items-center gap-3 bg-zinc-900/40 px-4 py-2.5 hover:bg-zinc-900" data-testid={testid}>
      <FolderGit2 className="h-4 w-4 shrink-0 text-zinc-500" />
      <button
        className="min-w-0 flex-1 truncate text-left font-mono text-sm text-zinc-200 hover:text-emerald-400"
        onClick={onOpen}
        title={path}
      >
        {path}
      </button>
      <button
        className="rounded p-1 text-zinc-600 hover:bg-zinc-800 hover:text-zinc-300"
        onClick={onRemove}
        title="Remove from list"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </button>
    </li>
  )
}
