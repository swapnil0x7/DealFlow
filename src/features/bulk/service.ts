import { createStore } from "zustand/vanilla";
import { TransportError } from "../../api/client";
import type { DealApi } from "../../api/client";
import { ApiError, MAX_BATCH_SIZE } from "../../api/contracts";
import type { ChangeEvent, MoveResult, Receipt } from "../../api/contracts";
import type { Deal, Stage } from "../../domain/deal";
import { isStage } from "../../domain/deal";
import type { ConfirmedReadModel } from "../collaboration/read-model";
import { ActivityRegistry, isUnresolved } from "../operations/activity";
import { needsAction, resolution } from "../operations/outcomes";
import { emptyCounts } from "./types";
import type {
  BulkItem,
  BulkPreview,
  BulkSummary,
  Counts,
  PreviewItem,
} from "./types";
import type { ItemState } from "../operations/service";

interface Group {
  preview: BulkPreview;
  items: Map<string, BulkItem>;
  queue: string[];
  cursor: number;
  counts: Counts;
  createdAt: number;
  paused: boolean;
  checking: boolean;
  message: string;
  revision: number;
  retryable: number;
  resumable: number;
  needsAction: number;
}
interface Options {
  api: Pick<DealApi, "bulk" | "operation">;
  model: ConfirmedReadModel;
  activity: ActivityRegistry;
  sessionId: string;
  actorId: string;
  id?: () => string;
  clock?: () => number;
  timeoutMs?: number;
  historyLimit?: number;
  itemLimit?: number;
}
interface BulkState {
  groups: readonly BulkSummary[];
  online: boolean;
  expired: boolean;
  notice: string | null;
}
type BatchResponse = Awaited<ReturnType<DealApi["bulk"]>>;
const isConfirmed = (item: BulkItem) =>
  item.status === "succeeded" || item.status === "skipped";
const retryable = (item: BulkItem) =>
  item.status === "failed" && Boolean(item.error?.retryable);
const resumable = (item: BulkItem) =>
  item.status === "unconfirmed" && item.canResume && !item.checking;

