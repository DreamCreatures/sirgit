# ungit recon map — reverse-engineered for sirgit

Source analyzed: `~/Projects/ungit` @ `b1df1a16` (v1.5.30, upstream master tip). Last human-driven activity ~June 2026 (automated dep bumps only); 243 open issues; effectively maintenance mode.

Purpose: full picture of what ungit does, how it works, where it breaks — so sirgit can rebuild the good parts on a modern stack and fix the broken parts by design.

---

## 1. Architecture overview

```
bin/ungit ──forks──▶ source/server.js (Express 5 + socket.io, port 8448)
                        ├── source/git-api.js      (~30 REST endpoints under /api)
                        ├── source/git-promise.js  (spawn git CLI; p-limit 4; index.lock retries)
                        ├── source/git-parser.js   (regex parsing of git output)
                        ├── source/git-api.js RepoWatcher (chokidar per repo room)
                        └── public/  (Knockout 3.5 SPA, browserify bundle)
```

- **Server**: Express 5, static `public/`, plugin HTML injection at `<!-- ungit-plugins-placeholder -->`, socket.io rooms keyed by repo path. Plaintext user map auth (optional), `express-session` with hardcoded secret `'ungit'`.
- **Git access**: every operation = fresh `git` subprocess (`source/git-promise.js:68`), maxBuffer 100MB, `LC_ALL=C`, credential handling via `bin/credentials-helper` → `GET /api/credentials` → socket.io prompt → UI modal.
- **Frontend**: Knockout observables + native templates, jQuery 3.7, Bootstrap 3.4, snap.svg/mina animations, diff2html, hasher+crossroads hash routing, browserify + tsify + exorcist + LESS build.

## 2. Screen inventory

| Screen | Component | Function |
|---|---|---|
| Home | `components/home` | Recent repos list (localStorage), open path, remove |
| Path page | `components/path` | Non-repo handling: init / clone / create-dir / sub-repo list / invalid path |
| Repository | `components/repository` | Composition: gitErrors, graph, remotes, submodules, stash, staging, branches |
| Graph | `components/graph` | Commit DAG + drag-drop ops + ref chips |
| Staging | `components/staging` | File staging, commit box, conflict resolution |
| Commit detail | `components/commit`, `commitdiff`, `textdiff`, `imagediff` | Selected-commit card + diffs |
| Branches panel | `components/branches` | Branch/tag/remote-ref list + filters + fetch |
| Remotes panel | `components/remotes` | Remote list, add/remove, fetch |
| Stash panel | `components/stash` | Stash list, apply, drop |
| Submodules | `components/submodules` | List, add, update, remove |
| Modals | `components/modals` | yes/no(+mute), textedit, credentials, add remote/submodule, too-many-files |
| Errors | `components/gitErrors`, `crash`, `login` | Error banners, crash screen, login |

Routes: `/#/` (home) and `/#/repository?path=…` only.

## 3. User flows

1. **Open repo**: home → click recent or type path → `/quickstatus` → repository view → `watch` (socket) → chokidar watcher created → components fetch status/log/refs/branches.
2. **Commit**: staging refresh (`/status`) → stage files (`update-index --stdin`) → type message → commit (`commit --file=-`) → debounced `git-directory-changed` → graph+refs refetch.
3. **Branch op via drag**: drag ref chip → drop on node → drop targets (Move/Rebase/Merge/Push/Reset/Checkout/Delete/Cherry-pick/Uncommit/Revert/Squash) → confirm modal (rewind / force-push) → REST → refresh.
4. **Remote sync**: remotes panel fetch / drag-push / commit&push; autoFetch=true additionally fetches all remotes on every watcher event.
5. **Conflict**: rebase/merge/cherry state detected from `.git/` files → staging banner → per-file resolve (`add`/`rm`) → continue/abort.
6. **Credentials**: git pushes to remote → credential helper → HTTP GET `/api/credentials` → server → socket `request-credentials` → modal → response POST → helper prints `username=/password=`.

## 4. Data model (inferred)

- **Commit node**: `sha1, parents[], refs[], isHead, authorName/Email, committerName/Email, authorDate, commitDate, message, fileLineDiffs[{additions,deletions,fileName,oldFileName,displayName,type}], additions, deletions, signatureMade?` — from `git log --pretty=fuller -z --parents --numstat --date-order` parsing.
- **Ref**: `name ("refs/heads/x" | "refs/remotes/o/x" | tag), sha1`; current branch parsed from `git branch` text.
- **Status**: `{branch, files: {name → {staged, removed, isNew, conflict, renamed, type, additions, deletions}}, inRebase, inMerge, inCherry, inConflict, commitMessage}`.
- **Config**: `~/.ungitrc` (JSON) + ~45 CLI flags; notable: `numberOfNodesPerLoad: 25`, `autoFetch: true`, `maxConcurrentGitOperations: 4`, `noFFMerge: true`, `autoStashAndPop: true`.

## 5. Feature matrix

**Home/repo**: recent repos, path open, clone (URL→dir, recurse-submodules), init (incl. bare), create-dir, sub-repo listing.

**Graph**: paged log (25/page), scroll-down "load more" (cumulative limit), "load ahead" (skip−25), ideological-branch coloring (md5(refName) colors), node sizes (30px HEAD-lineage / 15px other), straight polyline edges, ref chips (max `numRefsToShow` 5 + autocomplete), create branch/tag per node, drag refs with 11 drop actions + SVG hover previews (dashed ghosts, X strikes, push arrow), node click → commit card, double-click ref → checkout.

