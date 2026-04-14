# Upstream Sync Notes

This repo tracks upstream Pi while carrying a small set of local patches.

## Remotes and branches

- `upstream` → `https://github.com/badlogic/pi-mono.git`
- `origin` → `https://github.com/colelawrence/pi-mono.git`
- `upstream/main` = canonical upstream baseline
- `effect-native-core` = downstream integration branch for local carry patches
- `sync/upstream-YYYY-MM-DD` = temporary sync branch for each upstream integration

## Default sync workflow

```bash
cd .references/pi-mono-effect

git fetch upstream origin --tags
git switch effect-native-core
git switch -c sync/upstream-YYYY-MM-DD

git merge upstream/main
# resolve conflicts
# run targeted verification
# update this file with any new resolution notes

git switch effect-native-core
git merge sync/upstream-YYYY-MM-DD
# if you used a temporary worktree for the merge, fast-forward the primary
# .references/pi-mono-effect checkout to the completed sync branch too
# clean only known incidental generated/build dirt in the primary checkout
# so the checked-out ref repo is the thing future reads/builds use
git push origin effect-native-core
```

## Primary checkout hygiene

Treat the checked-out `.references/pi-mono-effect` worktree as the canonical local reference repo.
If you need a temporary worktree for the merge, that is a means to complete the sync — not the final place to leave the repo.

Rules:
- Check `git status --short` in the primary checkout before starting.
- If the primary checkout is dirty and the dirt is not obviously disposable generated output, do the merge in a temporary worktree instead of forcing cleanup.
- Do **not** use blanket destructive cleanup (`git reset --hard`, `git checkout --`, `git clean -fd`, `git stash`) just to make a sync easier.
- Before calling the sync done, return to the primary `.references/pi-mono-effect` checkout, fast-forward it to the completed sync branch, and remove only the specific incidental generated/build dirt you intentionally created and understand.
- If you cannot explain each remaining dirty path in the primary checkout, the sync is not done.

Why merge instead of rebase:
- preserves shared history
- makes upstream sync points explicit
- avoids rewriting branch history for other collaborators

Enable rerere once per clone:

```bash
git config rerere.enabled true
```

## Rules for sync PRs / merge commits

- Prefer upstream structure and control flow.
- Reapply only the minimal local behavior we still need.
- Keep local carry patches isolated by concern.
- Do not mix unrelated feature work into upstream sync commits.
- Generated file refreshes should be a separate commit when possible.
- Sync frequently; small regular merges are much cheaper than infrequent large jumps.
- Treat hot upstream core files as high-risk carry locations. Prefer seams, hooks, wrappers, or upstreaming over long-lived invasive edits.
- Retire carry patches aggressively when upstream makes them unnecessary.
- Separate categories of change when possible:
  - upstream merge resolution
  - handwritten downstream carry reapplication
  - generated file refresh
  - unrelated local feature work

## Current carry patches to watch

### `packages/tui/src/tui.ts`
Intent:
- Overwide rendered lines should remain loud but non-fatal.
- Render pipeline exceptions should log loudly and degrade to a safe warning line instead of killing the session.

Resolution pattern:
- Prefer upstream render pipeline shape.
- Reapply local behavior with minimal inline changes near the existing overflow and render-error handling.
- Avoid helper-heavy refactors here; they increase future merge friction.
- If upstream render scheduling becomes timer-driven, keep the test harness waiting on scheduled writes before asserting viewport state.

Verification:
```bash
cd packages/tui
node --test --import tsx test/tui-render.test.ts
```

### `packages/coding-agent/src/core/agent-session.ts`, `packages/coding-agent/src/core/session-runtime.ts`, `packages/coding-agent/src/core/user-turn-ready.ts`
Intent:
- Keep the downstream epi session-runtime bridge integrated with AgentSession lifecycle changes.
- Preserve downstream `epi_user_turn_ready` emission without forking upstream turn/session control flow more than necessary.

Resolution pattern:
- Prefer upstream AgentSession structure and control flow.
- Keep downstream behavior concentrated in additive runtime helpers and narrowly-scoped hooks instead of broad inline rewrites.
- If upstream exposes a cleaner seam, move this carry out of `agent-session.ts`.

