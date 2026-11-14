# DealDesk development checkpoints

Source: [plan.md](./plan.md). Prepared: 14 November 2026.

This document turns the design into an ordered implementation backlog. `plan.md` remains the product and technical specification; its R/Q/D requirement IDs and T01–T24 verification scenarios are referenced below. Stage 1 is implemented; see `docs/validation.md` for verification evidence. Other stages remain pending, except for the foundation tooling needed by Stage 1.

The repository now contains the deterministic domain/data layer, guarded in-memory repository, adjustable MSW HTTP simulation, typed API client, a minimal pipeline summary, and Stage 1 verification tooling. The interactive workspace and workflows remain future work. Stage 0 is only partially addressed: its `npm start` bootstrap is still pending.

## How to use the checkpoints

Work through stages 0–7 in order and checkpoints in their listed order. Each checkpoint should leave a reviewable result; a suggested commit message is provided. Create modules when needed rather than creating the whole target folder structure up front.

- Mark a task complete only after implementing and checking it.
- Complete a checkpoint only when its acceptance checks pass. Record commands, outcomes, manual observations, and actual time spent in `docs/validation.md`.
- Build keyboard access, loading/error states, and relevant tests with each workflow. Stage 6 verifies them across the application.
- A suggested commit is a development boundary, not an instruction to commit automatically.
- Checked tasks are implemented and verified as recorded in `docs/validation.md`. Unchecked tasks and their commands remain future work.

## Stage overview

| Stage | Checkpoints | Working result | Depends on |
| --- | --- | --- | --- |
| 0. Foundation | 0.1–0.3 | App starts reliably; quality checks and test tools are available | Existing starter |
| 1. Domain and fake API — implemented | 1.1–1.3 | Repeatable 50,000-deal dataset and guarded simulated saves | Stage 0 |
| 2. Readable workspace | 2.1–2.3 | Searchable, filterable, keyboard-accessible sales table | Stage 1 |
| 3. Single-deal workflow | 3.1–3.3 | One deal can be moved, retried, reviewed, reconciled, and undone | Stage 2 |
| 4. Collaboration | 4.1–4.3 | Teammate updates arrive without disrupting active work | Stage 3 |
| 5. Bulk workflow | 5.1–5.3 | Exact selection, bounded processing, and partial recovery at scale | Stage 4 |
| 6. Full verification | 6.1–6.3 | Integrated correctness, accessibility, and measured performance | Stage 5 |
| 7. Submission | 7.1–7.3 | Accurate documentation, recording, and reproducible handoff | Stage 6 |

## Stage 0 — Foundation

### 0.1 — Check the starter and establish application boundaries

- [x] Inspect the current starter, TypeScript settings, and lint configuration; preserve useful setup.
- [ ] Confirm a supported Node/npm combination and compatible versions of the planned libraries against their official documentation; record the chosen Node version and commit-compatible lockfile changes during implementation.
- [x] Replace the starter screen with a minimal DealDesk shell and base styles.
- [ ] Establish `src/app` for application composition; add other folders only as their features appear.
- [x] Create `docs/validation.md` with fields for checkpoint, revision, environment, command/scenario, actual result, limitations, and time spent.

**Acceptance:** The minimal app renders through `npm run dev`; the existing build and lint checks pass. No starter UI remains in the visible product.

**Suggested commit:** `chore: establish DealDesk application foundation`

### 0.2 — Establish meaningful automated checks

- [x] Set up Vitest with deterministic fixture/clock helpers.
- [ ] Set up Playwright and axe integration; document test-browser installation separately from app startup.
- [x] Expose `typecheck`, `test`, and `test:e2e` alongside `dev`, `build`, `preview`, and `lint`.
- [x] Add one meaningful domain test, such as same-stage move classification, and a browser smoke check for the shell.

**Acceptance:** Typecheck, lint, build, the initial domain test, and the browser smoke check pass. App startup does not require Playwright browsers.

**Suggested commit:** `test: establish domain and browser verification`

