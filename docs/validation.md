# Validation evidence

## Stage 1 — Domain and fake API

Date: 14 November 2026. Checkpoints: 1.1, 1.2, 1.3 in `IMPLEMENTATION_PLAN.md`.

The working tree is not committed by this implementation task. The original project files were mostly untracked when work began; no automatic commit or staging was performed. `plan.md` remains unchanged.

### Scope verified

| Requirement/scenario | Evidence |
| --- | --- |
| T01 — deterministic data | 50,000 unique IDs, 20 owners, seven stages with 12k/10k/8k/8k/7k/3k/2k populations; valid integer money/dates; repeatable seed/clock; independent records |
| T02 — guarded writes and no-ops | Repository and HTTP tests: a move increments exactly once; invalid input cannot mutate; same-stage move is skipped without an event/version increment |
| T03 — pre-commit failure | Forced failure leaves the saved record unchanged; same mutation ID/version can retry; changed-payload reuse is rejected |
| T04 — concurrency | Independent clients compete for one expected version; exactly one succeeds; a delayed write checks the latest version at commit |
| T06 — lost response foundation | HTTP transport failure after commit leaves a completed receipt; change delivery and reconciliation can be unavailable offline; reconnect/reconciliation and duplicate retry cause no second write |
| T07 — idempotency | In-flight and completed duplicate commands share one effective write; mismatched payloads are rejected |
| T11 — bulk API foundation | Mixed per-item outcomes remain attributable; malformed/oversized/duplicate batches do not begin writes; whole-request response loss is distinct and every launched item can be reconciled |
| T19 — preview/startup/load foundation | Production browser loads 50,000 deals via the service worker; failed initialization shows recovery instructions; initial load failure offers keyboard-operable Retry |
| T20 — session foundation | Reset aborts timers and invalidates old saves/read snapshots; client generation guards reject a late pre-reset HTTP snapshot |
| T21 — feed foundation | Ordered cursor pagination; ring-buffer expiry signals resync; snapshot includes its consistent cursor |
| Retention correctness | At mutation-history capacity, new IDs are rejected without removing recoverable receipts; existing IDs can still reconcile/retry |
| Offline behavior | Browser and HTTP tests block data reads/saves/feed delivery while local simulation controls remain available to reconnect |

“Foundation” means the underlying API behavior is tested. These entries do not claim completion of future UI workflows, teammate polling, selection preservation, or Undo.

### Commands and outcomes

Closing environment: macOS; Node **24.22.3**, npm **11.21.2**, Vitest **4.1.12**, Vite **8.3.8**, Playwright **1.65.1**, locally installed Google Chrome. Node/npm were run from a temporary toolchain; the machine-wide installation was not replaced.

| Check | Actual result |
| --- | --- |
| `npm run typecheck` | Passed with strict application/config/browser-test types |
| `npm run lint` | Passed, no warnings |
| `npm test` | **44 tests passed** across four files (closing run: 602 ms reported duration) |
| `npm run build` | Passed; production assets and MSW worker generated |
| `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` | **4 browser tests passed** against a freshly built production preview (closing run: 6.9 s) |
| `git diff --check` | Passed; newly created source files were also inspected directly |
| `npm audit --omit=dev --json` | **0 known production-dependency advisories** at verification time |

The initial test-runner resolution reported critical development-tooling advisories. Updating to Vitest 4.1.12 removed those critical findings. The full install audit still reports **7 moderate development-toolchain advisories**; these are not a clean full-dependency audit. No forced, potentially incompatible toolchain downgrade/upgrade was applied. Review these during the remaining foundation/toolchain work; the production-dependency audit is clean.

- `npm run typecheck` — strict TypeScript check for application, configs, and browser tests.
- `npm run lint` — application/config/tests; generated MSW worker excluded.
- `npm test` — deterministic domain/repository/simulation/HTTP tests.
- `npm run build` — production bundle, including the simulator and generated worker asset.
- `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` — production-preview browser checks, using locally installed Chrome.

Initial verification on the host Node 23.11.0/npm 11.4.2 passed 43 domain/API tests and four browser checks. The host runtime produced engine warnings for existing tooling; Node 24 is the documented target in `.nvmrc`. The first browser launch was blocked by sandbox restrictions on binding localhost; the approved run outside the sandbox passed all four browser checks. A dependency advisory check triggered a patched test-runner update and a closing LTS verification run.

