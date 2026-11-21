import { GitRequestError } from './client'

const FRIENDLY: Record<string, string> = {
  'not-a-repository': 'This path is not a git repository',
  'no-commits': 'This repository has no commits yet',
  'no-head': 'HEAD cannot be resolved (unborn branch?)',
  'bad-revision': 'Unknown revision',
  'merge-failed': 'Merge conflict — resolve conflicts in the staging area',
  'non-fast-forward': 'Push rejected (non-fast-forward). Fetch first, or force-push if you are sure',
  offline: 'Could not reach the remote (offline?)',
  'authentication-failed': 'Authentication with the remote failed',
  'local-changes-would-be-overwritten': 'Your local changes would be overwritten — commit or discard first',
  'nothing-to-commit': 'Nothing to commit — working tree clean',
  'missing-identity': 'Git needs your identity: set user.name / user.email',
  'already-exists': 'That name already exists',
  'no-upstream': 'This branch has no upstream to pull from',
  'branch-checked-out': 'Cannot delete the checked-out branch',
  'checkout-conflict': 'Your local changes conflict with this checkout',
  'merge-in-progress': 'A merge is already in progress',
  'rebase-in-progress': 'A rebase is already in progress',
  timeout: 'The git command timed out',
  'dubious-ownership': 'Git refuses this repo (dubious ownership). Run: git config --global --add safe.directory <path>',
  'terminal-prompts-disabled': 'Git needed terminal input (credentials) which sirgit cannot provide here',
  'server-unreachable': 'Cannot reach the sirgit server',
}

export function friendlyError(e: unknown): { title: string; detail?: string } {
  if (e instanceof GitRequestError) {
    const title = FRIENDLY[e.code] ?? e.message
    const detail = e.stderr?.trim().split('\n').slice(0, 4).join('\n')
    return { title, detail: detail || undefined }
  }
  return { title: e instanceof Error ? e.message : String(e) }
}
