#!/usr/bin/env node
/**
 * sirgit performance benchmark — side-by-side with ungit on the same repo.
 *
 * Measures:
 *   1. API latency: sirgit (live :8449 warm + throwaway cold instance) vs
 *      ungit (:8448), including ungit's cumulative gitlog growth (limit=25k).
 *   2. Browser experience (headless Chromium, fresh profile, 1440x900):
 *      time-to-first-commit, bytes to interactive, full-history scroll race
 *      (sirgit scrolls ALL commits, ungit gets the same wheel budget),
 *      DOM node count (virtualization), rAF frame times, long tasks,
 *      CDP performance counters, JS heap. Records .webm videos.
 *
 * Usage (from web/):
 *   node scripts/perf-bench.mjs [--repo /path] [--out ../docs/performance-results.json] [--video-dir ../docs/perf]
 * Prereqs: sirgit on :8449, ungit on :8448, both reachable; playwright installed.
 */
import { chromium } from '@playwright/test'
import { spawn, execSync, execFileSync } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const flag = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : dflt
}
const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..') // repo root — script runs from web/ or anywhere
const REPO = flag('repo', '/Users/kbv/Projects/ungit')
const OUT = path.resolve(ROOT, flag('out', 'docs/performance-results.json'))
const VIDEO_DIR = path.resolve(ROOT, flag('video-dir', 'docs/perf'))
const SIRGIT = 'http://127.0.0.1:8449'
const UNGIT = 'http://127.0.0.1:8448'
const COLD_PORT = 8451

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const enc = encodeURIComponent
const git = (...a) => execFileSync('git', ['-C', REPO, ...a], { encoding: 'utf8' }).trim()

// ---------------------------------------------------------------- profiling
function profileRepo() {
  const count = +git('rev-list', '--count', 'HEAD')
  const first = git('log', '--reverse', '--format=%cI').split('\n')[0]
  const last = git('log', '-1', '--format=%cI')
  const refs = git('for-each-ref', '--format=%(refname)')
  const all = refs.split('\n').filter(Boolean)
  const pack = git('count-objects', '-vH').split('\n').find((l) => l.startsWith('size-pack'))
  return {
    path: REPO,
    commits: count,
    historySpan: [first.slice(0, 10), last.slice(0, 10)],
    localBranches: all.filter((r) => r.startsWith('refs/heads/')).length,
    remoteBranches: all.filter((r) => r.startsWith('refs/remotes/') && !r.endsWith('/HEAD')).length,
    tags: all.filter((r) => r.startsWith('refs/tags/')).length,
    packSize: pack?.split(': ')[1] ?? null,
    dirtyFiles: git('status', '--porcelain').split('\n').filter(Boolean).length,
  }
}

function rssOf(pid) {
  if (!pid) return null
  try {
    return +execSync(`ps -o rss= -p ${pid}`, { encoding: 'utf8' }).trim() // KiB
  } catch {
    return null
  }
}
function pidOf(port) {
  try {
    return +execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, { encoding: 'utf8' }).trim().split('\n')[0]
  } catch {
    return null
  }
}

// ------------------------------------------------------------- API bench
async function benchFetch(label, url, runs = 7) {
  const times = []
  let bytes = 0
  let status = 0
  let parsed = null
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now()
    const res = await fetch(url, { cache: 'no-store' })
    const body = await res.text()
    times.push(performance.now() - t0)
    status = res.status
    bytes = Buffer.byteLength(body)
    if (i === 0) {
      // keep only shape hints — full payloads bloat the results file
      try {
        const j = JSON.parse(body)
        parsed = Array.isArray(j.rows)
          ? { rows: j.rows.length }
          : Array.isArray(j.nodes)
            ? { nodes: j.nodes.length }
            : { keys: Object.keys(j).slice(0, 8) }
      } catch {
        parsed = null
      }
    }
  }
  const s = [...times].sort((a, b) => a - b)
  return {
    label,
    status,
    bytes,
    medianMs: +s[Math.floor(s.length / 2)].toFixed(1),
    minMs: +s[0].toFixed(1),
    maxMs: +s.at(-1).toFixed(1),
    parsed,
  }
}

