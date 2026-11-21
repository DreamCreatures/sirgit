# sirgit

**A fast, visual git client — built as a thank-you to [ungit](https://github.com/FredrikNoren/ungit).**

## Why sirgit exists

I've used ungit nearly every working day for more than ten years. It's where I learned that version control could be visual, immediate, and humane — and its core idea, *the commit graph as the primary surface you think on*, has stayed with me longer than any tool since. But ungit's development has quietly wound down to automated dependency bumps, and the parts I loved began to strain on today's larger repositories.

So rather than watch the idea age, I rebuilt it. Every line of sirgit is written fresh, but nearly every design decision traces back to a decade of living in ungit — this project stands on its shoulders.

And I'll be candid about how a one-person rewrite became practical in days instead of years: sirgit was designed and built pair-programming with AI — **openclaw + ZCode + z.ai**. The taste came from ten years of using the original; the leverage came from the machines.

If you've loved ungit, sirgit is for you.

## What it is

A fast, lightweight local git graph UI — ungit's proven concepts on a modern stack, designed to stay smooth on repositories with 100k+ commits.

```
┌──────────────────────────────────────────────────────────┐
│ ungit ▸ ~/Projects/ungit    [master ↑2 ↓1] Fetch Pull …  │
├────────────┬─────────────────────────────────────────────┤
│ branches   │  ●──●──● main (HEAD)                        │
│ remotes    │       ● feature/big     ← virtualized       │
│ tags       │  ●──●──●──●  (only visible rows in DOM)     │
│            │  ── staging ──────────────────────────      │
│ [+ branch] │  ✓ src/api.ts            +12 −3             │
│ [+ tag]    │  [ commit message…                    ]     │
└────────────┴─────────────────────────────────────────────┘
```

## Install

One Rust binary, distributed through npm so `pnpm install -g` works (macOS arm64 today; the package refuses politely elsewhere):

```bash
pnpm install -g dcs-sirgit    # from npm
pnpm install -g .             # or from a checkout — builds the release binary and links it

sirgit                        # inside a project: opens that repo
sirgit ~/Projects/ungit       # or point anywhere
```

No node shim, no runtime dependencies — the npm package *is* the binary. Already running? A second `sirgit` just focuses the existing instance instead of erroring (port from `~/.sirgitrc.json`, default 8449).

## Why a rewrite

To be clear up front: none of this is a knock on ungit — it predates virtualized rendering, modern bundlers, and today's repository sizes, and it served a decade of my daily use without complaint. But its development has wound down to automated dependency bumps, and its 2013-era architecture (every loaded commit in the DOM, cumulative refetching on scroll) strains on large repos. The full reverse-engineering analysis lives in [`docs/recon.md`](docs/recon.md); the headline fixes:

| ungit | sirgit |
|---|---|
| "Load more" **cumulatively re-fetches** the entire history window on every scroll | Disjoint windowed pages, merged client-side by sha — nothing is re-fetched |
| Every loaded commit lives in the DOM forever | Virtualized: ~20–30 rows in the DOM regardless of history size (verified: 50k commits, flat DOM) |
| `git log --numstat --show-signature` per page (GPG + per-commit diffs) | Lightweight topology pages; numstat/diffs fetched lazily per visible commit |
| Every watcher event fetches **all remotes** → `index.lock` races patched over with retries | Fetch only on open/button/pull; per-repo single-writer operation queue makes races impossible |
| Live updates = full re-fetch + full re-render | WebSocket events → **O(delta) graph sync** (`/api/log/delta` returns only new/removed commits) |
| chokidar walks the entire worktree | `.git`-focused watcher + coalesced debounced events |

## Architecture

Monorepo:

- **`server/`** — Rust (axum + tokio). Serves the REST API, WebSocket events, and the built frontend **embedded in a single binary**. Git is invoked as the CLI (porcelain v2 / NUL-separated machine formats — no free-text parsing), with read results cached per repo revision and all mutations serialized through a per-repo write queue.
- **`web/`** — React 19 + TypeScript + Vite + Tailwind CSS 4 + TanStack Query + Zustand. Lane assignment and date-order topological sorting run client-side (pure, unit-tested, O(N log N)); rendering is fully virtualized.

### Run it

Prereqs: Rust ≥ 1.85, Node ≥ 20 + pnpm (frontend build), git ≥ 2.34.

```bash
# build the frontend once (the server embeds web/dist)
pnpm --dir web install
pnpm --dir web build

# run the server (debug build)
cargo run --manifest-path server/Cargo.toml          # opens a browser on :8449

# or the release binary
cargo build --release --manifest-path server/Cargo.toml
./server/target/release/sirgit                       # single binary, ~3.5MB
```

Then open a repository from the home screen, or pass it directly:

```bash
sirgit --no-open /path/to/repo        # http://localhost:8449/#/repository?path=...
```

Options: `--port N`, `--no-open`. Config lives in `~/.sirgitrc.json` (`port`, `autoFetchOnOpen`, `pageSize`, `theme`).

### Develop

```bash
cargo run --manifest-path server/Cargo.toml -- --no-open   # terminal 1
pnpm --dir web dev                                          # terminal 2 → :5173 (proxies API/WS to :8449)
```

### Test

```bash
cargo test --manifest-path server/Cargo.toml   # parsers, b64, delta, fixture repos (12 tests)
pnpm --dir web test                            # graph ordering + lane algorithms (8 tests, incl. 100k-commit scale)
pnpm --dir web exec playwright test            # Playwright smoke: open → graph → stage → commit (2 tests)
```

E2E starts its own server on :8549 automatically (`reuseExistingServer` honored; set `SIRGIT_URL` to target a running one).

### Release

Bump `version` in `package.json` (the single source — `scripts/prepare-bin.mjs` syncs `server/Cargo.toml` to it at build time), commit, then:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The `release` workflow (macOS arm64) does the rest: web build → cargo test → `pnpm pack` → `npm publish` → GitHub Release with `bin/sirgit` + the tarball attached. One-time setup: the `NPM_TOKEN` repo secret (an npm *Automation* token, which skips 2FA in CI). *(A release-please bot flow was tried and removed — this org's policy forbids workflow-created PRs.)*

### Performance numbers (M1 acceptance)

Benchmarked head-to-head against ungit on **ungit's own repository** — see **[`docs/performance.md`](docs/performance.md)**: 10× faster first paint, ~420× less data transferred to scroll the same history, constant 25-row DOM, 0 long tasks. Also measured on the 50k-commit fixture (`node scripts/make-big-repo.mjs /tmp/sirgit-big 50000`):

- First topology build (entire 50k history, one `git log` pass): **~320ms**, then cached
- Any page, any offset (warm): **~9ms**, 42KB per 200 commits
- DOM while scrolling 1,200+ commits deep: **~24–34 rows / ~1,630 nodes**, flat
- Graph sync on a new commit: **O(delta)** — a single small JSON diff over the WS

On the real ungit repo (4,079 commits, 152 tags, 16 remote branches): 22 DOM rows on load, deep-scroll stays flat, live UI commit round-trips through staging → graph in <300ms.

### Credentials

Network operations route git's credential prompts through the UI: an inline shell credential-helper GETs `/api/credentials`, the server pushes a request over the WebSocket, and the credentials modal responds. Requires `curl` on PATH (present on macOS/Linux by default). Public repos and ssh-agent keys need nothing.

## Status / roadmap

**M1 (this repo, working):** virtualized graph + lanes, live delta sync, staging/commit (incl. amend), conflict banner + continue/abort, branch/tag CRUD + checkout (remote→local), fetch/pull/push with progress, clone/init, commit detail with per-file diffs, credentials modal, single-binary packaging, `.sirgitrc.json`.

**M2 (next):** drag-and-drop graph operations (rebase/merge/squash/reset/revert/cherry-pick/move/push), stash panel, submodules, patch-mode line staging, remote management UI.
**M3:** image diffs, GPG signing UI, auth, plugin story, Tauri desktop packaging.

## License

MIT