### 0.3 — Deliver one-command startup

- [ ] Implement `scripts/start.mjs` and `npm start`: install locked dependencies when needed, then launch Vite.
- [ ] Handle failed installation, child-process errors, and shutdown signals; avoid reinstalling unchanged dependencies on ordinary runs.
- [ ] Document Node prerequisites and the network requirement for first installation.

**Acceptance:** In an isolated fresh copy without `node_modules`, `npm start` installs and launches successfully. A repeat run avoids unnecessary installation, and stopping the command stops the server. Record this first startup check; repeat the final fresh-checkout check in 7.2.

**Coverage:** Initial T24 evidence; supports D1/Q5.

**Suggested commit:** `build: add one-command project startup`

## Stage 1 — Domain and fake API

### 1.1 — Model deals and generate repeatable data

- [x] Define deal, owner, stage, command, receipt, and typed error contracts in `src/domain` and `src/api` as needed.
- [x] Generate exactly 50,000 stable unique deals across 20 owners and seven stages; use the proposed distribution in `plan.md`.
- [x] Store money as integer paise and timestamps consistently; inject a seeded random source and clock.
- [x] Include nullable activity dates, neglected deals, and closed deals for later attention scenarios.
- [x] Return independent snapshots; prevent consumers from modifying authoritative saved records.

**Acceptance:** T01 passes. Seeded runs repeat exactly, all field constraints hold, and mutating a returned snapshot cannot change repository state.

**Suggested commit:** `feat: add deal model and deterministic dataset`

### 1.2 — Implement the authoritative guarded write path

- [x] Build the in-memory repository and validate stage changes, expected versions, actor IDs, and mutation IDs.
- [x] Implement same-stage no-ops, pre-commit failures, and atomic version-check/commit/receipt/change-event creation without an intervening await.
- [x] Deduplicate matching committed and in-flight mutation IDs; reject reuse with a different payload.
- [x] Keep transient pre-commit failures retryable with the original mutation ID.
- [x] Define bounded receipt/change-log retention and expiry behavior. Protect receipts needed by unresolved or still-undoable operations; expose expiry explicitly rather than silently losing recovery.

**Acceptance:** T02, T03, T04, and T07 pass at repository level. Competing clients cannot both commit against the same version. Stage changes do not modify customer activity dates.

**Suggested commit:** `feat: implement versioned deal saves and mutation receipts`

### 1.3 — Expose the fake HTTP API and fault controls

- [x] Add the typed HTTP client and MSW handlers for initial snapshot/cursor, single moves, bounded bulk moves, operation reconciliation, and ordered changes.
- [x] Await MSW startup before application requests in development and built preview; show a recoverable startup error if initialization fails.
- [x] Implement configurable 300–1,500 ms save delay and approximately 10% per-item pre-commit failure defaults.
- [x] Add controlled initial-read failure, lost response after commit, offline behavior, and reset/session-generation primitives. A bulk transport failure must remain distinct from individual failures.
- [x] Generate `public/mockServiceWorker.js`; document simulation semantics and validate settings ranges.

**Acceptance:** T02–T04 and T07 pass through actual request handlers. Add API-level T06 for lost-response reconciliation and initial T19/T20 checks for preview startup and invalidated sessions. Every bulk item has a result when the request completes normally.

**Suggested commit:** `feat: expose simulated API and repeatable faults`

## Stage 2 — Readable workspace

### 2.1 — Load confirmed data into a virtualized table

- [ ] Build the confirmed client read model keyed by deal ID; accept newer record versions and ignore older/equal snapshots.
- [ ] Render AG Grid Community with stable IDs, lightweight columns, a bounded viewport, and row/column virtualization.
- [ ] Show company, value, owner, stage, customer activity, attention reason, and operation status columns.
- [ ] Implement loading, failed-load with Retry, and empty states; show total and matching counts.

**Acceptance:** All 50,000 records load through HTTP. Scrolling mounts a bounded set of rows, and a failed initial load can recover. Add T05 read-model checks and T19 browser coverage.