async function apiBenchSirgit(base) {
  const head = git('rev-parse', 'HEAD')
  const out = {}
  out.log_first_page = await benchFetch('log offset=0 limit=200', `${base}/api/log?path=${enc(REPO)}&offset=0&limit=200`)
  out.log_deep_page = await benchFetch('log offset=2000 limit=200', `${base}/api/log?path=${enc(REPO)}&offset=2000&limit=200`)
  out.refs = await benchFetch('refs', `${base}/api/refs?path=${enc(REPO)}`)
  out.status = await benchFetch('status', `${base}/api/status?path=${enc(REPO)}`)
  out.commit_detail = await benchFetch('commit detail (numstat)', `${base}/api/commit/${head}?path=${enc(REPO)}`)
  return out
}

async function apiBenchUngit() {
  const out = {}
  out.gitlog_25 = await benchFetch('gitlog limit=25 skip=0', `${UNGIT}/api/gitlog?path=${enc(REPO)}&limit=25&skip=0`)
  out.gitlog_100 = await benchFetch('gitlog limit=100 skip=0', `${UNGIT}/api/gitlog?path=${enc(REPO)}&limit=100&skip=0`)
  out.gitlog_400 = await benchFetch('gitlog limit=400 skip=0', `${UNGIT}/api/gitlog?path=${enc(REPO)}&limit=400&skip=0`)
  out.gitlog_1200 = await benchFetch('gitlog limit=1200 skip=0', `${UNGIT}/api/gitlog?path=${enc(REPO)}&limit=1200&skip=0`)
  out.refs = await benchFetch('refs', `${UNGIT}/api/refs?path=${enc(REPO)}`)
  out.status = await benchFetch('status', `${UNGIT}/api/status?path=${enc(REPO)}`)
  return out
}

async function withColdSirgit(fn) {
  const bin = path.resolve(ROOT, 'server/target/debug/sirgit')
  const t0 = performance.now()
  const proc = spawn(bin, ['--port', String(COLD_PORT), '--no-open'], { stdio: 'ignore' })
  try {
    const deadline = Date.now() + 20000
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${COLD_PORT}/api/quickstatus?path=${enc(REPO)}`, {
          signal: AbortSignal.timeout(400),
        })
        if (r.status < 500) break
      } catch {
        /* not listening yet */
      }
      if (Date.now() > deadline) throw new Error('cold sirgit instance did not start')
      await sleep(150)
    }
    const startupMs = +(performance.now() - t0).toFixed(0)
    // quickstatus above does NOT populate the topology cache — the first
    // /api/log below is the true cold-cache request.
    const cold = await benchFetch('COLD log offset=0 limit=200', `http://127.0.0.1:${COLD_PORT}/api/log?path=${enc(REPO)}&offset=0&limit=200`, 1)
    const warm = await benchFetch('warm log offset=0 limit=200', `http://127.0.0.1:${COLD_PORT}/api/log?path=${enc(REPO)}&offset=0&limit=200`, 5)
    return { startupMs, cold, warm }
  } finally {
    proc.kill('SIGTERM')
  }
}

// ---------------------------------------------------------- browser bench
function probeScript(selector) {
  return `
  (() => {
    const SEL = ${JSON.stringify(selector)};
    window.__probe = { firstNodeAt: null, longTasks: [], frames: [], samples: [] };
    const p = window.__probe;
    const check = () => { if (p.firstNodeAt == null && document.querySelector(SEL)) p.firstNodeAt = performance.now(); };
    // NB: documentElement is still null when init scripts run — observe the
    // Document node itself (valid target, catches the whole subtree).
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
    check();
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) p.longTasks.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) });
      }).observe({ entryTypes: ['longtask'] });
    } catch {}
    let last = performance.now(), count = 0;
    const frame = (t) => {
      p.frames.push(t); count++;
      if (t - last >= 1000) {
        p.samples.push({ t: Math.round(t), fps: Math.round((count * 1000) / (t - last)), nodes: document.querySelectorAll(SEL).length });
        count = 0; last = t;
      }
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  })();`
}