Browser scenarios:

1. Await worker initialization, load the full dataset, execute a guarded move, repeat it, and verify one feed event.
2. Force the initial load to fail, then focus Retry and activate it with Enter.
3. Force worker registration to fail and verify startup recovery instructions instead of a false empty/successful workspace.
4. Simulate offline reads, reconnect through local controls, and load the full dataset again.

### Architecture decisions verified by these checks

- Authoritative state is isolated inside `DealRepository`; constructor inputs and all outgoing record snapshots are copied.
- Command validation occurs before reservation/mutation. The version check and record/receipt/change write form one synchronous commit boundary.
- Delays and faults live in `Simulation`, with injected clock/random/wait/data factories for deterministic tests.
- Each session retains at most 100,000 unique validated mutation attempts. No receipts are silently pruned; a full ledger rejects new IDs. Reset/reload invalidates the complete session and its receipt references. This favors bounded, explicit recovery semantics over silent eviction; large repeated operations may require a reviewed reset.
- The last 10,000 actual changes use a ring buffer, so bounded retention does not shift a large array on every save. Feed pages are limited to 500 events.
- Every launched bulk item settles before a request-wide uncertainty response is returned. Per-item outcomes stay distinguishable from a lost transport response.
- Bootstrap starts MSW before rendering the data-loading application in development and production. A startup failure is visible and recoverable.

### Not verified or not implemented yet

- Stage 0 is partial: there is no `npm start` installer/bootstrap or final fresh-checkout acceptance check (T24).
- No interactive table, search/filter/attention UI, single/bulk results controls, selection snapshots, Undo UI, or teammate feed consumer exists yet. Their associated browser/UX criteria remain pending.
- These are correctness and startup checks, not production interaction-performance measurements (T22). No scrolling/filtering/bulk UI throughput or long-task/memory claims are made.
- Keyboard verification currently covers the load-recovery button only; full workflow keyboard/axe/screen-reader checks remain pending (T17/T23).
- No reload persistence, cross-tab collaboration, backend, or authentication is implemented.
- Actual development time was not tracked reliably for this stage; no six-hour completion claim is made.