**Staging**: stage/unstage + select-all, per-file discard (yes/no/mute-5-min), discard-all, ignore-file, >50-files warning modal, diff2html inline/side-by-side, whitespace toggle, word wrap, 100-line diff pagination, per-line patch mode (regex-injected checkboxes → `git apply --cached`), image diffs, amend, empty commit, commit&push (force confirm), GPG `-S` flag, Enter/Alt+Enter commit.

**Refs**: branches panel (current label, filters persisted, delete confirm), tags (create/delete, remote tag view), remotes (add/remove, per-remote fetch, offline banner), checkout (remote→local + optional hard reset).

**Conflict UI**: in-progress banner (merge/rebase/cherry), continue/abort, per-file resolve, launch merge tool.

**Stash**: list + line diffs, apply, drop, stash-all button; invisible `autoStashAndPop` wrapper for ops.

**Submodules**: list/add/update/remove, parent-repo banner + navigation.

**Misc**: gitErrors banners with command/stdout/stderr, crash screen (with adblock detection), optional plaintext auth + login screen, `.gitignore` textedit modal, refresh button, version banners, ~45 config flags, Electron packaging, plugin system (every component is a plugin; `~/.ungit/plugins`; can override core).

## 6. Performance failure analysis (the rewrite targets)

| # | Problem | Evidence | Impact |
|---|---|---|---|
| P1 | Cumulative pagination: "load more" raises `limit` 25→50→75…, refetches the entire slice every time | `graph.js:44-51` | Scrolling a big repo = O(n²) data transfer + re-layout; 100k commits ≈ 4,000 requests |
| P2 | No virtualization: every loaded commit = DOM container + commit component + SVG circle + edge paths, all live | `graph.html`, `graph-graphics.html` | DOM grows unbounded; per-refresh cost grows with total loaded history |
| P3 | O(N²) dependency scans: every edge position reads `nodes().includes(this)` (O(N) per edge) whenever any node moves | `edge.js:9-35`, `git-node.js:325-327` | Recompute storms on every refresh/animation |
| P4 | Heavy log payload: `--numstat --show-signature --cc` on every page; numstat requires per-commit diff computation; GPG per commit | `git-promise.js:607-628` | Server-side log cost dominates on large repos |
| P5 | Full re-render on any change: `nodes`/`edges` arrays reassigned wholesale; every node re-`render()`ed + mina-animated | `graph.js:139-143`, `animateable.js` | Any file save → whole-graph churn |
| P6 | autoFetch fetch-storm: every watcher event → `fetch` all remotes → refs change → watcher event… plus index.lock retry spam | `branches.js:60-96`, `git-api.js:484-501`, `git-promise.js:30-38` | Background CPU + lock races against user ops |
| P7 | chokidar walks entire worktree per repo (minus gitignore) | `git-api.js:102-131` | Slow on huge checkouts; memory per open repo |
| P8 | Multi-spawn fan-out, no caching: status = 3 spawns, commit = status+diff+update-index+commit; zero result caching | `git-promise.js:240-577` | Latency per interaction |
| P9 | Unbounded viewmodel caches (`nodesById`, `edgesById` never pruned) + JSON.stringify payload-diffing everywhere | `graph.js:93-111`, `ComponentRoot.ts` | Memory creep on long sessions |
| P10 | Fragile glue: regex-injected patch checkboxes, setInterval DOM polling for modals, plaintext auth, hardcoded session secret | `textdiff.js:163-207`, `app.js:131-141`, `server.js:130-141` | Maintenance burden, correctness risks |

## 7. sirgit design decisions (fixing P1–P10)

- **P1 → disjoint windowed pages**: `/api/log?limit&skip` pages are disjoint; client appends without refetching; required-shas (HEAD, ref tips) pinned into page 1.
- **P2 → virtualization**: fixed row height; only visible rows (+ edges intersecting viewport) in DOM.
- **P3 → memoized layout**: lane assignment O(N) over in-memory topology, recomputed only when topology changes; rows are pure React components.
- **P4 → lazy detail**: log pages carry sha/parents/refs/message/author/date only; numstat & diffs fetched per visible commit on demand; no `--show-signature` in list path.
- **P5 → query invalidation**: TanStack Query caches + structural sharing; unchanged rows never re-render.
- **P6 → no background fetch storm**: fetch on repo-open (once, if enabled) + explicit button + pull; per-repo single-writer op queue (reads via git2 concurrent).
- **P7 → .git-only watching**: notify on `.git/HEAD`, `.git/refs`, `.git/index`, `.git/logs` + shallow worktree (depth 1), coalesced debounce.
- **P8 → git2 in-process reads + status cache** keyed by watch revision.
- **P9 → bounded query windows**: TanStack Query GC, windowed pages.
- **P10 → modern stack**: React 19/TS/Vite/Tailwind 4, radix primitives, porcelain v2 parsing (no free-text where avoidable), typed error taxonomy.

## 8. What sirgit keeps from ungit (proven concepts)

- Graph-first mental model with refs as first-class draggable citizens (drag ops deferred to M2, but the data model supports it).
- Credential-helper protocol (git helper bin ↔ local HTTP ↔ UI modal).
- Conflict banner + continue/abort flow inside staging.
- Typed git error taxonomy (`offline`, `non-fast-forward`, `merge-failed`, `not-a-repository`, `no-head`, `no-commits`, `local-changes-would-be-overwritten`, …).
- Single-binary local web app; browser opens on launch; per-repo watch rooms.
