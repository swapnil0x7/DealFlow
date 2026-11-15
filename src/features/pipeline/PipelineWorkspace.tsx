import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { STAGES, STAGE_LABELS, isStage } from "../../domain/deal";
import {
  CURRENT_OWNER_ID,
  DEFAULT_FILTERS,
  normalizeSearch,
} from "../../domain/filters";
import type { PipelineFilters, WorkView } from "../../domain/filters";
import { formatCount } from "../../shared/format";
import type { WorkspaceSession } from "../collaboration/session";
import { ConnectionStatus } from "../collaboration/ConnectionStatus";
import { SimulationPanel } from "../collaboration/SimulationPanel";
import { PipelineTable } from "./PipelineTable";
import { PipelineProjection } from "./projection";
import { ResultsPanel } from "../operations/ResultsPanel";
import styles from "./Pipeline.module.css";

const VIEWS: { id: WorkView; label: string }[] = [
  { id: "all", label: "All deals" },
  { id: "mine", label: "My deals" },
  { id: "attention", label: "Needs attention" },
];

export function PipelineWorkspace({ session, onReset }: { session: WorkspaceSession; onReset: (seed: number) => void }) {
  const { model, operations, feed } = session;
  const owners = session.snapshot.owners;
  const [activeDealId, setActiveDealId] = useState<string | null>(null);
  useEffect(() => {
    const visibility = () => feed.setVisible(!document.hidden);
    const online = () => { feed.setNetworkOnline(navigator.onLine); };
    const focus = () => feed.wake();
    visibility();
    online();
    const stop = feed.start();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('online', online);
    window.addEventListener('offline', online);
    window.addEventListener('focus', focus);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', online);
      window.removeEventListener('focus', focus);
      stop();
    };
  }, [feed]);
  const [filters, setFilters] = useState<PipelineFilters>(DEFAULT_FILTERS);
  const [search, setSearch] = useState("");
  const [asOf, setAsOf] = useState(Date.now);
  const [priorityRefreshPending, setPriorityRefreshPending] = useState(false);
  const [listStale, setListStale] = useState(false);
  const [matching, setMatching] = useState(model.size);
  const [sortDescription, setSortDescription] = useState("Company ascending");
  const workspaceRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const projection = useMemo(
    () => new PipelineProjection(model.all(), owners, asOf),
    [model, owners, asOf],
  );
  const counts = useSyncExternalStore(
    projection.subscribeCounts,
    projection.getCounts,
  );
  useEffect(
    () => model.subscribe((records) => projection.apply(records)),
    [model, projection],
  );
  const currentOwner = owners.find((owner) => owner.id === CURRENT_OWNER_ID);
  const searching = normalizeSearch(search) !== filters.search;
  const hasFilters = Boolean(search || filters.ownerId || filters.stage);
  const activeView = VIEWS.find((view) => view.id === filters.view)!;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const value = normalizeSearch(search);
      setFilters((current) =>
        current.search === value ? current : { ...current, search: value },
      );
    }, 200);
    return () => window.clearTimeout(timer);
  }, [search]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      // Avoid reordering time-sensitive priorities while the salesperson is using the workspace.
      if (
        document.hidden ||
        workspaceRef.current?.contains(document.activeElement)
      )
        setPriorityRefreshPending(true);
      else {
        setAsOf(Date.now());
        setPriorityRefreshPending(false);
      }
    }, 60_000);
    return () => window.clearInterval(timer);
  }, []);

  function clearFilters() {
    setSearch("");
    setFilters((current) => ({ ...DEFAULT_FILTERS, view: current.view }));
  }

  return (
    <div ref={workspaceRef} className={styles.workspace}>
      <a className={styles.skipLink} href="#pipeline-workspace">
        Skip to pipeline
      </a>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            D
          </span>
          <span>
            DealDesk
            <span className={styles.brandSubtitle}>Sales workspace</span>
          </span>
        </div>
        <div className={styles.headerControls}>
          <ConnectionStatus feed={feed} />
          <SimulationPanel session={session} activeDealId={activeDealId} onReset={onReset} />
        <div className={styles.identity}>
          <span className={styles.avatar} aria-hidden="true">
            AS
          </span>
          <span>
            {currentOwner?.name ?? "Your workspace"}
            <small>My workspace</small>
          </span>
        </div>
        </div>
      </header>
      <main id="pipeline-workspace" className={styles.main} tabIndex={-1}>
        <div className={styles.titleRow}>
          <div>
            <p className={styles.eyebrow}>Your daily sales desk</p>
            <h1>Sales pipeline</h1>
            <p className={styles.subtitle}>
              Find the deals that need you. Keep every opportunity in view.
            </p>
          </div>
          <div className={styles.totals} aria-label="Pipeline summary">
            <strong>
              {formatCount(model.size)}
              <span>total deals</span>
            </strong>
            <strong>
              {owners.length}
              <span>salespeople</span>
            </strong>
          </div>
        </div>

        <section className={styles.panel} aria-label="Pipeline workspace">
          <div className={styles.views} role="group" aria-label="Work views">
            {VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                aria-pressed={filters.view === view.id}
                onClick={() =>
                  setFilters((current) => ({ ...current, view: view.id }))
                }
              >
                {view.label}
                <span>{formatCount(counts[view.id])}</span>
              </button>
            ))}
          </div>
          <div
            className={styles.toolbar}
            role="search"
            aria-label="Filter deals"
          >
            <label className={styles.search}>
              <span>Search company</span>
              <input
                ref={searchRef}
                id="company-search"
                type="search"
                value={search}
                placeholder="Search by company name…"
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label>
              <span>Owner</span>
              <select
                value={filters.ownerId}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    ownerId: event.target.value,
                  }))
                }
              >
                <option value="">All owners</option>
                {owners.map((owner) => (
                  <option key={owner.id} value={owner.id}>
                    {owner.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Stage</span>
              <select
                value={filters.stage}
                onChange={(event) => {
                  const stage = event.target.value;
                  if (stage === "" || isStage(stage))
                    setFilters((current) => ({ ...current, stage }));
                }}
              >
                <option value="">All stages</option>
                {STAGES.map((stage) => (
                  <option key={stage} value={stage}>
                    {STAGE_LABELS[stage]}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className={styles.clear}
              disabled={!hasFilters}
              onClick={clearFilters}
            >
              Clear filters
            </button>
          </div>
          <div className={styles.listSummary}>
            <p
              role="status"
              aria-live="polite"
              aria-atomic="true"
              data-testid="matching-count"
            >
              {searching ? (
                "Searching…"
              ) : (
                <>
                  <strong>{formatCount(matching)}</strong>{" "}
                  {listStale ? "displayed deals" : "matching deals"}
                </>
              )}
              <span> · {activeView.label}</span>
            </p>
            <details className={styles.rules}>
              <summary>How attention works</summary>
              <div className={styles.rulesContent}>
                <strong>Clear reasons. No hidden scores.</strong>
                <p>
                  New leads wait at least 2 days. Open deals have no customer
                  activity for at least 7 days. Negotiations inactive for 14
                  days receive highest urgency. Won and Lost deals are excluded.
                </p>
                <p>
                  We use whole elapsed days and the creation date when activity
                  is missing. New leads rank above general inactivity. Ties use
                  oldest activity, highest value, then deal ID.
                </p>
                <p>
                  Needs attention starts sorted by priority. You can change the
                  sort using column headers. Priorities refresh every minute
                  when you aren’t working here.
                </p>
              </div>
            </details>
          </div>
          {priorityRefreshPending && (
            <div className={styles.refreshNotice} role="status">
              Time-based priorities may have changed.
              <button
                type="button"
                onClick={() => {
                  setAsOf(Date.now());
                  setPriorityRefreshPending(false);
                  searchRef.current?.focus();
                }}
              >
                Refresh priorities
              </button>
            </div>
          )}
          <PipelineTable
            projection={projection}
            onActiveDealChange={setActiveDealId}
            operations={operations}
            filters={filters}
            listStale={listStale}
            onCountChange={setMatching}
            onSortChange={setSortDescription}
            onStaleChange={setListStale}
          />
          <footer className={styles.footer}>
            <p id="pipeline-keyboard-help">
              Arrows navigate · Enter/F2 edits stage · Escape cancels · End for
              last row
            </p>
            <a href="#company-search">Back to filters</a>
            <p>
              Sorted by <strong>{sortDescription}</strong>
            </p>
          </footer>
        </section>
        <ResultsPanel service={operations} model={model} />
        <p className={styles.footnote}>
          Customer activity dates stay independent of stage changes.
        </p>
      </main>
    </div>
  );
}
