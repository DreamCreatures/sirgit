# sirgit performance report

**Date:** 2026-11-22 · **sirgit** `3b749f6` (debug build) · **ungit** `1.5.30` (current npm release, the app sirgit replaces)
**Workload:** ungit's own repository — 4,015 commits on master (4,079 reachable from all refs), 13 years of history (2013 → 2026), 8 local + 16 remote branches, 152 tags, 22.01 MiB packfile.
**Machine:** Apple M5 Pro (18 cores), 48 GB RAM, darwin 27.2.0 (arm64). Both servers on localhost; both apps bench-marked in the same headless Chromium (fresh profile, 1440×900) with an identical, aggressive input stream.

## Verdict

| | sirgit | ungit | advantage |
|---|---|---|---|
| First commit row on screen (cold page load) | **48 ms** | 474 ms | **9.9×** |
| Server API, one page of history | **3 ms** / 200 commits | 43 ms / 25 commits | **~115× throughput**¹ |
| Bytes per commit on the wire | **223 B** | 1,252 B | **5.6×** |
| Scroll the *entire* 4,079-commit history | **15.5 s · 944 KB · 21 requests** |² | |
| Commit elements kept in DOM | **25** | 900 (after 22% of history) | virtualized |
| Total DOM elements | **3,277** | 90,044 | **27×** |
| JS heap after scrolling | **11.6 MB** | 212.5 MB | **18×** |
| Frames p95 / worst during scroll | **16.8 ms / 83 ms** | 33.3 ms / 133 ms | locked 60 fps at p95 |
| Long tasks (>50 ms) while scrolling | **0** | 18 (1.23 s total) | |
| Main-thread busy time in 45 s session | **1.0 s** | 18.2 s | **18×** |
| Server RSS across the whole run | **30 MB, flat (+16 KB)** | 135 → 149 MB | |

