export interface CommitRow {
  sha: string
  parents: string[]
  author: string
  authorDate: number
  commitDate: number
  subject: string
}

export type RefKind = 'branch' | 'remote-branch' | 'tag'

export interface RefInfo {
  name: string
  sha: string
  type: RefKind
  upstream?: string
}

export interface Head {
  sha?: string
  branch?: string
  detached: boolean
}

export interface RefsSnapshot {
  branches: RefInfo[]
  remoteBranches: RefInfo[]
  tags: RefInfo[]
  /** tag names that exist on the remote (ls-remote cache) — drives og/<tag> */
  remoteTags: string[]
  remotes: string[]
  head: Head
  upstream?: string
  ahead: number
  behind: number
}

export interface FileEntry {
  path: string
  origPath?: string
  indexStatus: string
  worktreeStatus: string
  untracked: boolean
  conflict: boolean
  additions?: number
  deletions?: number
  binary: boolean
}

export interface StatusSnapshot {
  headOid?: string
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  files: FileEntry[]
  inMerge: boolean
  inRebase: boolean
  inCherry: boolean
  inRevert: boolean
}

export interface CommitFile {
  path: string
  origPath?: string
  status: string
  additions?: number
  deletions?: number
  binary: boolean
}

export interface CommitDetail {
  sha: string
  parents: string[]
  authorName: string
  authorEmail: string
  authorDate: number
  committerName: string
  committerEmail: string
  commitDate: number
  subject: string
  body: string
  files: CommitFile[]
  additions: number
  deletions: number
}

export interface LogPage {
  revision: number
  offset: number
  total: number
  rows: CommitRow[]
}

export interface DeltaResponse {
  revision: number
  changed: boolean
  reset?: boolean
  added?: CommitRow[]
  removed?: string[]
}

export interface QuickStatus {
  type: 'no-such-path' | 'uninited' | 'repo' | 'bare'
  gitRootPath?: string
  gitDir?: string
  subRepos?: string[]
}

export interface OpState {
  op: string
  path: string
  status: 'running' | 'done' | 'error'
  progress: string[]
  error?: { code: string; message: string; command?: string; stderr?: string }
}

export interface RefsResponse extends RefsSnapshot {
  revision: number
}

export interface StatusResponse extends StatusSnapshot {
  revision: number
}

export interface ServerEvent {
  type: 'hello' | 'changed' | 'op-progress' | 'credentials-request'
  revision?: number
  kinds?: string[]
  opId?: string
  op?: string
  text?: string
  done?: boolean
  remote?: string
}

export interface AppConfig {
  port: number
  launchBrowser: boolean
  autoFetchOnOpen: boolean
  pageSize: number
  theme: string
}

export interface StashEntry {
  index: number
  sha: string
  /** unix seconds of the stash commit */
  date: number
  /** raw subject, e.g. "WIP on main: ab12345 fix the thing" */
  subject: string
}

export interface StashFile {
  path: string
  /** name-status letter (A/M/D/R) */
  status: string
  additions?: number
  deletions?: number
}