function pct(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]
}

async function benchApp({ name, base, hash, selector, maxScrollMs, logPath, logCountKey, videoFile }) {
  const browser = await chromium.launch()
  fs.mkdirSync(VIDEO_DIR, { recursive: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    recordVideo: { dir: VIDEO_DIR, size: { width: 1440, height: 900 } },
  })
  const page = await context.newPage()
  const apiCalls = []
  page.on('response', async (res) => {
    try {
      const u = new URL(res.url())
      if (!u.pathname.startsWith('/api/')) return
      let bytes = 0
      let count = null
      try {
        const body = await res.body()
        bytes = body.length
        if (u.pathname === logPath) {
          const j = JSON.parse(body.toString())
          count = (j[logCountKey] ?? []).length
        }
      } catch {
        bytes = +(res.headers()['content-length'] || 0)
      }
      apiCalls.push({ path: u.pathname + u.search, bytes, count, at: Date.now() })
    } catch {
      /* body already consumed / streaming */
    }
  })

  await page.addInitScript(probeScript(selector))
  const cdp = await context.newCDPSession(page)
  await cdp.send('Performance.enable')

  const navT0Wall = Date.now()
  await page.goto(`${base}/#${hash}`, { waitUntil: 'domcontentloaded', timeout: 45000 })
  await page.waitForFunction('window.__probe && window.__probe.firstNodeAt != null', null, { timeout: 45000 })
  const wallToFirstNode = Date.now() - navT0Wall
  await sleep(3000) // settle: secondary fetches, ref panels, etc.

  const loadSnap = await page.evaluate((sel) => {
    const nav = performance.getEntriesByType('navigation')[0]
    return {
      firstNodeAt: Math.round(window.__probe.firstNodeAt),
      domContentLoaded: Math.round(nav?.domContentLoadedEventEnd ?? 0),
      nodes: document.querySelectorAll(sel).length,
      domTotal: document.getElementsByTagName('*').length,
    }
  }, selector)

  // dismiss any first-visit overlay (ungit shows a changelog modal on fresh profiles)
  for (const cand of ['.modal.show .btn-primary', '.modal.show button', '[data-dismiss="modal"]']) {
    const el = await page.$(cand)
    if (el && (await el.isVisible().catch(() => false))) {
      await el.click().catch(() => {})
      break
    }
  }
  await page.keyboard.press('Escape').catch(() => {})

  // ---- scroll phase: stream wheel events over the graph
  await page.mouse.move(720, 450)
  const scrollStart = Date.now()
  let lastLogProgress = 0
  let lastProgressAt = Date.now()
  let stopped = false
  const wheelLoop = (async () => {
    while (!stopped && Date.now() - scrollStart < maxScrollMs) {
      await page.mouse.wheel(0, 1200).catch(() => {})
      await sleep(40)
    }
  })()
  const progressLoop = (async () => {
    while (!stopped && Date.now() - scrollStart < maxScrollMs) {
      await sleep(500)
      const logs = apiCalls.filter((c) => c.path.split('?')[0] === logPath)
      const progress = logs.reduce((n, c) => n + (c.count ?? 0), 0)
      if (progress > lastLogProgress) {
        lastLogProgress = progress
        lastProgressAt = Date.now()
      } else if (Date.now() - lastProgressAt > 5000 && Date.now() - scrollStart > 10000) {
        stopped = true // nothing new has loaded for 5s — exhausted (or app can't keep up)
      }
    }
  })()
  await Promise.race([wheelLoop, progressLoop])
  stopped = true
  const scrollMs = Date.now() - scrollStart
  await sleep(1500) // let the last load land

  const endSnap = await page.evaluate((sel) => {
    const p = window.__probe
    const pct = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * arr.length))]
    const d = []
    for (let i = 1; i < p.frames.length; i++) d.push(p.frames[i] - p.frames[i - 1])
    d.sort((a, b) => a - b)
    return {
      nodes: document.querySelectorAll(sel).length,
      domTotal: document.getElementsByTagName('*').length,
      samples: p.samples,
      longTasks: p.longTasks,
      longTaskTotalMs: p.longTasks.reduce((n, t) => n + t.dur, 0),
      frameP50: d.length ? pct(d, 0.5) : null,
      frameP95: d.length ? pct(d, 0.95) : null,
      frameMax: d.length ? d[d.length - 1] : null,
    }
  }, selector)

  const metrics = await cdp.send('Performance.getMetrics')
  const pick = (name) => metrics.metrics.find((m) => m.name === name)?.value ?? null
  const cdpMetrics = {
    jsHeapUsedMB: +(pick('JSHeapUsedSize') / 1048576).toFixed(1),
    domNodes: pick('Nodes'),
    jsEventListeners: pick('JSEventListeners'),
    layouts: pick('LayoutCount'),
    recalcStyles: pick('RecalcStyleCount'),
    scriptDurationS: +pick('ScriptDuration').toFixed(1),
    taskDurationS: +pick('TaskDuration').toFixed(1),
  }

  const logs = apiCalls.filter((c) => c.path.split('?')[0] === logPath)
  const logOffsets = [...new Set(logs.map((c) => new URL('http://x' + c.path).searchParams.get('offset')))]
  const video = page.video()
  await page.close()
  await context.close()
  await browser.close()
  let videoPath = null
  if (video) {
    const src = await video.path()
    const dest = path.join(VIDEO_DIR, videoFile)
    fs.copyFileSync(src, dest)
    fs.rmSync(src)
    videoPath = dest
  }

  return {
    name,
    wallToFirstNodeMs: +wallToFirstNode.toFixed(0),
    loadSnap,
    scrollMs,
    scrollWheelBudgetMs: maxScrollMs,
    logRequests: logs.length,
    logBytes: logs.reduce((n, c) => n + c.bytes, 0),
    rowsTransferred: logs.reduce((n, c) => n + (c.count ?? 0), 0),
    duplicateOffsets: logOffsets.length !== logs.length,
    apiLoadPhase: (() => {
      const cutoff = navT0Wall + wallToFirstNode + 3000
      const phase = apiCalls.filter((c) => c.at < cutoff)
      return { calls: phase.length, bytes: phase.reduce((n, c) => n + c.bytes, 0) }
    })(),
    apiTotal: { calls: apiCalls.length, bytes: apiCalls.reduce((n, c) => n + c.bytes, 0) },
    endSnap,
    cdpMetrics,
    videoPath,
  }
}

