import { createStore } from "zustand/vanilla";
import { attentionFor } from "../../domain/attention";
import type { Deal, Owner } from "../../domain/deal";
import { STAGE_LABELS } from "../../domain/deal";
import { matchesFilters } from "../../domain/filters";
import type { PipelineFilters } from "../../domain/filters";
import type { ConfirmedReadModel } from "../collaboration/read-model";

interface SelectionState {
  count: number;
  changed: number;
  totalValuePaise: number;
  source: PipelineFilters | null;
  revision: number;
  notice: string;
}

export function describeCriteria(
  filters: PipelineFilters,
  owners: readonly Owner[],
): string {
  return [
    filters.view === "mine"
      ? "My deals"
      : filters.view === "attention"
        ? "Needs attention"
        : "All deals",
    filters.search && `company contains “${filters.search}”`,
    filters.ownerId &&
      `owner: ${owners.find((owner) => owner.id === filters.ownerId)?.name ?? filters.ownerId}`,
    filters.stage && `stage: ${STAGE_LABELS[filters.stage]}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Original immutable reviewed records, independent of grid mounting, sorting, refresh, and resync. */
export class SelectionService {
  readonly store = createStore<SelectionState>(() => ({
    count: 0,
    changed: 0,
    totalValuePaise: 0,
    source: null,
    revision: 0,
    notice: "",
  }));
  private selected = new Map<string, Deal>();
  private readonly changed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private readonly model: ConfirmedReadModel;

  constructor(model: ConfirmedReadModel) {
    this.model = model;
    this.unsubscribe = model.subscribe((records) => {
      let changed = false;
      records.forEach((record) => {
        const reviewed = this.selected.get(record.id);
        if (
          reviewed &&
          record.version !== reviewed.version &&
          !this.changed.has(record.id)
        ) {
          this.changed.add(record.id);
          changed = true;
        }
      });
      if (changed) this.store.setState({ changed: this.changed.size });
    });
  }

  records(): readonly Deal[] {
    return Array.from(this.selected.values());
  }
  has(id: string): boolean {
    return this.selected.has(id);
  }
  isChanged(id: string): boolean {
    return this.changed.has(id);
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  /** Grid reports membership only. Existing members keep their originally reviewed versions. */
  setMembership(records: readonly Deal[], source: PipelineFilters): void {
    const next = new Map(
      records.map((record) => [
        record.id,
        this.selected.get(record.id) ?? Object.freeze({ ...record }),
      ]),
    );
    if (
      next.size === this.selected.size &&
      Array.from(next.keys()).every((id) => this.selected.has(id))
    )
      return;
    this.selected = next;
    this.publish(source, "");
  }

  selectMatching(filters: PipelineFilters, now: number): void {
    const records = this.model.all().filter((deal) =>
      matchesFilters(
        {
          deal,
          searchName: deal.companyName.toLowerCase(),
          attention: attentionFor(deal, now),
        },
        filters,
      ),
    );
    // Selecting all again preserves reviewed versions for members already selected.
    this.setMembership(records, filters);
    this.store.setState({
      notice:
        "Selected the latest confirmed matching set. New matches will not join automatically.",
    });
  }

  clear(reason = "Selection cleared."): void {
    if (!this.selected.size) return;
    this.selected.clear();
    this.publish(null, reason);
  }

  private publish(source: PipelineFilters | null, notice: string): void {
    this.changed.clear();
    let totalValuePaise = 0;
    this.selected.forEach((record) => {
      totalValuePaise += record.valuePaise;
      if (this.model.get(record.id)?.version !== record.version)
        this.changed.add(record.id);
    });
    this.store.setState((state) => ({
      count: this.selected.size,
      totalValuePaise,
      changed: this.changed.size,
      source: source ? Object.freeze({ ...source }) : null,
      revision: state.revision + 1,
      notice,
    }));
    this.listeners.forEach((listener) => listener());
  }
}
