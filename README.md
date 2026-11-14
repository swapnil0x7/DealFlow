# DealDesk

A one-screen sales workspace for finding deals that need attention and changing stages safely. The design targets 50,000 deals and 20 salespeople.

**Current implementation: Stage 1 — domain and fake API.** The browser shows a pipeline summary loaded through the simulated HTTP API. The interactive grid, stage editor, collaboration UI, and bulk workflow belong to later stages. See [the development checkpoints](./IMPLEMENTATION_PLAN.md) and [the source design](./plan.md).

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

The Stage 0 `npm start` bootstrap has not been implemented; use the commands above for this stage.

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

If Google Chrome is already installed, macOS/Linux can use `PLAYWRIGHT_CHANNEL=chrome npm run test:e2e` instead. Browser installation is separate from running the app. Browser tests use port 4173 and require it to be available. See [validation notes](./docs/validation.md) for actual results and environment details.

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

The salesperson-facing simulation panel is scheduled for Stage 4. The adjustable API is available now; examples can run in the browser console.

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
| `POST /api/simulation/reset` | `{ seed: 42 }`; discards all current in-memory work |

Data writes, operation lookups, and feed reads require `X-DealDesk-Session` from the latest snapshot. Move bodies require `stage`, `expectedVersion`, `mutationId`, and a valid seeded `actorId`; bulk items also require `dealId`. The typed client carries these contracts and guards late responses after a local reset.

Default saves wait 300–1,500 ms and independently fail before commit with probability 0.1 per attempted deal. Each batch item uses its own delay/failure draw. Reads have a lightweight 20 ms delay and only fail under explicit faults/offline mode. A fixed seed and clock make fixtures deterministic; the running demo uses actual time. Delay changes affect new attempts; offline mode is checked again before commit.

Settings accept integer delay bounds from 0–30,000 ms, minimum ≤ maximum, `failureRate` from 0–1, and boolean `offline`. Unknown settings are rejected atomically. Offline mode blocks reads, writes, and change delivery; local control endpoints remain reachable so the demo can reconnect/reset. Faults apply to the next eligible attempt. A lost-response fault drops the response after committing, leaving its receipt available.

Reset cancels timers, invalidates the old repository, changes the session ID, clears faults/settings/history, and regenerates data from the requested unsigned 32-bit seed. Late work cannot mutate the new repository. Full client workflow-store cleanup will be integrated when those stores are introduced.

## Current limits

This stage verifies API consistency and recovery primitives. It does not yet implement grid selection, the results panel, Retry/Undo controls, attention views, teammate polling, accessibility across those workflows, or full interaction-performance profiling. No browser reload persistence, real backend, authentication, or cross-tab collaboration is included. The full assignment's clean-checkout bootstrap and submission recording remain future work.