Verification:
```bash
cd packages/coding-agent
npx vitest --run test/user-turn-ready.test.ts test/agent-session-runtime-invariants.test.ts test/trigger-compact-extension.test.ts
```

### `packages/coding-agent/src/core/extensions/loader.ts`, `packages/coding-agent/src/core/extensions/host-capabilities.ts`
Intent:
- Expose downstream host capabilities (currently `epiUserTurnReadyV1`) to extensions alongside upstream loader/source-info behavior.
- Preserve downstream layered-extension descriptor support (`piExtensionLayer(...)`) without breaking classic factory loading.

Resolution pattern:
- Prefer upstream loader/runtime initialization flow.
- Reapply downstream capability exposure as small additive accessors and constants, not a loader refactor.
- Keep layered-extension support as an additive path: classic factory loading must still work, malformed descriptors must fail fast, and duplicate ids must be rejected clearly.

Verification:
```bash
cd packages/coding-agent
npx vitest --run test/host-capabilities.test.ts
```

## Generated file policy

### `packages/ai/src/models.generated.ts`
This file is generated from live provider catalogs and should be treated as derived output, not hand-merged source.

Rule:
- Do not resolve this file line-by-line during upstream sync.
- If it conflicts or becomes dirty during a sync/build, regenerate it from the current branch state and use the regenerated output as the resolution.
- Keep generated-model refreshes separate from handwritten sync-resolution commits whenever possible.
- If a sync does not intentionally include a model-catalog refresh, avoid carrying incidental churn in this file.

Recommended conflict workflow:
```bash
cd packages/ai
npm run generate-models
```

Commit policy:
- Prefer a separate commit titled clearly as a generated-model refresh.
- Sync commits should mention whether `models.generated.ts` was regenerated intentionally or left unchanged.

## Suggested sync verification checklist

Run the smallest relevant checks for changed carry areas:

```bash
cd .references/pi-mono-effect

# If tui changed
(cd packages/tui && node --test --import tsx test/tui-render.test.ts)

# If agent changed
(cd packages/agent && npm run build)

# If installing epi / coding-agent changed
./install-epi.sh
```

## Long-term maintenance guidance

This workflow is maintainable if we keep the downstream delta small and intentional.

Operational rules:
- Prefer regular sync cadence (weekly / biweekly while the fork is active) over waiting for breakage.
- The git strategy is merge-based and should stay that way; avoid rebase-heavy history rewriting for shared downstream branches.
- The main cost driver is not git itself but local edits inside high-churn upstream files (`agent-session.ts`, `runner.ts`, `tui.ts`, etc.).
- When a downstream behavior must exist, choose the least conflict-prone home available:
  - upstream extension seam / callback
  - wrapper/helper file
  - isolated additive hook
  - only as a last resort, direct edits in upstream core files
- A healthy downstream branch should have shrinking carry, not accumulating carry.

Review questions before finishing a sync:
- Which carry patches are still truly required?
- Which carries can be deleted because upstream now covers them?
- Which carries should be moved to a cleaner seam before the next sync?
- Did we accidentally mix generated churn or unrelated feature work into the sync?

## Conflict log template

Append a short entry for each sync:

```md
## Sync YYYY-MM-DD
- merged: upstream/main @ <sha>
- branch: sync/upstream-YYYY-MM-DD
- conflicts:
  - packages/tui/src/tui.ts — kept upstream flow, reapplied non-fatal overflow handling
  - packages/agent/src/proxy.ts — preserved local structural Response typing for tsgo
- verification:
  - [x] packages/tui test/tui-render.test.ts
  - [x] packages/agent npm run build
  - [x] ./install-epi.sh
- notes:
  - models.generated.ts regenerated as conflict/build resolution? yes/no
  - if yes, was it committed as a separate generated refresh? yes/no
- reflection:
  - what was surprisingly easy?
  - what repeatedly caused friction?
  - what carry patch should be reduced, moved, upstreamed, or retired before the next sync?
  - what should be added or corrected in UPSTREAM_SYNC.md based on this round?
```