**Suggested commit:** `feat: render the full sales pipeline workspace`

### 2.2 — Add views, filters, and explainable prioritization

- [ ] Add All deals, My deals, and Needs attention using a fixed demo salesperson.
- [ ] Add company search, owner/stage filters, clear filters, and visible active criteria; start with about 200 ms search debounce.
- [ ] Share filter predicates between workspace membership and future all-matching selection.
- [ ] Implement the specified age/activity/negotiation attention rules, excluding Won/Lost; use `createdAt` when activity is absent.
- [ ] Order attention deterministically by urgency, activity baseline, value descending, then ID. Explain the rules in the UI and support periodic time-based reevaluation.

**Acceptance:** T18 passes with fixed dates, including exact threshold boundaries. Counts and membership agree for combined filters, and saved stage changes do not invent customer activity.

**Suggested commit:** `feat: add pipeline filters and attention views`

### 2.3 — Establish usable keyboard and table behavior

- [ ] Verify documented grid navigation, visible focus, Tab order, and movement to initially off-screen rows.
- [ ] Label toolbar controls and provide readable INR/date formatting and text alongside state colors.
- [ ] Establish stable columns/callbacks and focused state subscriptions; record an initial full-data interaction baseline.

**Acceptance:** A keyboard user can enter the workspace, change filters, navigate off-screen rows, and leave the grid predictably. Begin T17/T22/T23 evidence; later stages extend it to editing and dialogs.

**Suggested commit:** `feat: establish keyboard-accessible pipeline navigation`

## Stage 3 — Single-deal workflow

### 3.1 — Move one deal with honest save feedback

- [ ] Add the operation service/store and explicit item states: queued, saving, succeeded, failed, conflicted, unconfirmed, skipped.
- [ ] Capture the displayed version, previous stage, actor, target stage, and stable mutation ID when issuing a command.
- [ ] Add a keyboard-accessible stage editor; retain the confirmed stage while showing “Moving to …”.
- [ ] Block overlapping local writes to an unresolved deal while allowing work on others.
- [ ] Add a persistent results panel with inspectable outcomes, not toast-only feedback.

**Acceptance:** T02/T03 browser checks pass. A save changes the displayed confirmed value only after confirmation; definite failures remain visible and unrelated rows remain usable.

**Suggested commit:** `feat: add single-deal stage changes and save results`

### 3.2 — Recover failures, conflicts, and uncertain outcomes

- [ ] Retry definite failures using the original mutation ID and expected version.
- [ ] Add a labeled Radix conflict dialog showing the latest saved record; explicit reviewed resubmission creates a new command.
- [ ] Reconcile interrupted/time-out outcomes through the operation endpoint; distinguish unresolved from definitively failed work.
- [ ] Prevent late errors from downgrading confirmed success; retain a hook for matching change-event confirmation in stage 4.
- [ ] Restore focus on dialog close and announce concise results.

**Acceptance:** T03–T07 relevant single-move paths pass. A committed save whose response is lost reconciles without a duplicate write even when change delivery is unavailable. Retry never silently adopts a newer expected version.

**Suggested commit:** `feat: add retry conflict review and save reconciliation`

### 3.3 — Add guarded single-deal Undo

- [ ] Undo with a new mutation ID and the version produced by the original success; restore its previous stage only if the guard passes.
- [ ] Link Undo to its original operation and prevent repeated reversal of unrelated newer work.
- [ ] Reconcile unconfirmed work before offering Undo; apply the retention/expiry policy to visible history and action eligibility.

**Acceptance:** T13 passes for eligible Undo, teammate edits after success, and repeated invocation. The entire single-deal success/failure/Retry/conflict/Undo workflow works by keyboard.

**Suggested commit:** `feat: add guarded undo for individual stage changes`

## Stage 4 — Collaboration

### 4.1 — Receive versioned teammate changes

