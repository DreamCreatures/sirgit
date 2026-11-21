#!/usr/bin/env node
/**
 * Generate a large fixture repository via git fast-import for performance testing.
 * Usage: node scripts/make-big-repo.mjs /tmp/sirgit-big [commitCount]
 *
 * Shape: 70% linear main, 20% feature branch off main, 10% main continuing,
 * ending in a merge of the feature branch — exercises lanes + merges.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const target = resolve(process.argv[2] ?? '/tmp/sirgit-big')
const count = parseInt(process.argv[3] ?? '50000', 10)

const nMain1 = Math.floor(count * 0.7)
const nFeature = Math.floor(count * 0.2)
const nMain2 = count - nMain1 - nFeature - 1 // -1 for the merge commit

rmSync(target, { recursive: true, force: true })
mkdirSync(target, { recursive: true })
const git = (args, opts = {}) => {
  const r = spawnSync('git', args, { stdio: ['pipe', 'inherit', 'inherit'], ...opts })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed`)
}

git(['init', '-q', '-b', 'main', target])
git(['-C', target, 'config', 'user.email', 'bench@sirgit'])
git(['-C', target, 'config', 'user.name', 'Bench'])

const chunks = []
let mark = 0
let ts = 1700000000

const commit = (ref, extra = []) => {
  mark++
  ts += 60
  const msg = `commit ${mark}: touching file${mark % 100}.txt\n`
  const content = `content ${mark}\n`
  chunks.push(
    `commit ${ref}\n`,
    `mark :${mark}\n`,
    `author Bench <bench@sirgit> ${ts} +0000\n`,
    `committer Bench <bench@sirgit> ${ts} +0000\n`,
    `data ${Buffer.byteLength(msg)}\n${msg}\n`,
    ...extra, // from/merge — must follow the data line per fast-import format
    `M 100644 inline file${mark % 100}.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`,
  )
}

// phase 1: linear main
for (let i = 0; i < nMain1; i++) commit('refs/heads/main')
const branchFrom = mark

// phase 2: feature branch
chunks.push(`reset refs/heads/feature/big\nfrom :${branchFrom}\n`)
for (let i = 0; i < nFeature; i++) commit('refs/heads/feature/big')
const featureTip = mark

// phase 3: main continues, then merges the feature
for (let i = 0; i < nMain2; i++) commit('refs/heads/main')
commit('refs/heads/main', [`from :${mark}\n`, `merge :${featureTip}\n`])

chunks.push('done\n')

const t0 = Date.now()
spawnSync('git', ['-C', target, 'fast-import', '--quiet'], {
  input: chunks.join(''),
  maxBuffer: 1024 * 1024 * 64,
  stdio: ['pipe', 'inherit', 'inherit'],
})
git(['-C', target, 'reset', '--hard', '-q', 'main'])
git(['-C', target, 'gc', '--quiet', '--aggressive'])
const dt = ((Date.now() - t0) / 1000).toFixed(1)
console.log(`done: ~${count} commits (${nMain1}+${nFeature}+${nMain2}+1merge) in ${dt}s → ${target}`)
