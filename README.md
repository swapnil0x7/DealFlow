# DealDesk

A one-screen sales workspace for finding deals that need attention and changing stages safely. The design targets 50,000 deals and 20 salespeople.

**Current implementation: Stages 1–4 — data/API, workspace, single-deal workflows, and simulated collaboration.** The browser loads 50,000 deals into a virtualized table with filters, attention reasons, keyboard stage editing, persistent save results, Retry, conflict review, reconciliation, and guarded Undo. Versioned live updates, teammate simulation, and visible simulation/reset controls are available. Bulk selection and execution belong to Stage 5. See [the development checkpoints](./IMPLEMENTATION_PLAN.md) and [the source design](./plan.md).

## Run locally

Use Node 24 LTS (see `.nvmrc`) and npm. Dependencies are locked in `package-lock.json`.

```bash
npm ci
npm run dev
```

Open the localhost URL printed by Vite. First installation requires network access. Use localhost or HTTPS: the simulator registers a service worker before loading deals. A startup or loading error shows recovery controls.

For the production demo:

```bash
npm run build
npm run preview
```

MSW intentionally runs in development **and** the built demo. This project has no real backend. State is in memory in the app's JavaScript context; reload/reset starts a fresh session. Separate tabs do not share an authoritative repository.

The Stage 0 `npm start` bootstrap has not been implemented; use the commands above for the current implementation.

## Checks

```bash
npm run typecheck
npm run lint
npm test
npm run test:watch
```

Browser tests launch a production preview automatically:

```bash
npx playwright install chromium
npm run test:e2e
```

If Google Chrome is already installed, macOS/Linux can use `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` instead. The development-only AG Grid diagnostics are also checked with:

