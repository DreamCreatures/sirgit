import { create } from 'zustand'

export interface Toast {
  id: number
  kind: 'error' | 'info' | 'success'
  title: string
  detail?: string
}

/**
 * In-app replacement for window.prompt/confirm — embedded browsers (and
 * Playwright) suppress native dialogs, so every prompt/confirm flow goes
 * through this. Callbacks are transient closures, not persisted anywhere.
 */
export type AppDialog =
  | {
      kind: 'confirm'
      title: string
      message?: string
      confirmLabel?: string
      danger?: boolean
      /** returning a Promise keeps the dialog open with a spinner until it settles */
      onConfirm: () => void | Promise<unknown>
      /** optional THIRD choice (checkout-with-changes: Confirm = bring, alt = stash) */
      altLabel?: string
      onAlt?: () => void | Promise<unknown>
      /** commit-creating op: its target sha — hovering the confirm previews the ghost node above it */
      ghostPreview?: string
    }
  | {
      kind: 'prompt'
      title: string
      initial: string
      confirmLabel?: string
      note?: string
      /** returning a Promise keeps the dialog open with a spinner until it settles */
      onConfirm: (value: string) => void | Promise<unknown>
      /** commit-creating op: its target sha — hovering the confirm previews the ghost node above it */
      ghostPreview?: string
    }

/** What the user clicked: a branch/tag/remote ref, or nothing (the commit node itself). */
export interface SelectedRef {
  kind: 'branch' | 'tag' | 'remote-branch'
  name: string
}

interface UiState {
  selectedSha: string | null
  /**
   * The ref the user explicitly picked (branch chip/row click) — null when
   * they selected the commit node itself. Branch/tag actions operate on the
   * ref; node actions (Details, create branch/tag) on the commit. Splitting
   * these keeps sibling branches on one commit individually selectable.
   */
  selectedRef: SelectedRef | null
  select(sha: string | null, ref?: SelectedRef | null): void

  /** Native-dialog replacement (confirm / prompt with input) */
  dialog: AppDialog | null
  setDialog(d: AppDialog | null): void

  stagingOpen: boolean
  toggleStaging(): void

  /** Stash section (above the staging area) expanded */
  stashOpen: boolean
  toggleStash(): void

  /** Graph view: hide every row's commit subject except HEAD's (hover peeks) */
  subjectCompact: boolean
  setSubjectCompact(v: boolean): void

  /**
   * Left-panel branch-list filter. Graph map is NEVER filtered — only this
   * panel shrinks. track = local branches with an upstream or a remote twin;
   * untrack = the complement (created locally, never pushed) — the pair
   * drives branch cleanup; recent = the last 10 branches CHECKED OUT (HEAD
   * reflog, still existing; current branch always listed).
   */
  branchFilter: 'all' | 'track' | 'untrack' | 'recent'
  setBranchFilter(v: 'all' | 'track' | 'untrack' | 'recent'): void

  /**
   * One-shot commit-box prefill (amend-style) — set by squash merge with the
   * messages gathered from the squashed commits; the staging panel consumes
   * and clears it so the user reviews and commits.
   */
  commitPrefill: { title: string; body: string } | null
  setCommitPrefill(v: { title: string; body: string } | null): void

  /** Staging panel grown inline (taller commit box + changes area) */
  stagingExpanded: boolean
  setStagingExpanded(v: boolean): void

  /** an action that would create a commit is hovered — the sha its new commit lands on (ghost preview target) */
  ghostPreview: string | null
  setGhostPreview(v: string | null): void

  toasts: Toast[]
  toast(t: Omit<Toast, 'id'>): void
  dismissToast(id: number): void

  credentialsRequest: { opId: string; remote: string } | null
  setCredentialsRequest(req: { opId: string; remote: string } | null): void

  /** Label of the running network op (fetch/pull/push) across all panels, null when idle */
  netBusy: string | null
  setNetBusy(label: string | null): void

  /**
   * Any repo-altering op is in flight (network or local: push, checkout,
   * rebase, move, commit, …). Every mutating helper wraps its promise in
   * beginOp/endOp; the BusyOverlay then blocks the whole app (below
   * dialogs/modals/credentials, which stay usable for their own flow).
   */
  busyCount: number
  busyLabel: string | null
  beginOp(label: string): void
  endOp(): void

  /**
   * Hover preview for a row action button (ungit-style): which operation,
   * on which target row, by which armed subject. Drives the on-graph
   * preview overlay (rebase stack, squash rings, move rings) and the
   * spotlight dimming of uninvolved rows.
   */
  actionPreview: { op: 'move' | 'rebase' | 'squash' | 'merge' | 'squash-merge'; targetSha: string; subjectTipSha: string; subjectBranch: string } | null
  setActionPreview(v: UiState['actionPreview']): void