## Patch retirement rule

Whenever upstream absorbs one of our carry patches:
- delete the local delta instead of preserving compatibility code
- update this file to remove that patch from the carry inventory
- note the upstream commit/PR that made the carry patch unnecessary

## Post-sync reflection rule

At the end of every sync, do a short retrospective before calling the branch done:
- update the sync entry in this file with the actual conflict set and verification used
- record any patch retirement, new carry patch, or carry-patch shrinkage
- record whether generated files needed regeneration and whether that churn was kept or dropped
- capture one or two lessons that would make the next sync easier
- feed those lessons back into this file immediately rather than relying on memory
- ensure the primary `.references/pi-mono-effect` checkout, not just a temporary worktree, is updated to the finished sync commit and left in an explained state

If a sync exposed a recurring conflict pattern, confusing decision point, or better resolution rule, update the living guidance in this document during the same sync.

## Sync 2026-03-21
- merged: `upstream/main @ f90647ea`
- branch: `sync/upstream-2026-03-21`
- conflicts:
  - `packages/coding-agent/src/core/agent-session.ts` — kept downstream session-runtime + epi runtime bridge, reapplied upstream session header imports and retry-related fixes
  - `packages/coding-agent/src/core/extensions/runner.ts` — kept downstream epi runtime injection, adopted upstream keybinding-id reservation and provider bindCore signature
  - `packages/tui/test/tui-render.test.ts` — kept upstream resize/keybinding test helpers and downstream non-fatal render regression coverage
  - `packages/agent/package.json`, `packages/coding-agent/package.json`, `package-lock.json` — updated to upstream package versions while preserving downstream-required dependencies (`@sinclair/typebox`, `@opentelemetry/api`)
- verification:
  - [x] `cd packages/tui && node --test --import tsx test/tui-render.test.ts`
  - [x] `cd packages/agent && npm run build`
  - [x] `./install-epi.sh`
- notes:
  - current carry patch still expected: `packages/tui/src/tui.ts` — keep render failures and overwide lines loud but non-fatal
  - `packages/agent/src/proxy.ts` no longer required a downstream carry patch after this sync; `npm run build` passed without local delta
  - `packages/ai/src/models.generated.ts` was regenerated during verification, but incidental churn should be left out of the sync merge unless intentionally committed as a separate generated refresh

## Sync 2026-03-29
- merged: `upstream/main @ fa890e3f`
- branch: `sync/upstream-2026-03-29`
- conflicts:
  - `packages/coding-agent/src/core/agent-session.ts` — kept upstream definition-first tool/runtime structure, reapplied downstream epi runtime bridge and `epi_user_turn_ready` emission
  - `packages/coding-agent/src/core/extensions/loader.ts` — combined upstream extension source metadata with downstream host-capability runtime exposure
  - `packages/tui/src/tui.ts` — kept upstream resize/cell-size flow, reapplied downstream non-fatal render overflow and render-error recovery
  - `packages/agent/package.json`, `packages/coding-agent/package.json`, `package-lock.json` — updated to upstream package versions while preserving downstream-required dependencies (`@sinclair/typebox`, `@opentelemetry/api`)
- verification:
  - [x] `cd packages/tui && node --test --import tsx test/tui-render.test.ts`
  - [x] `cd packages/coding-agent && npx tsx ../../node_modules/vitest/dist/cli.js --run test/host-capabilities.test.ts test/trigger-compact-extension.test.ts`
  - [x] `npm run check`
- notes:
  - current carry patches still expected: `packages/tui/src/tui.ts` for loud-but-non-fatal render failures/overwide lines, `packages/coding-agent/src/core/agent-session.ts` for epi runtime + turn-ready integration, and `packages/coding-agent/src/core/extensions/loader.ts` for host-capability exposure alongside upstream source info
  - `packages/ai/src/models.generated.ts` came across from upstream merge; no additional local regeneration was needed and no separate generated refresh commit was created
  - the checked-out `effect-native-core` worktree had pre-existing local dirt in `packages/ai/src/models.generated.ts`, so this sync was prepared on a temporary worktree branch instead of updating that checkout in place
