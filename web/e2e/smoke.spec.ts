import { test, expect } from '@playwright/test'
import { execSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * E2E smoke: fixture repo → open in sirgit → graph renders → stage → commit
 * → graph updates. Runs against the Rust server (started via playwright config
 * or externally with SIRGIT_URL).
 */

let repoPath: string

test.beforeAll(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'sirgit-e2e-'))
  const g = (args: string) =>
    execSync(`git ${args}`, {
      cwd: repoPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'E2E',
        GIT_AUTHOR_EMAIL: 'e2e@sirgit',
        GIT_COMMITTER_NAME: 'E2E',
        GIT_COMMITTER_EMAIL: 'e2e@sirgit',
      },
    })
  g('init -q -b main')
  // repo-local identity: the UI commit runs through the SERVER's git spawn,
  // which has none of the env above and no global config on CI
  g('config user.name E2E')
  g('config user.email e2e@sirgit')
  writeFileSync(join(repoPath, 'hello.txt'), 'hello world\n')
  g('add .')
  g('commit -qm "initial commit"')
  g('branch feature')
})

test('open repo, see graph, stage and commit through the UI', async ({ page }) => {
  await page.goto(`/#/repository?path=${encodeURIComponent(repoPath)}`)

  // graph renders the initial commit
  await expect(page.getByTestId('graph-row').first()).toContainText('initial commit', {
    timeout: 10_000,
  })
  await expect(page.getByText('main (HEAD)')).toBeVisible()

  // refs panel shows both branches
  await expect(page.getByRole('button', { name: /Branches \(2\)/ })).toBeVisible()

  // worktree change appears live (watch → invalidation)
  writeFileSync(join(repoPath, 'e2e.txt'), 'staged by e2e\n')
  await expect(page.getByText('e2e.txt')).toBeVisible({ timeout: 5_000 })

  // stage + commit through the UI
  await page.getByRole('button', { name: 'Stage file' }).first().click()
  await page.getByTestId('commit-input').fill('commit from e2e test')
  await page.getByTestId('commit-button').click()

  // graph updates with the new commit on top
  await expect(page.getByTestId('graph-row').first()).toContainText('commit from e2e test', {
    timeout: 8_000,
  })
  await expect(page.getByTestId('graph-row').first()).toContainText('main (HEAD)')
})

test('virtualized graph stays flat on a paged history', async ({ page }) => {
  await page.goto(`/#/repository?path=${encodeURIComponent(repoPath)}`)
  await expect(page.getByTestId('graph-row').first()).toBeVisible({ timeout: 10_000 })
  const rows = await page.getByTestId('graph-row').count()
  // visible window only — a handful of rows, not the whole history
  expect(rows).toBeLessThan(60)
})