  /**
   * Post-checkout: scroll the graph to this row once it is (re)loaded —
   * a branch checked out from the sidebar may tip far off-screen.
   */
  scrollToSha: string | null
  requestScrollTo(sha: string): void
  clearScrollTo(): void

  /** Commit whose details are shown in the right drawer (opened via the [Details] action) */
  detailsSha: string | null
  setDetailsSha(sha: string | null): void

  /**
   * Drag-and-drop move: the commit row currently under the dragged
   * branch/tag chip — drives the drop highlight and the 50% sibling spread
   * (live preview of where the chip lands). Transient, cleared on
   * drop/leave/drag-end.
   */
  dragOverSha: string | null
  setDragOverSha(sha: string | null): void

  /**
   * One-shot seed for the home page's Open input — set by the repo page's
   * back arrow to the previous repo's PARENT directory (with trailing slash,
   * so the sibling autocomplete opens ready). Consumed on HomePage mount.
   */
  backSeedPath: string | null
  setBackSeedPath(v: string | null): void

  /** Open squash modal: branch → target picked, awaiting confirmation */
  squashModal: { branch: string; branchTipSha: string; targetSha: string } | null
  setSquashModal(v: { branch: string; branchTipSha: string; targetSha: string } | null): void

  /** Panel layout: left sidebar width/collapsed, right drawer width (persisted) */
  refsPanelWidth: number
  refsPanelCollapsed: boolean
  commitDetailWidth: number
  setRefsPanelWidth(w: number): void
  setRefsPanelCollapsed(v: boolean): void
  setCommitDetailWidth(w: number): void

  recentRepos: string[]
  addRecentRepo(path: string): void
  removeRecentRepo(path: string): void
  clearRecentRepos(): void

  /**
   * The home page's repository list — a growing union of imports: submitting
   * a working directory adds its valid repos, cloning adds the clone's
   * directory; unique by directory (multiple roots accumulate, no fixed root).
   */
  repos: string[]
  addRepos(paths: string[]): void
  removeRepo(path: string): void
  clearRepos(): void

  /**
   * Most recent working directory used on the home page (Add-submit root or
   * a clone's destination parent) — the default ROOT for clone destinations.
   */
  lastWorkDir: string | null
  setLastWorkDir(v: string): void
}

let toastId = 0

const RECENTS_KEY = 'sirgit.recentRepos'
const REPOS_KEY = 'sirgit.repos'

function loadRepos(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(REPOS_KEY) ?? '[]') as string[]
    // normalize + dedupe (self-heals pre-fix entries like "/a/b/" vs "/a/b")
    const out: string[] = []
    for (const r of raw) {
      const n = normPath(r)
      if (!out.includes(n)) out.push(n)
    }
    // write the healed list back so duplicates don't linger until the next
    // store mutation
    if (out.length !== raw.length) localStorage.setItem(REPOS_KEY, JSON.stringify(out))
    return out
  } catch {
    return []
  }
}

/** trailing slashes off ("/a/b/" === "/a/b"; "/" stays "/") */
function normPath(p: string): string {
  return p.replace(/\/+$/, '') || '/'
}

function loadNum(key: string, fallback: number): number {
  const v = parseInt(localStorage.getItem(key) ?? '', 10)
  return Number.isFinite(v) && v > 0 ? v : fallback
}

function loadRecents(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? '[]') as string[]
    const out: string[] = []
    for (const r of raw) {
      const n = normPath(r)
      if (!out.includes(n)) out.push(n)
    }
    if (out.length !== raw.length) localStorage.setItem(RECENTS_KEY, JSON.stringify(out))
    return out
  } catch {
    return []
  }
}

