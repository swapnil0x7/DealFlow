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