// ------------------------------------------------------------------ main
async function main() {
  console.log(`# sirgit perf bench — repo: ${REPO}`)
  const meta = {
    date: new Date().toISOString(),
    machine: {
      model: execSync('sysctl -n hw.model', { encoding: 'utf8' }).trim(),
      cpu: os.cpus()[0]?.model,
      cores: os.cpus().length,
      memGB: +(os.totalmem() / 1073741824).toFixed(0),
      platform: `${os.platform()} ${os.release()} (${os.arch()})`,
    },
    sirgitCommit: execSync(`git -C ${ROOT} log -1 --format=%h`, { encoding: 'utf8' }).trim(),
    sirgitBuild: 'debug',
    ungitVersion: JSON.parse(fs.readFileSync('/Users/kbv/Projects/ungit/package.json', 'utf8')).version,
    browser: 'Playwright Chromium headless, fresh profile, 1440x900',
  }
  console.log('## profiling repo…')
  const repo = profileRepo()
  console.log(`   ${repo.commits} commits, ${repo.localBranches}+${repo.remoteBranches} branches, ${repo.tags} tags, pack ${repo.packSize}`)

  console.log('## API bench: sirgit (live, warm)…')
  const sirgitPid = pidOf(8449)
  const apiSirgit = await apiBenchSirgit(SIRGIT)

  console.log('## API bench: sirgit (cold instance)…')
  const cold = await withColdSirgit()

  console.log('## API bench: ungit…')
  const ungitPid = pidOf(8448)
  const apiUngit = await apiBenchUngit()

  console.log('## browser bench: sirgit (full-history scroll)…')
  const sirgitRssBefore = rssOf(sirgitPid)
  const browserSirgit = await benchApp({
    name: 'sirgit',
    base: SIRGIT,
    hash: `/repository?path=${enc(REPO)}`,
    selector: '[data-sha]',
    maxScrollMs: 45000,
    logPath: '/api/log',
    logCountKey: 'rows',
    videoFile: 'sirgit-scroll.webm',
  })
  const sirgitRssAfter = rssOf(sirgitPid)

  console.log('## browser bench: ungit (same wheel budget)…')
  const ungitRssBefore = rssOf(ungitPid)
  const browserUngit = await benchApp({
    name: 'ungit',
    base: UNGIT,
    hash: `/repository?path=${enc(REPO)}`,
    selector: '.nodeContainer',
    maxScrollMs: 45000,
    logPath: '/api/gitlog',
    logCountKey: 'nodes',
    videoFile: 'ungit-scroll.webm',
  })
  const ungitRssAfter = rssOf(ungitPid)

  const results = {
    meta,
    repo,
    api: {
      sirgit: apiSirgit,
      sirgitCold: cold,
      ungit: apiUngit,
    },
    servers: {
      sirgit: { pid: sirgitPid, rssBeforeKiB: sirgitRssBefore, rssAfterKiB: sirgitRssAfter },
      ungit: { pid: ungitPid, rssBeforeKiB: ungitRssBefore, rssAfterKiB: ungitRssAfter },
    },
    browser: { sirgit: browserSirgit, ungit: browserUngit },
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true })
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2))

  // console summary
  const s = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(0)} KB`)
  console.log('\n===== SUMMARY =====')
  console.log(`repo: ${repo.commits} commits / ${repo.localBranches + repo.remoteBranches} branches / ${repo.tags} tags`)
  console.log(`sirgit cold  first log page: ${cold.cold.medianMs} ms (server start ${cold.startupMs} ms)`)
  console.log(`sirgit warm  first log page: ${apiSirgit.log_first_page.medianMs} ms (${s(apiSirgit.log_first_page.bytes)}/200 rows)`)
  console.log(`ungit        gitlog 25:      ${apiUngit.gitlog_25.medianMs} ms (${s(apiUngit.gitlog_25.bytes)}/25 nodes)`)
  console.log(`ungit        gitlog 1200:    ${apiUngit.gitlog_1200.medianMs} ms (${s(apiUngit.gitlog_1200.bytes)}/1200 nodes)`)
  for (const b of [browserSirgit, browserUngit]) {
    console.log(`\n[${b.name}]`)
    console.log(`  first commit on screen: ${b.loadSnap.firstNodeAt} ms after nav (wall ${b.wallToFirstNodeMs} ms)`)
    console.log(`  scroll phase: ${(b.scrollMs / 1000).toFixed(1)}s, ${b.logRequests} log reqs, ${s(b.logBytes)} log bytes, ${b.rowsTransferred} rows transferred`)
    console.log(`  DOM: ${b.endSnap.nodes} commit elements, ${b.endSnap.domTotal} total elements`)
    console.log(`  frames p50/p95/max: ${b.endSnap.frameP50}/${b.endSnap.frameP95}/${b.endSnap.frameMax} ms, long tasks: ${b.endSnap.longTasks.length} (${b.endSnap.longTaskTotalMs} ms)`)
    console.log(`  heap ${b.cdpMetrics.jsHeapUsedMB} MB, layouts ${b.cdpMetrics.layouts}, recalcs ${b.cdpMetrics.recalcStyles}, listeners ${b.cdpMetrics.jsEventListeners}`)
    console.log(`  video: ${b.videoPath}`)
  }
  console.log(`\nresults → ${OUT}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