export const useUiStore = create<UiState>((set, get) => ({
  selectedSha: null,
  selectedRef: null,
  select: (sha, ref) => set({ selectedSha: sha, selectedRef: ref ?? null, actionPreview: null }),

  dialog: null,
  setDialog: (d) => set({ dialog: d }),

  stagingOpen: true,
  toggleStaging: () => set((s) => ({ stagingOpen: !s.stagingOpen })),

  stashOpen: true,
  toggleStash: () => set((s) => ({ stashOpen: !s.stashOpen })),

  subjectCompact: localStorage.getItem('sirgit.subjectCompact') === '1',
  setSubjectCompact: (v) => {
    localStorage.setItem('sirgit.subjectCompact', v ? '1' : '0')
    set({ subjectCompact: v })
  },

  branchFilter: ((): 'all' | 'track' | 'untrack' | 'recent' => {
    const v = localStorage.getItem('sirgit.branchFilter')
    if (v === 'track' || v === 'untrack' || v === 'recent') return v
    // 'tracking' is the pre-rename spelling of track; 'local' was the
    // short-lived middle slot before it became Track/Untrack → back to All
    if (v === 'tracking') return 'track'
    return 'all'
  })(),
  setBranchFilter: (v) => {
    localStorage.setItem('sirgit.branchFilter', v)
    set({ branchFilter: v })
  },

  commitPrefill: null,
  setCommitPrefill: (v) => set({ commitPrefill: v }),

  stagingExpanded: localStorage.getItem('sirgit.stagingExpanded') === '1',
  setStagingExpanded: (v) => {
    localStorage.setItem('sirgit.stagingExpanded', v ? '1' : '0')
    set({ stagingExpanded: v })
  },

  ghostPreview: null,
  setGhostPreview: (v) => set({ ghostPreview: v }),

  toasts: [],
  toast(t) {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { ...t, id }] }))
    setTimeout(() => get().dismissToast(id), t.kind === 'error' ? 8000 : 3500)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  credentialsRequest: null,
  setCredentialsRequest: (req) => set({ credentialsRequest: req }),

  netBusy: null,
  setNetBusy: (label) => set({ netBusy: label }),

  busyCount: 0,
  busyLabel: null,
  beginOp: (label) => set((s) => ({ busyCount: s.busyCount + 1, busyLabel: label })),
  endOp: () =>
    set((s) => ({ busyCount: Math.max(0, s.busyCount - 1), busyLabel: s.busyCount <= 1 ? null : s.busyLabel })),

  actionPreview: null,
  setActionPreview: (v: UiState['actionPreview']) => set({ actionPreview: v }),

  scrollToSha: null,
  requestScrollTo: (sha) => set({ scrollToSha: sha }),
  clearScrollTo: () => set({ scrollToSha: null }),

  squashModal: null,
  setSquashModal: (v: UiState['squashModal']) => set({ squashModal: v }),

  detailsSha: null,
  setDetailsSha: (sha) => set({ detailsSha: sha }),

  dragOverSha: null,
  setDragOverSha: (sha) => set({ dragOverSha: sha }),

  backSeedPath: null,
  setBackSeedPath: (v) => set({ backSeedPath: v }),

  // 234px minimum: keeps the panel's branch/tag rows and header controls
  // (filter toggle + collapse) from crowding
  refsPanelWidth: Math.max(234, loadNum('sirgit.refsPanelWidth', 256)),
  refsPanelCollapsed: localStorage.getItem('sirgit.refsPanelCollapsed') === '1',
  commitDetailWidth: loadNum('sirgit.commitDetailWidth', 440),
  setRefsPanelWidth: (w) => {
    const clamped = Math.max(234, Math.min(520, Math.round(w)))
    localStorage.setItem('sirgit.refsPanelWidth', String(clamped))
    set({ refsPanelWidth: clamped })
  },
  setRefsPanelCollapsed: (v) => {
    localStorage.setItem('sirgit.refsPanelCollapsed', v ? '1' : '0')
    set({ refsPanelCollapsed: v })
  },
  setCommitDetailWidth: (w) => {
    const clamped = Math.max(320, Math.min(820, Math.round(w)))
    localStorage.setItem('sirgit.commitDetailWidth', String(clamped))
    set({ commitDetailWidth: clamped })
  },

  recentRepos: loadRecents(),
  addRecentRepo(path) {
    // top-10 cap (user rule) — recency order, deduped, slash-normalized
    const p = normPath(path)
    const next = [p, ...get().recentRepos.filter((r) => r !== p)].slice(0, 10)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
    set({ recentRepos: next })
  },
  removeRecentRepo(path) {
    const next = get().recentRepos.filter((r) => r !== path)
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next))
    set({ recentRepos: next })
  },
  clearRecentRepos() {
    localStorage.setItem(RECENTS_KEY, '[]')
    set({ recentRepos: [] })
  },

  repos: loadRepos(),
  addRepos(paths) {
    const cur = get().repos
    const next = [...paths.map(normPath).filter((p) => !cur.includes(p)), ...cur].slice(0, 200)
    localStorage.setItem(REPOS_KEY, JSON.stringify(next))
    set({ repos: next })
  },
  removeRepo(path) {
    const next = get().repos.filter((r) => r !== path)
    localStorage.setItem(REPOS_KEY, JSON.stringify(next))
    set({ repos: next })
  },
  clearRepos() {
    localStorage.setItem(REPOS_KEY, '[]')
    set({ repos: [] })
  },

  lastWorkDir: localStorage.getItem('sirgit.lastWorkDir'),
  setLastWorkDir: (v) => {
    localStorage.setItem('sirgit.lastWorkDir', v)
    set({ lastWorkDir: v })
  },
}))