- reflection:
  - surprisingly easy: upstream’s tool-definition refactor in `agent-session.ts` auto-merged cleanly outside the import seam, so the downstream epi carry stayed narrow
  - repeated friction: package-manager state lives outside the git worktree; temporary sync worktrees need shared `node_modules` symlinks before verification
  - next carry to reduce: move `epi_user_turn_ready` and epi runtime exposure farther out of `agent-session.ts` if a cleaner extension/session seam becomes available
  - process update: when the primary checkout is dirty, prefer a temporary sync worktree immediately instead of discovering that constraint mid-merge

## Sync 2026-03-30
- merged: `upstream/main @ 5e3852fc`
- branch: `sync/upstream-2026-03-30`
- conflicts:
  - `packages/agent/package.json`, `packages/coding-agent/package.json`, `package-lock.json` — updated to upstream `0.64.0` package versions while preserving downstream-required dependencies (`@sinclair/typebox`, `@opentelemetry/api`)
- verification:
  - [x] `cd packages/tui && node --test --import tsx test/tui-render.test.ts`
  - [x] `cd packages/agent && npm run build`
  - [x] `cd packages/coding-agent && npx vitest --run test/host-capabilities.test.ts test/trigger-compact-extension.test.ts`
  - [x] `cd packages/coding-agent && npx vitest --run test/user-turn-ready.test.ts test/agent-session-runtime-invariants.test.ts`
  - [x] `./install-epi.sh`
- notes:
  - current carry patches still expected: `packages/tui/src/tui.ts` for loud-but-non-fatal render failures/overwide lines, `packages/coding-agent/src/core/agent-session.ts` / `session-runtime.ts` / `user-turn-ready.ts` for epi runtime + turn-ready integration, and `packages/coding-agent/src/core/extensions/loader.ts` / `host-capabilities.ts` for downstream host-capability exposure
  - `packages/ai/src/models.generated.ts` was regenerated during `./install-epi.sh`, but that incidental generated churn was dropped from the sync branch instead of being committed as part of the merge
  - the temporary sync worktree needed its own `npm install`; a shared `node_modules` symlink reused workspace links from the primary checkout and surfaced stale package outputs during verification
- reflection:
  - surprisingly easy: upstream `0.64.0` landed with only package manifest / lockfile conflicts against the current downstream carry set
  - repeated friction: temporary worktrees can inherit misleading workspace symlinks when they borrow another checkout’s `node_modules`
  - next carry to reduce: move `epi_user_turn_ready` and epi runtime exposure farther out of `agent-session.ts` if a cleaner extension/session seam becomes available
  - process update: when a temporary sync worktree needs package-manager state, prefer a local `npm install` in that worktree over a shared `node_modules` symlink if workspace package links matter for build/test correctness

## Sync 2026-04-07
- merged: `upstream/main @ 773f91f4`
- branch: `sync/upstream-2026-04-07`
- conflicts:
  - `packages/coding-agent/src/core/agent-session.ts` — kept downstream session-runtime + epi runtime bridge, reapplied reload auth/model refresh, and adapted upstream Agent API removal of `setSystemPrompt()` to `agent.state.systemPrompt = ...`
  - `packages/agent/package.json`, `packages/coding-agent/package.json`, `package-lock.json` — updated to upstream `0.65.2` workspace versions while preserving downstream-required dependencies (`@sinclair/typebox`, `@opentelemetry/api`)
- verification:
  - [x] `cd packages/tui && node --test --import tsx test/tui-render.test.ts`
  - [x] `cd packages/agent && npm run build`
  - [x] `cd packages/coding-agent && npx vitest --run test/host-capabilities.test.ts test/trigger-compact-extension.test.ts test/user-turn-ready.test.ts test/agent-session-runtime-invariants.test.ts`
  - [x] `./install-epi.sh`