¹ Per-commit server throughput: sirgit serves 200 rows in 3 ms ≈ 67k rows/s warm; ungit serves 25 rows in 43 ms ≈ 580 rows/s — and ungit's cost *grows with scroll depth* (see §4).
² ungit did not finish in the 45 s budget given to both apps (3× sirgit's full-run time); see §4 for the extrapolation.

All numbers are measured, not projected — rerun them yourself with the script in §7. Raw data: [`performance-results.json`](performance-results.json).

## Why compare against ungit

Because sirgit wouldn't exist without it. I used ungit daily for over a decade, and its design DNA — the commit graph as the surface you think on, point-and-click history surgery — is sirgit's starting point, not my invention. When you rebuild something you love, the only honest baseline is the original: the question this report answers is not "is sirgit fast" in the abstract, but "does it carry ungit's ideas forward with the headroom the original earned but never got to spend?"

The fixture is ungit's own repository, deliberately: thirteen years of the project's actual history — real merges, bot dependency bumps, 152 tags, 16 remote branches, 4,015 commits. A synthetic repo would flatter both apps; ungit's real repository is the fairest arena either side could ask for, and benchmarking on it is a small way of saying thank-you with receipts.

One more thing said plainly: every ungit number below is a critique of a 2013 architecture operating in 2026, not of the people who built it. Those design choices were right for their era — ungit simply deserves a successor built with thirteen years of hindsight, and that is what this report measures.

## 1. Server API (HTTP, median of 7 requests)

| Endpoint | sirgit | ungit |
|---|---|---|
| Log page, 200 commits (warm) | **3.0 ms** · 44.6 KB | — |
| Log page, 200 commits (cold, first hit after server start) | **43.7 ms** | — |
| Log page, rows 2,000–2,200 (deep) | **2.7 ms** · 45.7 KB | — |
| Server process startup | **154 ms** | — |
| gitlog, 25 commits (ungit's page size) | — | 43.2 ms · 31.3 KB |
| gitlog, 100 commits | — | 138.2 ms · 129.6 KB |
| gitlog, 400 commits | — | 272.9 ms · 475.1 KB |
| gitlog, 1,200 commits | — | 643.9 ms · 1.37 MB |
| Refs list (177 refs) | 65.2 ms · 15.2 KB | **13.1 ms** · 14.4 KB |
| Working-tree status (clean tree) | **1.7 ms** | 14.4 ms |
| Commit detail incl. numstat | 35.4 ms · 1.9 KB | — |

What's behind it:

- sirgit runs **one** `git log` per repo revision and caches the parsed topology in memory (`TopoCache`, rebuilt only when refs/HEAD move). Every page request is a memory slice — that's why page 1 and page 10 cost the same 3 ms, and why the *cold* hit (43.7 ms for the full 4,079-commit walk) is a one-time cost per revision.
- ungit spawns `git log --pretty=fuller --numstat --cc --show-signature --branches --tags --remotes` for **every** page, so each response costs a full subprocess + GPG-verify pass, and the cost scales with the requested window (43 ms → 644 ms as the window grows).
- Wire cost per commit: sirgit ships `{sha, parents, author, dates, subject}` = **223 B/commit**; ungit ships fuller formatting plus per-file numstat for every commit = **1,252 B/commit**.
- Honest note: ungit's `/refs` is currently faster than sirgit's (13 vs 65 ms). It's off the scroll hot path and small in absolute terms, but it's on the fix list — the same caching treatment applies.

## 2. Loading the page (fresh browser profile)

Identical navigation, same repo, both apps pre-running:

| | sirgit | ungit |
|---|---|---|
| DOMContentLoaded | 22 ms | 80 ms |
| **First commit row painted** | **48 ms** | 474 ms |
| API calls until graph interactive (+3 s settle) | 9 | 29 |
| Bytes transferred in that window | 75.6 KB | 159.8 KB³ |

³ Includes ungit's default remote auto-fetch on repo open (its shipping default behavior — a behavior sirgit deliberately drops in favor of fetch-on-open-config + explicit button).

48 ms includes downloading the JS bundle from localhost, booting React, fetching quickstatus + log page 1 + refs, computing lanes, and painting. sirgit's graph is interactive about as fast as ungit's blank HTML shell parses.

## 3. The scroll race

Both apps received the **same input stream**: wheel events of 1,200 px every 40 ms (~30 kpx/s — far beyond human scrolling) over the graph, until the app stopped producing new content or the 45 s budget ran out.

```
history loaded (of 4,079)          bytes transferred
sirgit  ██████████████████████ 4,079/4,079   0.94 MB
ungit   ████░░░░░░░░░░░░░░░░░   900/4,079  20.27 MB   (45 s budget: 3× sirgit's whole run)
```

| | sirgit | ungit |
|---|---|---|
| Time to load **all** remaining history | **15.5 s** | did not finish in 45 s |
| Log requests issued | 21 | 38 |
| History bytes transferred | **943.9 KB** | 20.27 MB |
| Commit payloads shipped over the wire | 4,079 (each exactly once; 0 duplicate offsets) | 16,700 (each commit re-shipped ~18.6× avg) |
| Commit elements in DOM at the end | **25** | 900 |
| Reached the bottom of history | yes | no (22%) |

This is the two pagination designs head-to-head:

- **sirgit**: scroll consumes *disjoint* 200-row pages (`offset` advances, never re-fetched — verified: 21 requests, 21 distinct offsets). Cost to reach depth *D* is linear: `D × 223 B`. Measured: all 4,079 commits for 944 KB.
- **ungit**: every scroll-to-end grows the window (`limit += 25`) and refetches **everything from the top** (`graph.js:44-51`). Cost to reach depth *D* is **quadratic**: `Σ 25k × 1,252 B ≈ 0.0126·D²`. The model predicts 20.2 MB at D=900 — the run measured 20.27 MB.

**Extrapolating ungit's quadratic curve to the full history** (validated at the 900-commit mark): ≈ **395 MB transferred** and, from its measured per-window server times (≈35 ms + 0.51 ms/commit), ≈ **3 minutes of pure `git log` server time** — before counting its 500 ms debounce per 25-commit step and the re-render of every loaded node per fetch. Scrolling ungit to the bottom of its own repo realistically costs **5+ minutes and ~400 MB**; sirgit did it in **15.5 s and 0.94 MB** — a ~420× wire difference at this repo size, and the gap widens with repo size.

## 4. Rendering efficiency (end of scroll session)

| Renderer metric (CDP + DOM) | sirgit | ungit |
|---|---|---|
| Commit elements in DOM | **25** | 900 |
| Total DOM elements | **3,277** | 90,044 |
| DOM nodes incl. detached (CDP) | 13,527 | **344,733** |
| JS event listeners | **2,136** | 81,085 |
| Layout passes | **215** | 1,682 |
| Style recalculations | **544** | 2,660 |
| JS heap used | **11.6 MB** | 212.5 MB |

Frame timing across the session (headless Chromium, ~60 Hz vsync):

| | sirgit | ungit |
|---|---|---|
| p50 | 16.7 ms | 16.7 ms |
| p95 | **16.8 ms** (≈ p50: no degradation at depth) | 33.3 ms (every other frame over budget) |
| worst frame | 83 ms (single page-merge hitch) | 133 ms |
| Long tasks > 50 ms | **0** | 18 (1.23 s frozen total) |
| Main-thread task time | 1.0 s (2.2% of session) | 18.2 s (40% of session) |

ungit's p50 matches sirgit's while the graph is small — the 25-node initial view renders fine. The collapse comes with depth: at 900 nodes every scroll step re-renders all of them (Knockout observables per node), dropping p95 to 30 fps and stacking 1.2 s of >50 ms freezes. sirgit's DOM is constant-size (virtualized rows + viewport-culled edges), so its p95 equals its p50 after loading 4,079 commits.

## 5. Memory

- **Browser:** 11.6 MB heap (sirgit) vs 212.5 MB (ungit) after equivalent work — 18×. ungit's 81k listeners and 345k DOM nodes are all live allocations that keep growing with history; sirgit's stays flat by construction.
- **Server:** sirgit's RSS was 30.2 MB before and after the entire run (+16 KB — the topology cache for all 4,079 commits was already warm; pages are served from it without per-request allocation growth). ungit's process grew 135 → 149 MB *during* the 45 s session and idles ~4.5× higher.
- sirgit numbers are from the **debug** build — unoptimized, with embedded dev assets. A release build only widens every margin here.

## 6. Why it's fast (design → measurement)

| Design decision | Measured effect |
|---|---|
| Disjoint windowed pages, sha-keyed merge, never re-fetch | 21 requests / 21 distinct offsets / each commit shipped exactly once (§3) |
| Topology cache per repo revision | 3 ms warm pages, depth-independent; 43.7 ms one-time cold walk (§1) |
| Virtualized rows + viewport-culled edge layer | 25 DOM commit elements at any depth (§4) |
| Lean list payload (no numstat/signatures in the list path — details fetched per commit on demand) | 223 B vs 1,252 B per commit (§1) |
| React 19 memoized rows over stable row identity | 0 long tasks, 2.1k listeners, flat p95 (§4) |
| Watcher scoped to `.git` internals + per-repo single-writer op queue | flat 30 MB server RSS, no fetch storms (§5) |
| ungit's counterfactuals (cumulative `limit += 25`, full-DOM rendering) | quadratic 20.27 MB @ 22% depth, 90k DOM elements, 18 long tasks (§3–4) |

## 7. Reproduce

```sh
# prereqs: sirgit server on :8449, ungit server on :8448, pnpm deps in web/
cd web && node scripts/perf-bench.mjs
# → docs/performance-results.json + console summary
# → docs/perf/sirgit-scroll.webm + ungit-scroll.webm (screen recordings of both runs)
```

The script profiles the repo, benches both HTTP APIs (including a throwaway cold-start sirgit instance on :8451 so the live server is untouched), then drives both UIs in headless Chromium with an identical wheel-event stream, sampling rAF frame times, long tasks, DOM counts, CDP performance counters and heap. Methodology notes: API rows are medians of 7 requests; browser rows are single sessions (the script is deterministic enough that repeat runs land within a few percent); headless Chromium vsyncs at ~60 Hz.

## Caveats

- Single machine, single browser session per app; treat browser-round numbers as representative, not statistical. The API medians and the wire-byte counts are exactly reproducible.
- ungit's load window includes its default auto-fetch of remotes (its shipping behavior, noted where it applies).
- sirgit's `/refs` endpoint (65 ms) is currently slower than ungit's (13 ms) — known, off the hot path, queued for the same caching treatment.
- One 83 ms frame occurred in sirgit's run (a page-merge + lane re-derive landing in the same frame as input); p95 was unaffected.
- Videos are recordings of the exact bench sessions: `docs/perf/*.webm` (local artifacts, gitignored — regenerate with the script).