```bash
PLAYWRIGHT_DEV=1 PLAYWRIGHT_CHANNEL=chrome npx playwright test tests/tooltips.spec.ts --workers=1
```

 Browser installation is separate from running the app. Browser tests use port 4173 and require it to be available. See [validation notes](./docs/validation.md) for actual results and environment details.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/domain/deal.ts` | Closed stage union, immutable deal/owner contracts, readable labels |
| `src/api/contracts.ts` | Commands, results, errors, receipts, snapshots, cursor contracts, runtime command validation |
| `src/api/client.ts` | Typed HTTP requests, session generation guards, transport uncertainty |
| `src/mocks/seed.ts` | Seeded randomness, injected clock, repeatable 50,000-deal dataset |
| `src/mocks/repository.ts` | Authoritative data, atomic guarded commits, mutation deduplication, receipts, bounded change feed |
| `src/mocks/simulation.ts` | Adjustable faults/delay/offline behavior, session reset, abortable timers |
| `src/mocks/handlers.ts` | HTTP adapters shared by browser and Node integration tests |
| `src/mocks/browser.ts` | Service-worker startup and development cleanup |
| `src/features/collaboration/` | Immutable confirmed records, single-flight feed/cursor recovery, session ownership, connection status, and simulation controls |
| `src/domain/attention.ts`, `src/domain/filters.ts` | Explainable priority rules and shared filter predicates for grid/future selection |
| `src/features/pipeline/` | Cached incremental row projection/counters, workspace controls, read-only grid editing requests, CSS Modules |
| `src/features/operations/` | Session-scoped Zustand operation store/service, persistent results, Radix conflict review, recovery and Undo |
| `src/shared/format.ts` | Reused INR, count, and local-date formatters |

React receives snapshots through HTTP; it does not access or mutate the repository directly. Mutation versions are checked immediately before commit, without an await before updating the record, receipt, and event. Returned records are separate copies. INR values are integer paise; timestamps are ISO strings. A stage change never fabricates customer activity.

### Mutation and retention rules

- Every command captures a session, deal ID, expected version, target stage, actor, and mutation ID.
- Repeating the same mutation ID and payload reuses its result, including while it is in flight. A changed payload is rejected.
- A pre-commit failure is retryable using the original ID/version. A conflict includes the latest record; a reviewed replacement must use a new ID.
- Same-stage commands are reported as skipped, with no version increment or change event.
- A transport error means the outcome may be unknown. Query the operation receipt rather than assuming the save failed.
- Up to 100,000 unique validated mutation attempts are retained per session, including conflicts and retryable attempts. Receipts are not pruned within a session: recovery and future Undo remain possible. At capacity, new mutation IDs receive `history_full`; existing IDs still reconcile/retry. Inspect outstanding work before resetting. Reset/reload expires the entire session and its receipts.
- The feed retains the latest 10,000 actual changes in a ring buffer. Pages return at most 500 events. An expired cursor explicitly requests a new snapshot; a snapshot and its cursor are captured together.
- Bulk API batches accept 1–200 unique deals/mutation IDs and return attributable per-item outcomes. Whole-request transport errors require per-item reconciliation. The future UI scheduler will bound the number of concurrent batches.

## Simulation API

Open **Simulation** in the header to adjust the fake API, enable teammates, exercise recovery scenarios, or reset the demo. The API remains available for repeatable scripts; examples can run in the browser console.

```js
await fetch('/api/simulation', {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ minSaveDelayMs: 0, maxSaveDelayMs: 0, failureRate: 0 }),
})
```

| Endpoint | Behavior |
| --- | --- |
| `GET /api/deals` | All deals, owners, session ID, matching change cursor |
| `PATCH /api/deals/:id` | Guarded single move |
| `POST /api/deals/bulk-move` | `{ commands: [...] }`, at most 200 |
| `GET /api/operations/:mutationId` | Unknown, pending, retryable, or completed outcome |
| `GET /api/changes?after=cursor` | Ordered changes, next cursor, more-pages/resync flags |
| `GET /api/simulation` | Settings, seed, and current session ID |
| `PATCH /api/simulation` | Validated partial settings update |
| `POST /api/simulation/faults` | `{ fault: 'save-failure' | 'read-failure' | 'lost-response' }` |
| `POST /api/simulation/conflict` | `{ dealId }`; immediately attempt a guarded edit as another actor |
| `POST /api/simulation/reset` | `{ seed: 42 }`; discards all current in-memory work |

Data writes, operation lookups, and feed reads require `X-DealDesk-Session` from the latest snapshot. Move bodies require `stage`, `expectedVersion`, `mutationId`, and a valid seeded `actorId`; bulk items also require `dealId`. The typed client carries these contracts and guards late responses after a local reset.

Default saves wait 300–1,500 ms and independently fail before commit with probability 0.1 per attempted deal. Each batch item uses its own delay/failure draw. Reads have a lightweight 20 ms delay and only fail under explicit faults/offline mode. A fixed seed and clock make fixtures deterministic; the running demo uses actual time. Delay changes affect new attempts; offline mode is checked again before commit.

Settings accept integer delay bounds from 0–30,000 ms, minimum ≤ maximum, `failureRate` from 0–1, boolean `offline`, boolean `teammatesEnabled`, integer `teammateIntervalMs` from 500–30,000, and boolean `changeDeliveryPaused`. Unknown settings are rejected atomically. Offline mode blocks reads, writes, and change delivery; local control endpoints remain reachable so the demo can reconnect/reset. Forced save faults apply to the next eligible user attempt; background teammates do not consume them. Fail next read applies to the next data read, which may be a feed/receipt read. A lost-response fault drops the response after committing, leaving its receipt available.

Reset cancels timers, invalidates the old repository, changes the session ID, clears faults/settings/history, and regenerates data from the requested unsigned 32-bit seed. Late work cannot mutate the new repository. The client disposes old polling/operation services, invalidates outstanding requests, and creates a new matching snapshot/cursor. Filters, results, and the last focused deal are cleared.

## Using the workspace

- **All deals** shows the full dataset; **My deals** uses the fixed demo identity, Aarav Shah (`owner-1`). **Needs attention** includes only open, flagged deals.
- Company search ignores case and outer whitespace, with a 200 ms debounce. Owner, stage, search, and work-view criteria combine with AND. View badges show totals before toolbar filters; the matching count describes the actual filtered list. Clear filters retains the active work view.
- New leads aged at least two whole elapsed days are flagged. Open deals inactive for seven days are flagged; negotiations inactive for fourteen days have highest urgency. Absent activity uses creation time. New-lead waiting ranks above general inactivity. Won/Lost are excluded.
- Needs attention defaults to urgency, oldest activity, value descending, then stable ID. Other views start with company ascending. Column headers let users override sorting. Changing filters preserves the chosen sort; switching work views resets the default sort.
- The “How attention works” disclosure explains the rules. Priorities are checked every minute when idle; active work defers reevaluation behind an explicit Refresh priorities action. Refresh returns focus to search.
- Tab reaches toolbar controls and grid headers. Arrow keys navigate cells, Home/End reach the first/last row, and Enter sorts a focused column header; Enter/F2 edits a stage cell, and Escape cancels the editor. Tab from the final cell reaches Back to filters; activating that link returns to search. On keyboards without a physical Home/End key, use the operating system's equivalent.
- INR amounts and dates use native `Intl` formatting. Activity cells distinguish absent activity from an actual recorded date. Confirmed status reflects the loaded record; operation-specific status appears after an edit.

## Changing one deal safely

Focus a Stage cell and press Enter (or F2 then open its selector). Choose a stage with the arrow keys and confirm with Enter; Escape cancels. Double-click also opens the editor. The confirmed stage stays visible with “Moving to …” until a successful response or matching receipt confirms it. Another local write to that deal is blocked while its outcome remains unresolved; other deals stay usable.

Recent changes below the table retains every operation's result and actions. Failures leave confirmed data intact. Retry save uses the original mutation ID, expected version, and payload. A conflict updates the read model to the latest confirmed record and offers Review conflict. The accessible dialog compares the originally reviewed version, the latest version captured at review, and the intended stage. Keep latest stage/Escape submits nothing; Apply reviewed change creates a new guarded command. Another intervening edit conflicts again.

A lost response or a 10-second timeout is **unconfirmed**, because the server may still commit. The service attempts receipt reconciliation once. If it cannot confirm the outcome, Check status remains available; the deal stays blocked and cannot be dismissed or undone. A pending receipt never triggers another write. If reconciliation establishes that no committed receipt exists, Retry original change checks again before resending the same guarded command. A late matching response/event can still confirm success and cannot regress a newer read-model version. `confirmChange` is wired to the live feed, so a matching event can confirm a save before its HTTP response. Receipt reconciliation remains available when delivery is paused.

Undo move creates a new command guarded by the version produced by the successful move, restoring its previous stage. It is offered once for that move while the known version remains eligible. A newer unseen teammate edit produces a conflict instead of being reversed. Failed Undo can retry through its own result; the original move's success stays intact. Reviewed replacements and Undo attempts have separate linked entries.

Saved record changes update only affected grid rows through transactions. Sorting/filter membership is deferred so the row remains inspectable, with a visible Refresh list action and a “displayed deals” count while stale. Refresh reapplies membership/order and returns focus to the active deal or a sensible fallback. Changing criteria also recomputes the list. Explicit/idle priority refresh rebuilds the time-sensitive projection and recomputes membership. View badges track current confirmed data independently of mounted rows.

UI history retains at most **200 commands** per session without silent eviction. Dismiss result explicitly removes that result's Retry/Undo availability and frees space. Unconfirmed/saving operations and parents of unresolved child operations cannot be dismissed. When full, new commands are refused until a resolved result is dismissed. Repository receipts have their separate 100,000-mutation session cap. An expired simulation session disables further commands and offers Reload workspace; expired receipts cannot be recovered.

## Live updates and simulation

The header shows connection status and a quiet count of received changes, including this user's own saves. The client polls about once a second with one current request chain. It drains ordered pages from the last applied cursor and advances only after applying the whole page and matching operation confirmations. Normal changes update affected rows and do not reload all 50,000 records.

Hidden pages and browser offline events pause feed reads. On foreground/focus/reconnect, the feed catches up from its cursor. Offline simulation also blocks the fake API and pauses new teammate work. A reconnect action may probe the local control plane, which remains available offline. A request that hangs for 10 seconds is aborted at the client and retried from the last applied cursor; late cancelled replies are ignored.

If the 10,000-change log no longer contains the cursor, the client performs an explicit resync into the same confirmed read model. Resync leaves captured commands/versions unchanged, notifies an optional selection-preservation observer, and checks unconfirmed operation receipts with bounded read concurrency. It never automatically retries writes. A new server session expires the old client instead of silently merging different sessions.

Live values update through stable row IDs, while list order and membership stay deferred until Refresh list or a deliberate view/filter/priority refresh. Displayed rows that no longer match filters are labeled. While an editor is open, its reviewed snapshot stays fixed and that row's newer values wait until commit/cancel. Submitting still uses the original reviewed version, so an intervening teammate edit conflicts. Refresh list preserves the focused deal/cell where possible, brings it into view if reordering moved it, or uses a nearby/search fallback.

Teammates are **off by default**, with a default 4,000 ms interval when enabled. One scheduled producer chooses another seeded actor, a deal, and a different stage; it uses the same delayed, failure-prone, version-guarded write path. The next attempt waits for the current attempt to settle, so effective spacing includes save latency. Stopping/reconfiguring/offlining/resetting cancels scheduled teammate work. The simulator owns those backend timers; the client owns its feed timers/listeners. No real cross-tab/backend collaboration is implied.

For a repeatable conflict, click a deal cell or navigate to it with the grid keyboard, open Simulation, and choose **Create unseen teammate edit**. This pauses delivery and commits the next stage immediately through the guarded repository as another actor, bypassing random faults for repeatability. Close the panel and edit the stale displayed stage to see a conflict. Uncheck Pause change delivery and Apply settings to resume delivery. Ordinary background teammate attempts still use configured delay/failure behavior.

**Pause change delivery** holds feed events/cursor without preventing saves or receipt lookups; lightweight polling detects delivery resume. **Offline simulation** interrupts data reads/saves, stops new teammate work, and pauses client data polling. Delay/failure settings affect new attempts, while offline mode is rechecked before commit. Reset requires explicit confirmation and clears all pending/recoverable work; old-session receipts cannot be recovered. Close/cancel/Escape leaves existing data intact.

## Current limits

Exact selection/version snapshots, bounded bulk scheduling, and partial bulk Retry/Undo are Stage 5 work. Stage 4 defines the resync observation boundary and preserves operation/editor snapshots; it does not claim completed bulk-selection correctness. Full mixed-workload profiling, assistive-technology/zoom review, one-command bootstrap, and submission artifacts remain pending.

This remains an in-memory simulation inside one app context. Reload starts a fresh default demo; separate tabs do not share its authoritative repository. No real backend, authentication, or reload persistence is included. The current production entry chunk is approximately **1.18 MB minified / 343 kB gzip**, and Vite reports a size warning. Loading/parse cost and chunking remain Stage 6 profiling work. The previously recorded development-toolchain advisories remain outstanding.