- notes:
  - current carry patches still expected: `packages/tui/src/tui.ts` for loud-but-non-fatal render failures/overwide lines, `packages/coding-agent/src/core/agent-session.ts` / `session-runtime.ts` / `user-turn-ready.ts` for epi runtime + turn-ready integration, and `packages/coding-agent/src/core/extensions/loader.ts` / `host-capabilities.ts` for downstream host-capability + layered-extension support
  - `packages/tui/test/virtual-terminal.ts` now waits for timer-driven renders so `tui-render.test.ts` stays truthful after upstream render throttling
  - `packages/ai/src/models.generated.ts` changed as part of the upstream merge state, and the additional live-catalog regeneration from `./install-epi.sh` was dropped before commit so the sync does not carry extra incidental churn
  - this sync was prepared in a temporary worktree because the primary checkout had pre-existing dirt in `packages/ai/src/models.generated.ts`, `packages/coding-agent/src/core/agent-session.ts`, and `packages/coding-agent/test/agent-session-runtime-invariants.test.ts`
- reflection:
  - surprisingly easy: loader/host-capability carry auto-merged cleanly despite broader upstream coding-agent churn
  - repeated friction: upstream’s timer-throttled TUI renders can make existing test helpers observe the terminal too early unless the harness waits for scheduled writes
  - next carry to reduce: move `epi_user_turn_ready` and epi runtime exposure farther out of `agent-session.ts`, and carve loader descriptor support into a seam smaller than the current `loader.ts` delta if upstream offers one
  - process update: when upstream introduces timer-based rendering or other delayed side effects, update verification helpers in the same sync so tests wait on the real seam instead of an outdated immediate-write assumption

## Sync 2026-04-14
- merged: `upstream/main @ 8f66938c`
- branch: `sync/upstream-2026-04-14`
- conflicts:
  - `packages/agent/package.json`, `packages/coding-agent/package.json`, `package-lock.json` — updated to upstream `0.67.1` workspace versions while preserving downstream-required dependencies (`@sinclair/typebox`, `@opentelemetry/api`)
- verification:
  - [x] `cd packages/tui && node --test --import tsx test/tui-render.test.ts`
  - [x] `cd packages/agent && npm run build`
  - [x] `cd packages/coding-agent && npx vitest --run test/host-capabilities.test.ts test/trigger-compact-extension.test.ts test/user-turn-ready.test.ts test/agent-session-runtime-invariants.test.ts`
  - [x] `./install-epi.sh`
  - [x] `npm run check`
- notes:
  - current carry patches still expected: `packages/tui/src/tui.ts` for loud-but-non-fatal render failures/overwide lines, `packages/coding-agent/src/core/agent-session.ts` / `session-runtime.ts` / `user-turn-ready.ts` for epi runtime + turn-ready integration, and `packages/coding-agent/src/core/extensions/loader.ts` / `host-capabilities.ts` for downstream host-capability + layered-extension support
  - `packages/coding-agent/test/host-capabilities.test.ts` and `test/agent-session-runtime-invariants.test.ts` needed a downstream follow-up from `new ModelRegistry(...)` to `ModelRegistry.create(...)` after upstream made the constructor private
  - `packages/ai/src/models.generated.ts` changed as part of the upstream merge state, and the additional live-catalog regeneration from build/install verification was dropped before finishing the sync so the merge does not carry extra incidental churn
  - this sync was prepared in a temporary worktree because the primary checkout had pre-existing dirt in `packages/ai/src/models.generated.ts`
- reflection:
  - surprisingly easy: the downstream carry files (`agent-session.ts`, `tui.ts`, loader/host-capability files) auto-merged cleanly; only package manifests / lockfile conflicted
  - repeated friction: package-based tests and workspace typechecks in a temporary worktree still need local built `dist/` outputs for workspace imports such as `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, and `@mariozechner/pi-web-ui`
  - next carry to reduce: keep chasing smaller seams for the coding-agent carries so future syncs keep landing as package/version bumps instead of core-file conflicts
  - process update: when root `npm run check` fails in a temporary worktree on missing workspace package entrypoints, build the depended-on workspace package in that worktree before retrying the check