- [ ] Simulate other seeded actors through the same guarded repository write path.
- [ ] Add one-in-flight feed polling, initially about once per second while visible; pause offline/hidden and catch up on reconnect/focus.
- [ ] Apply ordered feed pages before advancing the cursor; continue when more pages exist. Reconcile expired cursors through a fresh snapshot.
- [ ] Match mutation receipts/events to local operations even if a newer record version is already displayed; do not downgrade confirmed success on a late transport error.

**Acceptance:** T04–T06 and T21 pass for competing writes, out-of-order arrivals, feed-before-response confirmation, reconnect, and expired-cursor resync. Normal updates do not refetch all 50,000 deals.

**Suggested commit:** `feat: simulate teammates and consume versioned changes`

### 4.2 — Preserve the user's working position

- [ ] Apply changed values by stable ID while deferring disruptive sort/filter membership recomputation during active work.
- [ ] Show update indicators and labels for displayed rows that no longer match filters.
- [ ] Add explicit Refresh list; preserve focus/scroll where possible and announce a sensible fallback if the active row disappears.
- [ ] Define selection-preservation hooks for stage 5: resync/refresh must never overwrite previously reviewed versions.

**Acceptance:** T16 passes with editing, scrolling, and filters active. Pending records stay inspectable. Complete the selection-specific T16/T21 cases in stage 5.

**Suggested commit:** `feat: preserve active views during teammate updates`

### 4.3 — Finish simulation controls and lifecycle cleanup

- [ ] Expose validated delay/failure settings, teammate activity/frequency, offline mode, and repeatable failure/conflict/lost-response controls.
- [ ] Add warned seed/reset behavior and clear connection/update status in the header.
- [ ] On reset, cancel scheduled work, invalidate old requests, clear operations/view state, and reload a matching snapshot/cursor.
- [ ] Verify unmount/development lifecycle cleanup avoids duplicate timers and feed loops.

**Acceptance:** T19–T21 relevant preview, reset, and lifecycle scenarios pass. Every control is keyboard accessible. Late old-session responses cannot affect the new session.

**Suggested commit:** `feat: add simulation controls and safe session reset`

## Stage 5 — Bulk workflow

### 5.1 — Capture exact selection and review a bulk command

- [ ] Store selected IDs and reviewed versions independently of mounted grid rows; retain them across scrolling, sorting, value updates, refresh, and resync.
- [ ] Select all matching from the latest confirmed read model using shared predicates; reconcile/explain stale displayed membership first.
- [ ] Freeze membership: newly matching rows do not join, and changed selected records retain original versions with review indicators.
- [ ] Clear and announce selection on search/owner/stage/view changes, while preserving it on sorting.
- [ ] Add the selection bar and bulk review dialog with exact count, source criteria, target stage, relevant total value, changed items, pending items, and no-ops.
- [ ] Capture commands at review time; cancel performs no writes, and confirmation submits exactly that snapshot.

**Acceptance:** T08–T10 and selection-specific T16/T21 pass. Thousands of off-screen matches are included correctly; subsequent filters or teammate changes cannot silently change a submitted operation's membership or versions.

**Suggested commit:** `feat: add versioned bulk selection and review`

### 5.2 — Execute bulk work with bounded concurrency

- [ ] Start with batches of 200 and no more than four requests in flight; preserve per-item mutation IDs across retries/re-batching.
- [ ] Yield scheduling/render work and batch progress updates so keyboard navigation and typing remain usable.
- [ ] Show queued/saving/succeeded/failed/conflicted/unconfirmed/skipped counts and inspectable completed results during execution.
- [ ] Skip/report ineligible pending and no-op entries explicitly. Keep submitted membership independent of subsequent UI selection changes.
- [ ] Distinguish per-item errors from whole-request uncertainty and stop launching new batches offline.

**Acceptance:** T08/T11/T15 pass, with scheduler tests proving bounded concurrency and complete item accounting. Every original selected item belongs to exactly one current result state; no duplicate effective commits occur. Record an initial full-volume bulk measurement.

**Suggested commit:** `feat: process bulk stage changes with bounded concurrency`

### 5.3 — Recover partial bulk operations