Official integration references consulted during implementation: [MSW browser setup](https://mswjs.io/guides/integrations/browser), [MSW Node setup](https://mswjs.io/guides/integrations/node), and [Vitest setup](https://vitest.dev/guide/). Installed package types were used to confirm version-specific APIs, including MSW 3's unhandled-frame option.


## Stage 2 — Readable workspace

Date: 14 November 2026. Checkpoints **2.1–2.3 implemented and verified**. This section supersedes Stage 1's then-pending workspace limits; Stage 1 remains a historical record. Source design `plan.md` was not changed. No Stage 2 Git commit or staging was performed.

### Implementation boundaries

- `ConfirmedReadModel` indexes immutable confirmed records by stable ID. It copies/freezes incoming records, ignores older/equal versions, caches all-record snapshots until real changes, and publishes one final changed version per ID per batch. It does not replace the authoritative fake repository. UI command/feed consumers remain later work.
- Matching lives in shared domain predicates; it is independent of mounted grid rows. The grid uses these predicates as an external filter. Initial HTTP load is the only data fetch needed for search/view/owner/stage changes.
- Row projections and attention reasons are computed outside cell renderers and memoized independently of search input. Native Intl formatters, column definitions, themes, IDs, and grid configuration are reused. React does not render 50,000 row components.
- AG Grid **Community 36.3.0** and its matching React adapter use the client-side row model and registered Community modules only. Row/column virtualization stays enabled, the viewport is bounded, rows have fixed heights, animations are disabled, and `ensureDomOrder` keeps rendered DOM order aligned with visible sorting.
- All deals/My deals/Needs attention are views of the same table. Aarav Shah is the fixed current salesperson. View badges show pre-toolbar-filter totals; matching counts reflect the complete combined criteria. Clear filters retains the work view. Search trims whitespace/ignores case and debounces by 200 ms.
- Attention uses whole elapsed 24-hour periods: new lead age ≥2 days, open-deal inactivity ≥7 days, negotiation inactivity ≥14 days. Missing activity uses creation time; Won/Lost are excluded. Urgency is negotiation > new lead waiting > general inactivity. Ties use activity baseline ascending, value descending, and stable ID. No activity dates are invented.
- Needs attention defaults to priority sorting; other work views default to company ascending. Header sorting remains available, and ordinary filter changes preserve the chosen sort.
- A cleaned-up 60-second timer reevaluates idle time-based priorities; active/hidden work defers reevaluation behind a visible prompt. Explicit refresh returns focus to search. Timer cleanup is paired with effect cleanup.
- Loading, retryable loading error, worker startup error, an empty dataset, and zero matching rows have explicit states. Read-only rows show Confirmed; editing/result controls are reserved for Stage 3.

### Automated results

Closing environment: macOS **26.5.2 arm64**, Node **24.22.3**, npm **11.21.2**, Vitest **4.1.12**, Vite **8.3.8**, Playwright **1.65.1**, Google Chrome **157.0.8103.51**. Temporary Node/npm toolchain; no machine-wide runtime replacement. Browser checks require localhost/Chrome access outside the restricted execution sandbox.

| Check | Actual result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with no warnings |
| `npm test` | **58 tests passed across 8 files**, including all Stage 1 regression tests |
| `npm run build` | Passed; Vite reports the larger-than-500-kB entry-chunk warning described below |
| `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- --workers=1 --reporter=json` | **11 passed, 0 failed/skipped/flaky**, 31.74 seconds total browser-suite duration |
| `git diff --check` | Passed; new files inspected separately |

New domain/read-model/projection checks cover T05 foundation and T18: stale/equal version rejection, immutable client records and cache invalidation, unsubscription, exact thresholds with one-millisecond-before-boundary checks, absent activity, excluded closed deals, future timestamps, competing attention reasons, priority tie-breaks, AND-composed filters, and 50,000-record membership independent of rendered rows.

Stage 2 browser scenarios (seven checks), plus the four retained Stage 1 scenarios:

1. Load all 50,000 records, prove bounded mounted rows, combine case-insensitive/trimmed company search with owner and stage, verify 250 exact matches, and clear back to 50,000. Filters do not issue additional `/api/deals` requests.
2. My deals has 2,500 rows. Composing it with another owner's filter yields zero; clear recovers the current view, and All deals restores 50,000.
3. Tab through search → owner → stage → attention disclosure → grid header; use ArrowDown into rows, arrows between rows, End to focus the final off-screen row/cell, Tab out to Back to filters, and Enter to return to search. Rendering remains bounded after the jump.
4. Fixed-date explicit fixtures verify reason text, closed-deal exclusion, priority order, and keyboard header sorting. The test does not calculate its expected order using the production comparator.
5. Cross a new-lead attention threshold with a controlled clock while search has focus: defer the changed membership, show Refresh priorities, then include the newly eligible record after explicit refresh.
6. Full-volume rendered workspace passes axe with **zero violations**. At **390×844** the toolbar remains available and document-wide horizontal overflow is absent; table overflow stays inside the grid.
7. An empty API snapshot shows an explicit no-data overlay and a zero matching count.

The first browser runs caught test assumptions about older AG Grid DOM containers/keyboard defaults and its new separate no-matching-rows overlay. The implementation now follows installed v36.3 APIs; current tests explicitly distinguish visible overlays from the grid's separate live announcement. Contrast findings in summary labels were fixed. The workspace screenshot was visually inspected for hierarchy, table density, labels, and internal overflow.

### Initial full-volume baseline (T22 foundation)

Single closing run, one browser worker, production preview on localhost, default **1280×720** viewport, no explicit CPU/network throttling, 50,000 seeded deals/20 owners. These values include browser automation overhead and are an initial baseline, not a statistical benchmark or a final performance gate.

| Measurement | Observed |
| --- | --- |
| Navigation to initialized grid with 50,000-row count | **1,730 ms** |
| Search + owner + stage interaction to 250 matching rows | **311 ms**, including 200 ms search debounce and automation |
| Keyboard End jump to focused final row/cell | **81 ms** |
| Initially mounted data rows | **14** |
| Mounted rows after final-row navigation | **Fewer than 80**, as asserted |
| Filter-time full-dataset reloads | **0** additional `/api/deals` requests |

The browser JSON report and screenshot are generated test artifacts, excluded from source control; measurements above are retained as the durable evidence. Reproduce baseline collection with the single-worker JSON reporter command above. Numbers will vary with the machine, date, viewport, and browser load.

### Limits and follow-up gates

- The production entry chunk is approximately **1,031 kB minified / 298 kB gzip** after adding Community grid functionality; Vite emits a size warning. The simulator remains a separate approximately 409 kB minified chunk. These sizes are recorded rather than hidden by raising the warning limit. Profile loading/parse costs and consider chunking during Stage 6.
- Axe and the tested keyboard path do not establish full accessibility. Manual assistive-technology/screen-reader and actual zoom checks remain pending. Grid virtualization inherently exposes only mounted rows to the DOM at a given time; it was not disabled for axe.
- Operation UI, stage editing, selection/version capture, bulk processing, teammate polling, focus/scroll preservation under live changes, and comprehensive performance/long-task/memory measurements remain in later stages. No bulk-under-load or teammate-workload performance claims are made here.
- The existing seven moderate development-toolchain advisories remain as recorded in Stage 1. The new dependencies are pinned and the lockfile is kept consistent; no blanket security upgrades or incompatible toolchain downgrades were performed.
- Stage 0's `npm start` clean-checkout bootstrap and final submission artifacts are still pending. Actual development time for this stage was not tracked reliably; no time-budget completion claim is made.

Official references consulted: [AG Grid Community setup](https://www.ag-grid.com/react-data-grid/getting-started/), [keyboard interaction](https://www.ag-grid.com/react-data-grid/keyboard-navigation/), [grid options](https://www.ag-grid.com/react-data-grid/grid-options/), and [transaction updates](https://www.ag-grid.com/react-data-grid/data-update-transactions/). Installed types/source were checked for v36.3-specific module registration, overlay parameters, and navigation behavior.


### Stage 2 follow-up — development tooltip deprecation

A development browser reported AG Grid #306: `tooltipValueGetter` was deprecated in v36.2. The earlier Stage 2 browser suite ran against the production build, where development validation is disabled, so it did not expose this warning.

Replaced the activity getter with the supported `tooltip` callback and the attention getter with `tooltip: true`. The activity fallback still explains the creation-date baseline, and attention tooltips still show the displayed reason. Development validation remains enabled.

Added `tests/tooltips.spec.ts` to check recorded activity, missing activity, and attention content with fixed-date fixtures, collect AG Grid warning/error messages, and assert that the development deprecation popup is absent. Playwright now accepts `PLAYWRIGHT_DEV=1` to launch Vite development mode on its isolated test port instead of production preview.

Actual closing checks on Node 24 / local Chrome:

- `PLAYWRIGHT_DEV=1 PLAYWRIGHT_CHANNEL=chrome npx playwright test tests/tooltips.spec.ts --workers=1` — **1 passed**, 10.9 seconds suite duration; no AG Grid warnings/errors.
- `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- tests/tooltips.spec.ts --workers=1` — build passed and **1 passed**, 6.6 seconds browser-suite duration.
- Typecheck, lint, and `git diff --check` passed. The existing production entry-chunk size warning remains unchanged.

The preceding 58-unit/11-browser results describe the Stage 2 closing run; this follow-up reran the affected tooltip behavior in both modes rather than claiming a new full-suite run. Refreshing an already-open development page clears the old validation popup. Reference: [AG Grid tooltip configuration](https://www.ag-grid.com/react-data-grid/tooltips/).

## Stage 3 — Single-deal workflow

Date: 14 November 2026. Checkpoints **3.1–3.3 implemented and verified**. Earlier sections remain historical snapshots; single-deal editing, results, Retry, conflict review, reconciliation, and Undo are now implemented. No commit/staging was performed for this stage; the earlier Stage 2 working-tree changes remain present. `plan.md` was not modified.

### Implementation and consistency rules

- `OperationService` owns a session-scoped vanilla Zustand store. The service takes an injected API, confirmed read model, session/actor identity, clock, ID source, timeout, and history bound. Components issue commands and render narrow subscriptions; they do not implement saved-record consistency or maintain another saved-data database.
- Commands capture the displayed deal version, previous stage, target, actor/session, and stable mutation ID. Explicit states cover queued/saving/succeeded/failed/conflicted/unconfirmed/skipped. Attempt counts, original guards, linked replacement/Undo commands, persistent errors, and resulting receipts remain inspectable.
- AG Grid's Community select editor uses `readOnlyEdit` and `onCellEditRequest`; it never writes into frozen confirmed records. Enter/F2 opens editing, Escape cancels, and the selected change becomes an application command. Confirmed stage remains visible with pending text. Unresolved work blocks another local command on that deal while other deals remain usable.
- Definite failure preserves confirmed data. Retry keeps the exact original command; a newer saved version produces a conflict rather than being silently adopted.
- A transport error or the 10-second timeout stays unconfirmed and triggers one receipt lookup. Pending/unknown/unavailable reconciliation is visible. Check status can resolve the original command. Explicit Retry original change reconciles again before resending an eligible unknown/retryable command. No automatic mass retry or outcome polling is introduced.
- A late response or matching change hook can confirm a command after timeout, even after a newer record snapshot has been applied. A later error cannot downgrade confirmed success. Timeout/disposal clears client timer handles without claiming to cancel a possible server commit. `acceptReceipt` checks session/actor/mutation/deal/stage/result version; `confirmChange` is ready for Stage 4's feed consumer.
- The Radix conflict dialog compares the original reviewed stage/version, captured latest confirmed stage/version, and intended stage. Cancel/Escape leaves saved data alone. Explicit resubmission uses a new mutation ID and exactly the reviewed version. A subsequent intervening edit conflicts again. Focus returns to the trigger, or the results heading if that trigger disappears.
- Undo is a new guarded command restoring the previous stage using the version produced by the original success. Parent/child linkage prevents repeated reversals and preserves the original successful result. Known newer versions hide Undo; unseen newer server versions reject it as a conflict. Retry/Check status controls that disappear return focus to the result; dismissal returns focus to Recent changes.
- UI history is bounded at 200 commands, with no silent eviction of recoverable/undoable work. New commands are rejected at capacity until explicit dismissal frees space. Pending/unconfirmed results and parents with unresolved children cannot be dismissed. Dismissal explicitly ends that result's recovery/Undo actions; authoritative session receipts follow their existing separate retention policy. Session expiry blocks new commands and offers reload.
- `PipelineProjection` caches derived rows, publishes only changed records, and adjusts view counters incrementally. Grid update-only transactions defer sort/filter recomputation, keep the affected row inspectable, and show Refresh list plus an honest displayed-count label. Results survive a row disappearing after refresh. Refresh restores the same row/cell if available or a nearby/search fallback. This is local-save groundwork for Stage 4, not live collaboration.
- Regression testing caught the interaction between deferred update transactions and time-based projection replacement. A new explicit/idle priority projection now recomputes external-filter membership, while ordinary incremental saves remain deferred.

### Closing checks

Environment: same macOS arm64 / Node 24.22.3 / npm 11.21.2 / Chrome toolchain recorded above. Added pinned Zustand **5.1.0** and Radix Dialog **1.3.1**. Test-browser server and Chrome run outside the restricted execution sandbox. No machine-wide tooling changes.

| Check | Actual result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed, no warnings |
| `npm test` | **73 tests passed across 9 files**; closing run reported 1.24 seconds |
| `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- --workers=2` | Build passed; **18 browser tests passed**, 34.9 seconds; all Stage 1/2 and tooltip regressions included |
| `PLAYWRIGHT_DEV=1 PLAYWRIGHT_CHANNEL=chrome npx playwright test tests/operations.spec.ts tests/tooltips.spec.ts --workers=2` | **7 passed**, 35.8 seconds; verifies the new workflows with development/Strict Mode lifecycle and tooltip diagnostics |
| `git diff --check` | Passed; new source files also checked directly |

The production entry chunk is approximately **1,168 kB minified / 339 kB gzip**, plus the existing simulator chunk. Vite's size warning remains visible and is not suppressed. Dependency installation reported seven moderate advisories as before; no blanket dependency fix was applied. The only test edit after the complete production run added screenshot capture; the development run subsequently exercised that test too. No claim of another complete production rerun is made for the screenshot-only test addition.

### Scenario evidence

Service/repository tests exercise T02–T07, T13, and lifecycle/history foundations: pending confirmed-data preservation, same-deal overlap prevention with other deals still usable, exact-ID/version Retry after a forced failure, stale Retry conflict after a competing write, post-commit lost response without a second write, unavailable receipt lookup and explicit recovery, unknown-receipt guarded retry, feed-before-response confirmation with a newer read-model version, timeout with a pending receipt and later success, same-stage no-op, successful Undo, Undo conflict after an unseen teammate write, repeated Undo prevention, captured conflict review with another intervening edit, bounded history/dismissal, and disposal/session expiry.

The projection regression checks affected-row-only notifications, current attention counters, stale-version rejection, stable initial grid-input identity, and unsubscription. These are correctness checks; they are not a replacement for later bulk/memory profiling.

Six new browser scenarios run against the real MSW HTTP handlers and 50,000-record repository:

1. Keyboard F2/Escape cancels without a write. A keyboard stage move retains the original confirmed label while delayed, blocks another edit of that deal, confirms without stealing grid focus, and supports keyboard Undo. A repository snapshot verifies version progression and unchanged customer activity.
2. A forced pre-commit failure leaves the stage unchanged. Keyboard Retry succeeds, and captured HTTP request bodies are identical across attempts. Focus remains meaningful after the retry button disappears and after keyboard dismissal.
3. A competing actor writes before the local save. The UI shows the conflict/latest stage; the labeled Radix dialog passes axe with zero violations, Escape restores focus, and explicit keyboard review submits a separate guarded change while retaining the original conflict result.
4. A response is lost after commit and the first reconciliation request is interrupted. The UI remains unconfirmed, preserves the confirmed stage, blocks Undo/dismissal, and resolves through keyboard Check status without a second write attempt.
5. A competing actor edits after local success. Undo conflicts, preserves the original success, applies the latest confirmed stage, and cannot be invoked repeatedly for the original move.
6. A moved row no longer matches its stage filter. It stays inspectable until Refresh list, then disappears with a zero matching count and search-focus fallback. The successful result remains available; Undo plus refresh makes the record match again.

The first workflow captures an ignored test screenshot of the two linked results, which was visually inspected. The full regression suite also retains the Stage 2 toolbar/grid axe check with zero violations, responsive overflow checks, and full-volume keyboard navigation. These checks do not claim complete screen-reader or all-zoom accessibility.

### Remaining scope

Stage 4 still owns simulated teammate activity, cursor polling/catch-up/resync, full live-update stability, and visible simulation controls/reset integration. Tests currently inject competing writes through the existing fake API and call the change-confirmation hook directly; this is not a live collaboration implementation. Stage 5 still owns exact selection snapshots, bounded bulk execution, and partial Retry/Undo. Full mixed-workload performance/memory profiling, comprehensive assistive-technology checks, clean-checkout bootstrap, and submission artifacts remain pending. Actual development time was not tracked reliably; no time-budget completion claim is made.

Primary references consulted: [AG Grid read-only editing](https://www.ag-grid.com/react-data-grid/value-setters/) and [Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog). Installed package types were used to verify the Zustand vanilla store, Community select-editor, and Radix APIs.

## Stage 4 — Simulated collaboration and controls

Closing date: **15 November 2026 (Asia/Kolkata)**. Checkpoints **4.1–4.3 implemented and verified**. Earlier sections are historical evidence. Source `plan.md` remains unchanged; no staging or commit was performed. The uncommitted earlier-stage changes remain in the working tree.

### Implementation boundaries

- `WorkspaceSession` owns one API client, confirmed model, operation service, and feed for a matching snapshot/session/cursor. Disposal aborts polling, removes operation-model subscriptions, clears timeout handles, and invalidates old client requests. Reset creates new owners/view/workflow state rather than reusing old callbacks or records. The retained session metadata avoids keeping an unnecessary second full initial snapshot.
- `ChangeFeed` has one current abortable request chain. It reads ordered pages, validates sequences/cursor progress, applies the complete page and matching operation confirmations, then advances the cursor. Up to five pages are drained before yielding through a scheduled continuation. Older/equal record versions remain ignored even when an event must still confirm its matching local mutation.
- Visibility/offline/focus handlers are registered and removed with the workspace lifecycle. Hidden/browser-offline pages stop data polling; reconnect/focus catches up. Simulated offline mode is coordinated by controls and detected through the local control-plane probe after transport failure. A wake may probe local settings while simulated offline, but does not poll deal data until reconnected.
- Requests that hang for ten seconds release/abort their current client lease and reconnect from the last applied cursor. Controller identity, abort, running/visibility/network, and API generation checks prevent cancelled/old-session replies from applying. Repeated starts/focus notifications coalesce rather than creating overlapping current poll chains.
- Expired cursors or sequence gaps trigger an explicit full snapshot resync into the same model. Snapshot loading does not invalidate outstanding same-session save responses. Existing command/editor versions are preserved; `onResync` defines an observer boundary for future selection code. Unconfirmed receipts are reconciled in groups of four read requests; no writes are automatically retried. A new session expires the old client instead of being silently merged.
- Background teammates use one cancellable scheduled producer, other seeded actor IDs, cached deal IDs, and the repository's guarded commit path. Delay and per-attempt failure semantics still apply. The next attempt is scheduled after completion, avoiding timer/write accumulation. User-specific forced save faults are not consumed by background actors. Defaults: off, 4,000 ms interval; validated range 500–30,000 ms.
- The Simulation dialog exposes save delay/failure percentage, teammate activity/interval, offline simulation, delivery pause, forced next failure/read failure/lost response, a focused-deal unseen edit, and seed/reset. The unseen-edit scenario pauses delivery and performs an immediate guarded teammate write for repeatability; it does not bypass version checks or mutate customer activity. Reset requires explicit confirmation and starts a fresh matching snapshot/cursor while clearing results, filters, and focused-deal state.
- The typed control client sends the loaded session ID with control writes. Server adapters reject late old-session settings/fault/conflict mutations; the local control plane still supports global diagnostic scripts without a session header and remains reachable during simulated offline mode.
- Live record values use incremental grid transactions without recomputing list ordering/filter membership. Company metadata is explicitly refreshed because an unchanged company value otherwise lets AG Grid skip its stale-membership label. Rows no longer matching the active criteria are visibly labeled. Header changes announce connection state; received-change counts, including own saves, do not use a per-event live announcement.
- The stage editor captures its displayed record before editing. Incoming updates to that row are deferred until commit/cancel, preserving its options and expected version. Escape drains the newer confirmed values without a write. Operation subscribers track only versions of deals represented in history so known newer records remove stale Undo actions without storing a competing full database.
- Refresh list reapplies membership/order, follows the same focused deal/cell if it still exists, and chooses a nearby/search fallback otherwise. The full-volume test verifies unchanged grid scroll offset before refresh and correct focus/visibility after the deal reorders. Selection-specific T16/T21 verification remains Stage 5 work.

### Closing results

Environment: Node **24.22.3**, npm **11.21.2**, macOS arm64, local Chrome, existing pinned AG Grid/Radix/Zustand versions. The test server and browser run outside the restricted execution sandbox. No new dependencies or machine-wide runtime changes were needed for this stage.

| Check | Actual result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with no warnings |
| `npm test` | **99 passed across 10 files**, closing run reported 1.52 seconds |
| `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e -- --workers=2` | Build passed; **26 browser tests passed**, 47.3 seconds, including all prior regression scenarios |
| `PLAYWRIGHT_DEV=1 PLAYWRIGHT_CHANNEL=chrome npx playwright test tests/collaboration.spec.ts tests/tooltips.spec.ts --workers=2` | **9 passed**, 26.4 seconds; development/Strict Mode and tooltip diagnostics included |
| `git diff --check` | Passed; new source/test files also inspected directly |

The closing production run additionally strengthened the early-confirmation test with a newer teammate version and captured a Simulation dialog screenshot; these test-only changes followed the passing development run. The final UI description clarifies that offline mode may interrupt current saves. No additional full-run claim is made for that copy-only clarification.

Unit/API evidence covers T04–T06/T20/T21 foundations: one current poll under repeated wake/start, page ordering before cursor commit, old-version receipt confirmation, sequence-gap/expired-cursor resync, captured-version preservation, hidden/offline pause/reconnect, paused-delivery cursor retention, failed-read recovery without full reload, failed confirmation-hook replay, session expiry through both feed and control-plane paths, old resync rejection, read timeouts and late response rejection, guarded old-session controls, same-generation resync with an outstanding write, read-only reconciliation of missed receipts, tracked-version Undo invalidation, and teammate cancellation/reset ownership.

### Browser evidence

Eight new production scenarios, with all original scenarios retained:

1. A teammate changes a filtered visible row. Its stage updates but its row identity, index, and focus stay stable; the no-longer-matching label is visible. Visibility events pause all new feed data reads, hidden-time writes stay unseen, and foreground catch-up applies them without a dataset reload. Refresh removes the nonmatch and gives a search-focus fallback.
2. Teammate updates arrive while a stage editor is open. The displayed option/version stays captured. Escape applies the deferred confirmed value without a save; a subsequent edit still submits its captured prior version and conflicts after another intervening change.
3. A committed user response is held and later fails. The matching feed event confirms success first. A subsequent teammate change advances the displayed version and removes stale Undo, and the late HTTP failure cannot downgrade success or regress the newer record. The repository snapshot confirms the expected two effective writes, not a duplicate retry.
4. Keyboard controls enable background teammates and configure a 500 ms interval/zero save delay. Received changes become visible without refetching the dataset. Offline simulation stops new feed data requests; reconnect resumes from the held cursor. The open dialog passes axe with **zero violations** and Escape restores its trigger. Development-mode load assertions account for Strict Mode's initial reads while still proving no new full-data loads during ordinary updates.
5. The unseen-edit preset targets the last actually focused grid deal, pauses delivery, and leads to an explicit conflict when the stale displayed stage is edited. The test waits for dialog close/focus restoration before reopening the editor.
6. Reset is requested during a delayed save. Cancel leaves history intact. Confirm clears the view/results/focus target, produces a new session, and restores all 50,000 seeded records. Advancing beyond the old save delay cannot reintroduce the old write; teammate settings reset to defaults.
7. A feed response explicitly requests resync while a stage editor is open. Exactly one additional snapshot is fetched, and the subsequent command still uses the originally captured version and conflicts. This is controlled expired-cursor fault injection in a browser; ring-buffer expiry itself is also covered by repository tests.
8. On the full dataset sorted by stage, End navigates to row 49,999. A teammate changes that record's sort value. The focused cell, row index, and actual grid scroll offset stay unchanged. Explicit refresh then reorders the same deal, keeps it focused, and brings it into view.

The Simulation screenshot was visually inspected for dialog hierarchy, readable controls, and internal vertical scrolling. The regression suite retains workspace axe and narrow-page overflow checks. Visibility is driven through browser-event fixtures; this does not claim real cross-tab backend sharing or a full assistive-technology audit.

### Remaining gates

Bulk selection/version capture, bounded execution, partial recovery/Undo, and selection-specific resync correctness remain Stage 5. Full mixed-workload performance/memory/long-task profiling, all-zoom/screen-reader review, clean-checkout bootstrap, and submission artifacts remain pending. Stage 2 timings remain historical initial baselines; no new statistical performance benchmark is claimed here.

The current production entry chunk is approximately **1,184 kB minified / 343 kB gzip**; the simulator chunk is approximately **412 kB minified / 158 kB gzip**. Vite's chunk warning remains visible and is not suppressed. Previously recorded development-toolchain advisories were not addressed by unrelated dependency upgrades. Actual stage development time was not tracked reliably; no six-hour completion claim is made.

Primary references checked: [AG Grid update-only transactions](https://www.ag-grid.com/react-data-grid/data-update-transactions/) and [editing lifecycle](https://www.ag-grid.com/react-data-grid/cell-editing-start-stop/). Installed types and browser behavior were used to verify focused-cell events, editor parameters, and row refresh APIs.
