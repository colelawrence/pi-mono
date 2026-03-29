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
git push origin effect-native-core
```

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

Verification:
```bash
cd packages/tui
node --test --import tsx test/tui-render.test.ts
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