- [ ] Retry eligible failed items only, reconcile unconfirmed items, and route conflicts through explicit review without rebasing silently.
- [ ] Add guarded bulk Undo for eligible successes; preserve the original operation and per-attempt/reversal results.
- [ ] Require explicit resume/reconciliation after reconnection; returning online must not silently launch queued mass changes.
- [ ] Preserve known outcomes across interruptions; bound history without discarding details needed for active or recoverable work.

**Acceptance:** T06/T09/T11–T15 pass together with teammate activity enabled. Mixed success/failure/conflict/no-op fixtures reconcile exactly; partial Retry and Undo retain earlier successes and expose unresolved items. A success-only bulk demo does not pass this gate.

**Suggested commit:** `feat: recover partial bulk changes and support guarded undo`

## Stage 6 — Full verification

### 6.1 — Verify integrated correctness and recovery

- [ ] Run deterministic repository, HTTP, operation, selection, and scheduler checks plus cross-flow browser scenarios.
- [ ] Exercise success, pre-commit failure, same-version competition, duplicate mutations, lost responses with delayed feed, partial bulk results, offline/resume, expired cursors, and reset during active work.
- [ ] Verify all result counters, Retry/Undo eligibility, reviewed versions, and selected membership after each scenario.
- [ ] Fix requirement gaps and retain meaningful regression coverage.

**Acceptance:** T01–T16 and T18–T21 have passing evidence at their applicable levels. No failed or unconfirmed write appears successful; no retry or resync silently adopts a new reviewed version.

**Suggested commit:** `test: verify integrated saves collaboration and recovery`

### 6.2 — Verify complete keyboard and accessibility flows

- [ ] Complete keyboard-only search/filter, off-screen navigation, selection, stage editing, bulk review/cancel/confirm, Retry, conflict review, Undo, and simulation flows.
- [ ] Check Escape/cancel behavior, visible focus, dialog focus restoration, selection announcements, and concise operation summaries.
- [ ] Run axe and manually inspect labels, contrast, non-color status cues, zoom, overflow, and loading/error/empty states.
- [ ] Perform and record screen-reader checks, including observed grid virtualization limitations; record anything not checked explicitly.

**Acceptance:** T17/T23 pass for essential actions. Document actual manual coverage and limitations; automated axe results alone do not close the checkpoint.

**Suggested commit:** `fix: resolve verified keyboard and accessibility gaps`

### 6.3 — Measure full-volume performance

- [ ] Profile the production build with all 50,000 deals, large filtered stages, thousands of selected records, teammate activity, and mixed-outcome bulk changes.
- [ ] Record machine/browser/build conditions, loading time, filter/search response, scrolling, long tasks, bulk throughput, interaction during saves, and memory across repeated operations.
- [ ] Verify bounded rendering/history and cleanup; tune observed bottlenecks rather than assuming virtualization solves all CPU/memory costs.
- [ ] Record numerical measurements and observable usability criteria. Add a worker only if a measured application calculation justifies it.

**Acceptance:** T22 passes with recorded evidence and usable input under load. Typecheck, lint, relevant automated tests, and production build pass after any fixes. Recheck affected workflows after performance changes.

**Suggested commit:** `perf: validate full-volume pipeline interactions`

## Stage 7 — Submission

### 7.1 — Write accurate project documentation

- [ ] Replace the template README with purpose, Node prerequisites, exact startup/check commands, simulator controls/defaults, architecture, reset semantics, and limitations.
- [ ] Write `docs/write-up.md`, kept to 1–2 rendered pages: what/why, UX alternatives, unreliable saves, teammate changes, performance, improvements, and actual time spent.
- [ ] Complete `docs/validation.md` with actual results and measurements, distinguishing passing, failed, and untested scenarios.
- [ ] Remove dependence on local PDF paths from submission instructions. Explain the one-page table, confirmed-save feedback, stable view, captured selection, and guarded Retry/Undo decisions.

**Acceptance:** A reader can run and assess the app from repository documentation. Every material claim matches implemented behavior and recorded evidence; omissions are explicit.

