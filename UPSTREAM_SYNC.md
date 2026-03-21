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

### `packages/agent/src/proxy.ts`
Intent:
- Keep `tsgo` / native TypeScript builds green without broad tsconfig/lib changes.

Resolution pattern:
- Prefer upstream implementation.
- If `Response` typing breaks under `tsgo`, use a small local structural response type at the fetch call site.
- Keep explicit `body` null checks.
- Avoid repo-wide `lib` or DOM typing changes unless absolutely necessary.

Verification:
```bash
cd packages/agent
npm run build
```

## Generated file policy

### `packages/ai/src/models.generated.ts`
This file can change when `packages/ai` runs `generate-models` against live provider catalogs.

Guideline:
- Do not mix model-catalog refreshes into an upstream sync unless the refresh is intentional.
- Prefer a separate commit titled clearly as a generated-model refresh.
- If a build step dirties this file unexpectedly, decide explicitly whether to keep or drop that refresh before finishing the sync.

Verification:
```bash
cd packages/ai
npm run generate-models
```

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
  - models.generated.ts intentionally refreshed? yes/no
```

## Patch retirement rule

Whenever upstream absorbs one of our carry patches:
- delete the local delta instead of preserving compatibility code
- update this file to remove that patch from the carry inventory
- note the upstream commit/PR that made the carry patch unnecessary

## Sync 2026-03-21
- merged baseline: `upstream/main @ fa877de1`
- downstream branch: `effect-native-core`
- local carry patches currently present or expected:
  - `packages/tui/src/tui.ts` — keep render failures and overwide lines loud but non-fatal
  - `packages/agent/src/proxy.ts` — local structural response typing for `tsgo` / native TS builds
- verification used during this round:
  - [x] `cd packages/tui && node --test --import tsx test/tui-render.test.ts`
  - [x] `cd packages/agent && npm run build`
  - [x] `./install-epi.sh`
- notes:
  - `packages/ai/src/models.generated.ts` may refresh during install/build because it is generated from live provider catalogs; commit it only as an explicit generated refresh, separate from sync-resolution commits when possible