/** Grouped command workflow. At most four write requests, 200 items each; no per-item promise fan-out. */
export class BulkService {
  readonly store = createStore<BulkState>(() => ({
    groups: [],
    online: true,
    expired: false,
    notice: null,
  }));
  private readonly options: Options;
  private readonly groups = new Map<string, Group>();
  private readonly index = new Map<string, Group>();
  private active = true;
  private inFlight = 0;
  private pumpTimer: ReturnType<typeof setTimeout> | undefined;
  private publishTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly deadlines = new Map<
    ReturnType<typeof setTimeout>,
    () => void
  >();
  private readonly unsubscribe: () => void;
  private recovery: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
    this.unsubscribe = options.model.subscribe((records) => {
      if (records.some((record) => options.activity.get(record.id)))
        this.publishSoon();
    });
  }

  private id(): string {
    return (this.options.id ?? (() => crypto.randomUUID()))();
  }
  private now(): number {
    return (this.options.clock ?? Date.now)();
  }
  private writable(): boolean {
    return this.active && !this.store.getState().expired;
  }

  preview(
    records: readonly Deal[],
    target: Stage,
    source: string,
  ): BulkPreview {
    const items = records.map((record): PreviewItem => {
      const changed =
        this.options.model.get(record.id)?.version !== record.version;
      const pending = this.options.activity.isBlocked(record.id);
      return Object.freeze({
        companyName: record.companyName,
        previousStage: record.stage,
        valuePaise: record.valuePaise,
        changed,
        command: Object.freeze({
          sessionId: this.options.sessionId,
          actorId: this.options.actorId,
          dealId: record.id,
          mutationId: this.id(),
          expectedVersion: record.version,
          stage: target,
        }),
        skipKind: pending
          ? "pending"
          : !changed && record.stage === target
            ? "noop"
            : undefined,
        skipReason: pending
          ? "An outstanding local command already owns this deal."
          : !changed && record.stage === target
            ? "Already in the target stage at review."
            : undefined,
      });
    });
    return this.freezePreview({
      id: this.id(),
      kind: "move",
      source,
      target,
      items,
      excluded: 0,
    });
  }

  private freezePreview(
    input: Pick<
      BulkPreview,
      "id" | "kind" | "source" | "target" | "items" | "excluded" | "parent"
    >,
  ): BulkPreview {
    return Object.freeze({
      ...input,
      items: Object.freeze([...input.items]),
      totalValuePaise: input.items.reduce(
        (sum, item) => sum + item.valuePaise,
        0,
      ),
      changed: input.items.filter((item) => item.changed).length,
      pending: input.items.filter((item) => item.skipKind === "pending").length,
      noops: input.items.filter((item) => item.skipKind === "noop").length,
    });
  }

  submit(preview: BulkPreview): string | null {
    if (
      !this.writable() ||
      !preview.items.length ||
      this.groups.has(preview.id)
    )
      return null;
    const total = Array.from(this.groups.values()).reduce(
      (sum, group) => sum + group.items.size,
      0,
    );
    if (
      this.groups.size >= (this.options.historyLimit ?? 10) ||
      total + preview.items.length > (this.options.itemLimit ?? 100_000)
    ) {
      this.store.setState({
        notice:
          "Bulk history is full (10 operations / 100,000 items). Dismiss a resolved operation to free space; its recovery and Undo actions will be removed.",
      });
      return null;
    }
    if (preview.parent?.relation === "review") {
      const parent = this.getItem(
        preview.parent.groupId,
        preview.parent.itemId!,
      );
      if (!parent || parent.status !== "conflicted" || parent.reviewedBy || parent.keptVersion !== undefined)
        return null;
    }
    const group: Group = {
      preview,
      items: new Map(),
      queue: [],
      cursor: 0,
      counts: emptyCounts(),
      createdAt: this.now(),
      paused: !this.store.getState().online,
      checking: false,
      message: "",
      revision: 0,
      retryable: 0,
      resumable: 0,
      needsAction: 0,
    };
    this.options.activity.batch(() => {
      for (const entry of preview.items) {
        let skipReason = entry.skipReason;
        let skipKind = entry.skipKind;
        if (
          !skipReason &&
          !this.options.activity.claim({
            id: entry.command.mutationId,
            dealId: entry.command.dealId,
            stage: entry.command.stage,
            kind: preview.kind,
            status: "queued",
          })
        ) {
          skipKind = "pending";
          skipReason = "An outstanding local command started after review.";
        }
        const item: BulkItem = {
          ...entry,
          skipKind,
          skipReason,
          status: skipReason ? "skipped" : "queued",
          attempts: 0,
          history: [],
          olderAttempts: 0,
          canResume: false,
          checking: false,
        };
        group.items.set(entry.command.mutationId, item);
        this.index.set(entry.command.mutationId, group);
        group.counts[item.status]++;
        if (item.status === "queued") group.queue.push(item.command.mutationId);
      }
      this.groups.set(preview.id, group);
      if (preview.parent) {
        const parent = this.groups.get(preview.parent.groupId);
        if (parent) {
          if (preview.parent.relation === "review")
            this.patch(parent, preview.parent.itemId!, {
              reviewedBy: preview.id,
            });
          else {
            const originals = new Map(
              Array.from(parent.items.values(), (item) => [
                item.command.dealId,
                item,
              ]),
            );
            for (const item of group.items.values()) {
              const original = originals.get(item.command.dealId);
              if (original)
                this.patch(parent, original.command.mutationId, {
                  undoId: preview.id,
                });
            }
          }
        }
      }
    });
    // Preview records are compact descriptors. Do not retain a second copy of every result in the preview.
    group.preview = { ...preview, items: [] };
    this.store.setState({ notice: null });
    this.publish();
    this.schedule();
    return preview.id;
  }

  getItem(groupId: string, itemId: string): BulkItem | undefined {
    return this.groups.get(groupId)?.items.get(itemId);
  }

  getItemById(itemId: string): BulkItem | undefined {
    return this.index.get(itemId)?.items.get(itemId);
  }

  groupForItem(itemId: string): string | undefined {
    return this.index.get(itemId)?.preview.id;
  }

  page(
    groupId: string,
    status: ItemState | "all",
    page: number,
    size = 30,
  ): readonly BulkItem[] {
    const group = this.groups.get(groupId);
    if (!group) return [];
    let skip = Math.max(0, page) * size;
    const result: BulkItem[] = [];
    for (const item of group.items.values()) {
      if (status !== "all" && item.status !== status) continue;
      if (skip-- > 0) continue;
      result.push(item);
      if (result.length === size) break;
    }
    return result;
  }

  private patch(
    group: Group,
    id: string,
    patch: Partial<BulkItem>,
    recordAttempt = false,
  ): void {
    const previous = group.items.get(id);
    if (!this.active || !previous) return;
    let item = { ...previous, ...patch };
    if (recordAttempt) {
      const history = [
        ...previous.history,
        {
          attempt: item.attempts,
          at: this.now(),
          status: item.status,
          message: item.message ?? item.error?.message,
        },
      ];
      item = {
        ...item,
        history: history.slice(-10),
        olderAttempts:
          previous.olderAttempts + Math.max(0, history.length - 10),
      };
    }
    group.items.set(id, item);
    group.counts[previous.status]--;
    group.counts[item.status]++;
    group.retryable += Number(retryable(item)) - Number(retryable(previous));
    group.resumable += Number(resumable(item)) - Number(resumable(previous));
    group.needsAction += Number(needsAction(item)) - Number(needsAction(previous));
    if (item.attempts || !previous.skipReason)
      this.options.activity.update({
        id,
        dealId: item.command.dealId,
        stage: item.command.stage,
        kind: group.preview.kind,
        status: item.status,
        resolution: resolution(item),
      });
    this.publishSoon();
  }

  private publishSoon(): void {
    if (this.active && this.publishTimer === undefined)
      this.publishTimer = setTimeout(() => this.publish(), 50);
  }

  private publish(): void {
    clearTimeout(this.publishTimer);
    this.publishTimer = undefined;
    if (!this.active) return;
    this.store.setState({
      groups: Array.from(this.groups.values())
        .reverse()
        .map((group) => ({
          id: group.preview.id,
          kind: group.preview.kind,
          source: group.preview.source,
          target: group.preview.target,
          total: group.items.size,
          counts: { ...group.counts },
          createdAt: group.createdAt,
          paused: group.paused,
          message: group.message,
          checking: group.checking,
          revision: ++group.revision,
          retryable: group.retryable,
          resumable: group.resumable,
          needsAction: group.needsAction,
          parentId: group.preview.parent?.groupId,
        })),
    });
  }

  setOnline(online: boolean): void {
    if (!this.active || this.store.getState().online === online) return;
    this.store.setState({ online });
    if (!online)
      this.pauseAll(
        "Connection interrupted. Reconnect, check unconfirmed items, and explicitly resume queued work.",
      );
    // Reconnection enables controls only. It never schedules writes.
  }

  private pauseAll(message: string): void {
    for (const group of this.groups.values()) {
      if (
        group.counts.queued ||
        group.counts.saving ||
        group.counts.unconfirmed
      ) {
        group.paused = true;
        group.message = message;
      }
    }
    this.publishSoon();
  }

  resume(groupId: string): void {
    const group = this.groups.get(groupId);
    if (!this.writable() || !group || !this.store.getState().online) return;
    group.paused = false;
    group.message =
      "Queued commands resumed explicitly. Original versions are retained.";
    this.publish();
    this.schedule();
  }

  private schedule(): void {
    if (
      !this.writable() ||
      !this.store.getState().online ||
      this.pumpTimer !== undefined
    )
      return;
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = undefined;
      this.pump();
    }, 0);
  }

  private pump(): void {
    if (!this.writable() || !this.store.getState().online || this.inFlight >= 4)
      return;
    for (const group of this.groups.values()) {
      if (group.paused || !group.counts.queued) continue;
      const ids: string[] = [];
      while (group.cursor < group.queue.length && ids.length < MAX_BATCH_SIZE) {
        const id = group.queue[group.cursor++];
        if (group.items.get(id)?.status === "queued") ids.push(id);
      }
      if (ids.length) {
        this.launch(group, ids);
        // Each scheduling turn yields to input and rendering, including zero-latency simulated saves.
        this.schedule();
        return;
      }
    }
  }

  private async timed<T>(request: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          const cancel = () =>
            reject(new TransportError("Request timed out or session closed."));
          timer = setTimeout(cancel, this.options.timeoutMs ?? 10_000);
          this.deadlines.set(timer, cancel);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        this.deadlines.delete(timer);
      }
    }
  }

  private launch(group: Group, ids: readonly string[]): void {
    this.inFlight++;
    this.options.activity.batch(() =>
      ids.forEach((id) => {
        const item = group.items.get(id)!;
        this.patch(group, id, {
          status: "saving",
          attempts: item.attempts + 1,
          canResume: false,
          checking: false,
          error: undefined,
          message: undefined,
        });
      }),
    );
    const commands = ids.map((id) => group.items.get(id)!.command);
    const request = Promise.resolve().then(() =>
      this.options.api.bulk(commands),
    );
    // A timeout does not free a physical request slot. Late receipts remain valid.
    void request
      .then(
        (response) => this.finishBatch(group, ids, response),
        () => {},
      )
      .finally(() => {
        this.inFlight--;
        this.schedule();
      });
    void this.timed(request).then(
      () => {},
      (error: unknown) => {
        if (!this.writable()) return;
        if (
          error instanceof ApiError &&
          error.issue.code === "session_expired"
        ) {
          this.expireSession();
          return;
        }
        const definite = error instanceof ApiError;
        this.options.activity.batch(() =>
          ids.forEach((id) => {
            const item = group.items.get(id);
            if (!item || isConfirmed(item) || item.status === "conflicted")
              return;
            this.patch(
              group,
              id,
              definite
                ? { status: "failed", error: error.issue, checking: false }
                : {
                    status: "unconfirmed",
                    checking: false,
                    canResume: false,
                    message:
                      "The whole batch response is unavailable. This item may have committed; check its original receipt.",
                  },
              true,
            );
          }),
        );
        if (!definite)
          this.pauseAll(
            "Batch delivery was interrupted. Check unconfirmed outcomes and explicitly resume queued work.",
          );
      },
    );
  }

  private finishBatch(
    group: Group,
    ids: readonly string[],
    response: BatchResponse,
  ): void {
    if (!this.writable() || !this.groups.has(group.preview.id)) return;
    const expected = new Set(ids);
    const seen = new Set<string>();
    const valid =
      Array.isArray(response?.results) &&
      response.results.length === ids.length &&
      response.results.every((entry) => {
        if (
          !entry ||
          typeof entry !== "object" ||
          !expected.has(entry.mutationId) ||
          seen.has(entry.mutationId) ||
          group.items.get(entry.mutationId)?.command.dealId !== entry.dealId
        )
          return false;
        seen.add(entry.mutationId);
        return true;
      });
    if (!valid) {
      this.options.activity.batch(() =>
        ids.forEach((id) => {
          const item = group.items.get(id);
          if (item && !isConfirmed(item))
            this.patch(
              group,
              id,
              {
                status: "unconfirmed",
                canResume: false,
                message:
                  "Incomplete batch response. Check the original item receipt.",
              },
              true,
            );
        }),
      );
      this.pauseAll(
        "Batch results were incomplete. Reconcile before continuing.",
      );
      return;
    }
    const records: Deal[] = [];
    this.options.activity.batch(() =>
      response.results.forEach(({ mutationId, result }) =>
        this.finish(group, mutationId, result, records),
      ),
    );
    this.options.model.apply(records);
  }

  private finish(
    group: Group,
    id: string,
    result: MoveResult,
    records: Deal[],
  ): void {
    const item = group.items.get(id);
    if (!this.writable() || !item || isConfirmed(item)) return;
    if (!result || typeof result !== "object") {
      this.invalidResult(group, id);
      return;
    }
    if (result.status === "succeeded" || result.status === "skipped") {
      if (!this.acceptReceipt(group, item, result.receipt, records))
        this.invalidResult(group, id);
    } else if (result.status === "conflicted") {
      if (
        !result.latest ||
        result.latest.id !== item.command.dealId ||
        !Number.isSafeInteger(result.latest.version) ||
        !isStage(result.latest.stage)
      ) {
        this.invalidResult(group, id);
        return;
      }
      records.push(result.latest);
      this.patch(
        group,
        id,
        {
          status: "conflicted",
          conflict: result.latest,
          checking: false,
          canResume: false,
          error: undefined,
          message:
            "A newer saved version exists. Review it before submitting a new command.",
        },
        true,
      );
    } else if (
      result.status === "failed" &&
      typeof result.error?.message === "string" &&
      typeof result.error.retryable === "boolean"
    )
      this.patch(
        group,
        id,
        {
          status: "failed",
          error: result.error,
          message: undefined,
          checking: false,
          canResume: false,
        },
        true,
      );
    else this.invalidResult(group, id);
  }

  private invalidResult(group: Group, id: string): void {
    this.patch(
      group,
      id,
      {
        status: "unconfirmed",
        checking: false,
        canResume: false,
        message:
          "The result did not identify this exact command. Check its original receipt.",
      },
      true,
    );
    this.pauseAll(
      "A batch item could not be verified. Reconcile it before continuing.",
    );
  }

  private acceptReceipt(
    group: Group,
    item: BulkItem,
    receipt: Receipt,
    records: Deal[],
  ): boolean {
    const command = item.command;
    if (
      !receipt?.record ||
      typeof receipt.changed !== "boolean" ||
      receipt.sessionId !== command.sessionId ||
      receipt.mutationId !== command.mutationId ||
      receipt.actorId !== command.actorId ||
      receipt.record.id !== command.dealId ||
      receipt.record.stage !== command.stage ||
      receipt.previousStage !== item.previousStage ||
      receipt.record.version !==
        command.expectedVersion + (receipt.changed ? 1 : 0)
    )
      return false;
    records.push(receipt.record);
    this.patch(
      group,
      command.mutationId,
      {
        status: receipt.changed ? "succeeded" : "skipped",
        receipt: structuredClone(receipt),
        checking: false,
        canResume: false,
        message: undefined,
        error: undefined,
      },
      true,
    );
    return true;
  }

  confirmChange(event: ChangeEvent): void {
    const group = this.index.get(event.mutationId);
    const item = group?.items.get(event.mutationId);
    if (!this.writable() || !group || !item || isConfirmed(item)) return;
    const records: Deal[] = [];
    this.acceptReceipt(
      group,
      item,
      {
        sessionId: this.options.sessionId,
        mutationId: event.mutationId,
        actorId: event.actorId,
        record: event.record,
        previousStage: item.previousStage,
        changed: true,
        committedAt: event.record.updatedAt,
      },
      records,
    );
    this.options.model.apply(records);
  }

  retryFailed(groupId: string): void {
    this.enqueue(
      groupId,
      (item) => item.status === "failed" && Boolean(item.error?.retryable),
    );
  }
  retryChecked(groupId: string): void {
    this.enqueue(
      groupId,
      (item) =>
        item.status === "unconfirmed" && item.canResume && !item.checking,
    );
  }

  retryItem(itemId: string): void {
    const groupId = this.groupForItem(itemId);
    if (groupId) this.enqueue(groupId, (item) => retryable(item) || resumable(item), itemId);
  }

  private enqueue(
    groupId: string,
    eligible: (item: BulkItem) => boolean,
    itemId?: string,
  ): void {
    const group = this.groups.get(groupId);
    if (!this.writable() || !group || !this.store.getState().online) return;
    if (group.paused && group.counts.queued) {
      group.message =
        "Resume queued work explicitly before retrying other items. Retry does not resume the interrupted queue.";
      this.publish();
      return;
    }
    group.queue = group.queue.slice(group.cursor);
    group.cursor = 0;
    let queued = 0;
    this.options.activity.batch(() =>
      (itemId ? new Map([[itemId, group.items.get(itemId)!]]) : group.items).forEach((item, id) => {
        if (
          !eligible(item) ||
          !this.options.activity.claim({
            id,
            dealId: item.command.dealId,
            stage: item.command.stage,
            kind: group.preview.kind,
            status: "queued",
          })
        )
          return;
        this.patch(group, id, {
          status: "queued",
          canResume: false,
          message: undefined,
          error: undefined,
        });
        group.queue.push(id);
        queued++;
      }),
    );
    if (queued) {
      group.paused = false;
      group.message = `Explicitly retrying ${queued} original commands. Successful items are unchanged.`;
    } else
      group.message =
        "No eligible items are available. Resolve overlapping local saves or review conflicts separately.";
    this.publish();
    this.schedule();
  }

  async reconcile(groupId: string): Promise<void> {
    await this.queueRecovery(() => this.checkGroup(groupId));
  }

  async reconcileItem(itemId: string): Promise<void> {
    await this.queueRecovery(async () => {
      const group = this.index.get(itemId);
      if (group && this.writable() && this.store.getState().online) await this.checkItem(group, itemId);
    });
  }

  private async queueRecovery(work: () => Promise<void>): Promise<void> {
    // Chain every caller, including those already waiting, so row and group checks share the same bound.
    const run = (this.recovery ?? Promise.resolve()).then(work, work);
    this.recovery = run;
    try { await run; } finally { if (this.recovery === run) this.recovery = undefined; }
  }

  private async checkGroup(groupId: string): Promise<void> {
    const group = this.groups.get(groupId);
    if (
      !this.writable() ||
      !group ||
      group.checking ||
      !this.store.getState().online
    )
      return;
    group.checking = true;
    this.publish();
    const ids = Array.from(group.items.values())
      .filter((item) => item.status === "unconfirmed")
      .map((item) => item.command.mutationId);
    for (
      let start = 0;
      this.writable() && this.store.getState().online && start < ids.length;
      start += 4
    ) {
      await Promise.all(
        ids.slice(start, start + 4).map((id) => this.checkItem(group, id)),
      );
    }
    group.checking = false;
    this.publish();
  }

  private async checkItem(group: Group, id: string): Promise<void> {
    const item = group.items.get(id);
    if (!item || item.status !== "unconfirmed" || item.checking) return;
    this.patch(group, id, { checking: true, canResume: false });
    try {
      const result = await this.timed(this.options.api.operation(id));
      if (
        !this.writable() ||
        !this.groups.has(group.preview.id) ||
        isConfirmed(group.items.get(id)!)
      )
        return;
      if (result.status === "completed") {
        const records: Deal[] = [];
        this.finish(group, id, result.result, records);
        this.options.model.apply(records);
      } else
        this.patch(group, id, {
          status: "unconfirmed",
          checking: false,
          canResume: result.status !== "pending",
          message:
            result.status === "pending"
              ? "The original command is still saving. Check again later."
              : "No committed receipt found. Explicitly retry this original ID and version guard.",
        });
    } catch (error) {
      if (!this.writable() || isConfirmed(group.items.get(id)!)) return;
      if (error instanceof ApiError && error.issue.code === "session_expired")
        this.expireSession();
      else
        this.patch(group, id, {
          checking: false,
          canResume: false,
          message: "Receipt check unavailable. Reconnect and check again.",
        });
    }
  }

  async reconcileOutstanding(): Promise<void> {
    for (const [id, group] of this.groups)
      if (group.counts.unconfirmed) await this.reconcile(id);
  }

  previewConflict(
    groupId: string,
    id: string,
    reviewed: Deal,
  ): BulkPreview | null {
    const item = this.getItem(groupId, id);
    if (
      !item ||
      item.status !== "conflicted" ||
      item.reviewedBy ||
      item.keptVersion !== undefined ||
      reviewed.id !== item.command.dealId
    )
      return null;
    return Object.freeze({
      ...this.preview(
        [reviewed],
        item.command.stage,
        `Reviewed conflict from ${groupId.slice(0, 8)}`,
      ),
      parent: Object.freeze({
        groupId,
        itemId: id,
        relation: "review" as const,
      }),
    });
  }

  keepLatest(itemId: string, reviewed: Deal): boolean {
    const group = this.index.get(itemId);
    const item = group?.items.get(itemId);
    if (!this.writable() || !group || !item || item.status !== "conflicted" || item.reviewedBy ||
        item.keptVersion !== undefined || this.options.activity.isBlocked(item.command.dealId, itemId) ||
        reviewed.id !== item.command.dealId || this.options.model.get(reviewed.id)?.version !== reviewed.version) return false;
    this.patch(group, itemId, { keptVersion: reviewed.version, message: "Latest saved stage kept. No replacement change was submitted." });
    return true;
  }

  undoEligible(groupId: string): number {
    const group = this.groups.get(groupId);
    if (!group || group.preview.kind !== "move" || !this.writable()) return 0;
    let count = 0;
    for (const item of group.items.values()) if (this.canUndo(item)) count++;
    return count;
  }

  private canUndo(item: BulkItem): boolean {
    return (
      item.status === "succeeded" &&
      Boolean(item.receipt) &&
      !item.undoId &&
      this.options.model.get(item.command.dealId)?.version ===
        item.receipt!.record.version &&
      !this.options.activity.isBlocked(item.command.dealId)
    );
  }

  canUndoItem(itemId: string): boolean {
    const group = this.index.get(itemId);
    const item = group?.items.get(itemId);
    return Boolean(this.writable() && group?.preview.kind === "move" && item && this.canUndo(item));
  }

  previewUndo(groupId: string, itemId?: string): BulkPreview | null {
    const group = this.groups.get(groupId);
    if (!group || group.preview.kind !== "move" || !this.writable())
      return null;
    const items: PreviewItem[] = [];
    group.items.forEach((item) => {
      if (itemId && item.command.mutationId !== itemId) return;
      if (!this.canUndo(item)) return;
      items.push(
        Object.freeze({
          companyName: item.companyName,
          valuePaise: item.valuePaise,
          previousStage: item.command.stage,
          changed: false,
          command: Object.freeze({
            ...item.command,
            mutationId: this.id(),
            stage: item.previousStage,
            expectedVersion: item.receipt!.record.version,
          }),
        }),
      );
    });
    if (!items.length) return null;
    return this.freezePreview({
      id: this.id(),
      kind: "undo",
      target: null,
      source: `Undo successes from ${groupId.slice(0, 8)}`,
      items,
      excluded: itemId ? 0 : group.counts.succeeded - items.length,
      parent: Object.freeze({ groupId, relation: "undo" }),
    });
  }

  canDismiss(groupId: string): boolean {
    const group = this.groups.get(groupId);
    const unresolved = (entry: Group) =>
      entry.checking ||
      entry.counts.queued + entry.counts.saving + entry.counts.unconfirmed > 0;
    return Boolean(
      group &&
      !unresolved(group) &&
      !Array.from(this.groups.values()).some(
        (child) =>
          child.preview.parent?.groupId === groupId && unresolved(child),
      ),
    );
  }

  dismiss(groupId: string): void {
    if (!this.canDismiss(groupId)) return;
    const group = this.groups.get(groupId)!;
    this.options.activity.batch(() =>
      group.items.forEach((item, id) => {
        this.index.delete(id);
        this.options.activity.remove(item.command.dealId, id);
      }),
    );
    this.groups.delete(groupId);
    this.store.setState({ notice: null });
    this.publish();
  }

  expireSession(): void {
    if (!this.active || this.store.getState().expired) return;
    this.store.setState({ expired: true });
    this.options.activity.batch(() =>
      this.groups.forEach((group) => {
        group.paused = true;
        group.message =
          "This session expired. Reload the workspace; old receipts are no longer available.";
        group.checking = false;
        group.items.forEach((item, id) => {
          if (isUnresolved(item.status))
            this.patch(
              group,
              id,
              item.status === "queued"
                ? {
                    status: "skipped",
                    skipKind: "expired",
                    skipReason:
                      "Session expired before this command was launched.",
                    checking: false,
                  }
                : { status: "unconfirmed", canResume: false, checking: false },
            );
        });
      }),
    );
    this.publish();
  }

  dispose(): void {
    this.active = false;
    this.unsubscribe();
    clearTimeout(this.pumpTimer);
    clearTimeout(this.publishTimer);
    this.deadlines.forEach((reject, timer) => {
      clearTimeout(timer);
      reject();
    });
    this.deadlines.clear();
    this.options.activity.batch(() =>
      this.groups.forEach((group) =>
        group.items.forEach((item, id) =>
          this.options.activity.remove(item.command.dealId, id),
        ),
      ),
    );
  }
}