**Suggested commit:** `docs: document DealDesk setup decisions and validation`

### 7.2 — Verify a fresh checkout and built demo

- [ ] Run the documented `npm start` from a clean checkout with the supported Node version and no installed dependencies.
- [ ] Check all documented commands, including separate Playwright browser installation instructions.
- [ ] Verify the production preview includes MSW and working simulation controls, with recoverable startup/load failures.
- [ ] Audit tracked contents for required source, lockfile, worker, and documentation; exclude generated dependencies/build output and unrelated local files.

**Acceptance:** T19/T24 pass on the submission candidate. Record the tested revision and environment; resolve discrepancies between README and actual behavior.

**Suggested commit:** `chore: verify clean-checkout submission readiness`

### 7.3 — Prepare the demonstration and close the requirements audit

- [ ] Write `docs/demo-script.md` for a repeatable 2–3 minute demonstration using controlled simulator scenarios.
- [ ] Show the full dataset/attention view, keyboard single move, failed save/Retry, bulk review/mixed results, teammate conflict/stable view, guarded Undo, and a relevant limitation.
- [ ] Record the working submission revision and include the recording artifact or accessible link.
- [ ] Map R1–R7, Q1–Q5, and D1 to implemented behavior and evidence; review the final checklist in `plan.md`.
- [ ] Prepare the repository and submission links; publish/share them only as authorized. Keep claims consistent with the delivered revision.

**Acceptance:** Repository, 1–2 page write-up, 2–3 minute recording, and validation evidence are available. All required behavior is supported by evidence; outstanding limitations are stated honestly. Do not mark the app complete while required checks or artifacts remain missing.

**Suggested commit:** `docs: finalize demonstration and submission artifacts`

## Verification coverage index

Use this index to find the checkpoints that establish and finish each scenario. The scenario definitions remain in section 13 of `plan.md`.

| Scenarios | Main checkpoints |
| --- | --- |
| T01 — dataset | 1.1, 6.1 |
| T02–T04 — writes, failures, competing clients | 1.2–1.3, 3.1–3.2, 4.1, 6.1 |
| T05–T07 — stale arrivals, lost responses, idempotency | 1.2–1.3, 2.1, 3.2, 4.1, 5.3, 6.1 |
| T08–T10 — exact selection and reviewed versions | 5.1–5.3, 6.1 |
| T11–T12 — mixed bulk outcomes and Retry | 5.2–5.3, 6.1 |
| T13–T14 — single/bulk Undo | 3.3, 5.3, 6.1 |
| T15 — offline interruption and explicit resume | 5.2–5.3, 6.1 |
| T16 — stable focus, selection, scroll, refresh | 4.2, 5.1, 6.1 |
| T17 — keyboard workflows | 2.3, stage 3, 5.1–5.3, 6.2 |
| T18 — attention rules and customer activity | 1.2, 2.2, 6.1 |
| T19–T21 — preview, cleanup, feed recovery | 1.3, 2.1, 4.1–4.3, 5.1, 6.1, 7.2 |
| T22 — full-volume performance | 2.3, 5.2, 6.3 |
| T23 — accessibility | 2.3, 6.2 |
| T24 — clean startup and accurate commands | 0.3, 7.2 |

## Scope and stopping rules

The first useful read-only milestone is stage 2. The first complete single-deal workflow is stage 3. Stage 5 completes the main product workflows; stages 6–7 establish evidence and deliverables. These milestones are intermediate results, not substitutes for the full assignment.

The source brief recommends roughly six hours, while this expanded plan includes additional implementation and verification work. Track actual time; do not promise the full expanded scope fits that recommendation. If a time constraint is introduced, remove optional work first and document any remaining required gaps.

Keep login, a real backend, extra pages, a second board layout, AI scoring, integrations, charts, decorative animation, reload persistence, and real cross-tab collaboration out of this backlog. Do not add workers without a measured need. During final verification, add product behavior only to close a requirement gap.
