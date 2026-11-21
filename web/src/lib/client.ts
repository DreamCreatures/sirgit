export class GitRequestError extends Error {
  code: string
  command?: string
  stderr?: string

  constructor(code: string, message: string, command?: string, stderr?: string) {
    super(message)
    this.code = code
    this.command = command
    this.stderr = stderr
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch('/api' + path, {
      headers: init?.body ? { 'content-type': 'application/json' } : undefined,
      ...init,
    })
  } catch (e) {
    throw new GitRequestError('server-unreachable', 'Cannot reach the sirgit server')
  }
  if (!res.ok) {
    let code = 'unknown'
    let message = res.statusText
    let command: string | undefined
    let stderr: string | undefined
    try {
      const body = await res.json()
      if (body?.error) {
        code = body.error.code ?? code
        message = body.error.message ?? message
        command = body.error.command
        stderr = body.error.stderr
      }
    } catch {
      /* non-json error */
    }
    throw new GitRequestError(code, message, command, stderr)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

async function text(path: string): Promise<string> {
  const res = await fetch('/api' + path)
  if (!res.ok) throw new GitRequestError('diff-failed', `failed to load diff (${res.status})`)
  return res.text()
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) })
}

/**
 * Poll a network op (fetch/pull/push) to completion. Failures surface as
 * GitRequestError carrying the git error code (e.g. 'non-fast-forward').
 */
export async function pollOp(opId: string): Promise<void> {
  for (;;) {
    const op = await api.opStatus(opId)
    if (op.status === 'done') return
    if (op.status === 'error') {
      const err = op.error
      throw new GitRequestError(
        err?.code ?? 'unknown',
        err?.message ?? 'operation failed',
        err?.command,
        err?.stderr,
      )
    }
    await new Promise((r) => setTimeout(r, 700))
  }
}

export const api = {
  quickstatus: (path: string) =>
    request<import('./types').QuickStatus>(`/quickstatus?path=${encodeURIComponent(path)}`),

  log: (path: string, offset: number, limit: number) =>
    request<import('./types').LogPage>(
      `/log?path=${encodeURIComponent(path)}&offset=${offset}&limit=${limit}`,
    ),

  logDelta: (path: string, fromRev: number) =>
    request<import('./types').DeltaResponse>(
      `/log/delta?path=${encodeURIComponent(path)}&fromRev=${fromRev}`,
    ),

  refs: (path: string) =>
    request<import('./types').RefsResponse>(`/refs?path=${encodeURIComponent(path)}`),

  status: (path: string) =>
    request<import('./types').StatusResponse>(`/status?path=${encodeURIComponent(path)}`),

  commitDetail: (path: string, sha: string) =>
    request<import('./types').CommitDetail>(
      `/commit/${sha}?path=${encodeURIComponent(path)}`,
    ),

  commitFileDiff: (path: string, sha: string, file: string) =>
    text(`/commit/${sha}/diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}`),

  worktreeDiff: (path: string, file: string, staged: boolean) =>
    text(`/diff?path=${encodeURIComponent(path)}&file=${encodeURIComponent(file)}&staged=${staged}`),

  stage: (path: string, files: string[]) => post('/stage', { path, files }),
  unstage: (path: string, files: string[]) => post('/unstage', { path, files }),
  discard: (path: string, files: string[], untracked: string[]) =>
    post('/discard', { path, files, untracked }),
  commit: (path: string, message: string, amend = false, allowEmpty = false) =>
    post('/commit', { path, message, amend, allowEmpty }),
  checkout: (path: string, ref: string, remote?: string) =>
    post('/checkout', { path, ref, remote }),
  branchCreate: (path: string, name: string, sha: string, checkout = false) =>
    post('/branch/create', { path, name, sha, checkout }),
  branchDelete: (path: string, name: string, force = false) =>
    post('/branch/delete', { path, name, force }),
  branchRename: (path: string, oldName: string, newName: string) =>
    post('/branch/rename', { path, oldName, newName }),
  tagRename: (path: string, oldName: string, newName: string) =>
    post('/tag/rename', { path, oldName, newName }),
  uncommit: (path: string) => post('/uncommit', { path }),
  branchMove: (path: string, branch: string, target: string) =>
    post('/branch/move', { path, branch, target }),
  branchMerge: (path: string, from: string, into: string, squash = false) =>
    post<{ title?: string; body?: string }>('/branch/merge', { path, from, into, squash }),
  squash: (path: string, branch: string, target: string) =>
    post<{ title?: string; body?: string }>('/squash', { path, branch, target }),
  tagCreate: (path: string, name: string, sha: string) =>
    post('/tag/create', { path, name, sha }),
  tagDelete: (path: string, name: string) => post('/tag/delete', { path, name }),
  resolve: (path: string, files: string[]) => post('/resolve', { path, files }),
  mergeContinue: (path: string, message?: string) =>
    post('/merge/continue', { path, message }),
  mergeAbort: (path: string) => post('/merge/abort', { path }),
  rebaseStart: (path: string, onto: string) => post('/rebase/start', { path, onto }),
  rebaseContinue: (path: string) => post('/rebase/continue', { path }),
  rebaseAbort: (path: string) => post('/rebase/abort', { path }),
  revert: (path: string, sha: string) => post('/revert', { path, sha }),
  revertContinue: (path: string) => post('/revert/continue', { path }),
  revertAbort: (path: string) => post('/revert/abort', { path }),
  cherryPick: (path: string, sha: string) => post('/cherry-pick', { path, sha }),

  stashList: async (path: string): Promise<import('./types').StashEntry[]> =>
    (await request<{ stashes: import('./types').StashEntry[] }>(`/stash?path=${encodeURIComponent(path)}`)).stashes,
  stashFiles: async (path: string, index: number): Promise<import('./types').StashFile[]> =>
    (
      await request<{ files: import('./types').StashFile[] }>(
        `/stash/files?path=${encodeURIComponent(path)}&index=${index}`,
      )
    ).files,
  stashPush: (path: string, message?: string) => post('/stash/push', { path, message }),
  stashApply: (path: string, index: number, pop = false) =>
    post('/stash/apply', { path, index, pop }),
  stashDrop: (path: string, index: number) => post('/stash/drop', { path, index }),

  fetch: (path: string, remote?: string) => post<{ opId: string }>('/fetch', { path, remote }),
  push: (path: string, remote: string, refspec: string, force = false) =>
    post<{ opId: string }>('/push', { path, remote, refspec, force }),
  pull: (path: string, branch?: string) => post<{ opId: string }>('/pull', { path, branch }),
  clone: (url: string, path: string, recurseSubmodules = false) =>
    post<{ opId: string }>('/clone', { url, path, recurseSubmodules }),
  init: (path: string, bare = false) => post('/init', { path, bare }),
  createDir: (path: string) => post('/createdir', { path }),
  opStatus: (opId: string) => request<import('./types').OpState>(`/ops/${opId}`),
  credentialsResponse: (opId: string, username: string, password: string) =>
    post('/credentials-response', { opId, username, password }),
  credentialsCancel: (opId: string) => post('/credentials-cancel', { opId }),

  config: () => request<import('./types').AppConfig>('/config'),
}
