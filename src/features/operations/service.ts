import { createStore } from "zustand/vanilla";
import type { DealApi } from "../../api/client";
import { TransportError } from "../../api/client";
import { ApiError } from "../../api/contracts";
import type {
  ApiIssue,
  ChangeEvent,
  MoveCommand,
  MoveResult,
  Receipt,
} from "../../api/contracts";
import type { Deal, Stage } from "../../domain/deal";
import type { ConfirmedReadModel } from "../collaboration/read-model";
import { ActivityRegistry } from "./activity";
import { resolution } from "./outcomes";

export type ItemState =
  | "queued"
  | "saving"
  | "succeeded"
  | "failed"
  | "conflicted"
  | "unconfirmed"
  | "skipped";
export interface Operation {
  readonly id: string;
  readonly kind: "move" | "undo";
  readonly command: MoveCommand;
  readonly previousStage: Stage;
  readonly companyName: string;
  readonly createdAt: number;
  readonly parentId?: string;
  readonly undoId?: string;
  readonly reviewedBy?: string;
  readonly keptVersion?: number;
  readonly status: ItemState;
  readonly attempts: number;
  readonly checking: boolean;
  readonly canResume: boolean;
  readonly message?: string;
  readonly error?: ApiIssue;
  readonly receipt?: Receipt;
  readonly conflict?: Deal;
}

interface WorkflowState {
  byId: Record<string, Operation>;
  order: readonly string[];
  latestByDeal: Record<string, string>;
  notice: string | null;
  sessionExpired: boolean;
  knownVersions: Record<string, number>;
}

interface Options {
  api: Pick<DealApi, "move" | "operation">;
  model: ConfirmedReadModel;
  sessionId: string;
  actorId: string;
  clock?: () => number;
  id?: () => string;
  timeoutMs?: number;
  historyLimit?: number;
  activity?: ActivityRegistry;
}

const confirmed = (operation: Operation | undefined) =>
  operation?.status === "succeeded" || operation?.status === "skipped";
const unresolved = (operation: Operation) =>
  ["queued", "saving", "unconfirmed"].includes(operation.status) ||
  operation.checking;

/** Owns command lifecycle, never a second saved-record database. All writes go through the HTTP client. */
export class OperationService {
  readonly activity: ActivityRegistry;
  readonly store = createStore<WorkflowState>(() => ({
    byId: {},
    order: [],
    latestByDeal: {},
    notice: null,
    sessionExpired: false,
    knownVersions: {},
  }));
  private readonly options: Options;
  private active = true;
  private readonly timers = new Map<
    ReturnType<typeof setTimeout>,
    () => void
  >();
  private readonly unsubscribeModel: () => void;

  constructor(options: Options) {
    this.options = options;
    this.activity = options.activity ?? new ActivityRegistry();
    this.unsubscribeModel = options.model.subscribe((records) => {
      const state = this.store.getState();
      const tracked = records.filter((record) => state.latestByDeal[record.id]);
      if (this.active && tracked.length)
        this.store.setState({
          knownVersions: {
            ...state.knownVersions,
            ...Object.fromEntries(
              tracked.map((record) => [record.id, record.version]),
            ),
          },
        });
    });
  }

  dispose(): void {
    this.active = false;
    this.unsubscribeModel();
    this.timers.forEach((reject, timer) => {
      clearTimeout(timer);
      reject();
    });
    this.timers.clear();
    this.activity.batch(() =>
      Object.values(this.store.getState().byId).forEach((item) =>
        this.activity.remove(item.command.dealId, item.id),
      ),
    );
  }

  private patch(id: string, patch: Partial<Operation>): void {
    if (!this.active) return;
    this.store.setState((state) =>
      state.byId[id]
        ? { byId: { ...state.byId, [id]: { ...state.byId[id], ...patch } } }
        : state,
    );
    const item = this.store.getState().byId[id];
    if (item)
      this.activity.update({
        id,
        dealId: item.command.dealId,
        stage: item.command.stage,
        kind: item.kind,
        status: item.status,
        resolution: resolution(item),
      });
  }

  isBlocked(dealId: string): boolean {
    const state = this.store.getState();
    return (
      !this.active || state.sessionExpired || this.activity.isBlocked(dealId)
    );
  }

  move(record: Deal, target: Stage): string | null {
    return this.start(record, target, "move");
  }

  private start(
    record: Deal,
    target: Stage,
    kind: Operation["kind"],
    parentId?: string,
  ): string | null {
    if (this.isBlocked(record.id)) {
      if (this.active)
        this.store.setState({
          notice:
            "Resolve the outstanding save for this deal before making another change.",
        });
      return null;
    }
    const state = this.store.getState();
    if (state.order.length >= (this.options.historyLimit ?? 200)) {
      this.store.setState({
        notice:
          "Recent results are full. Dismiss a resolved result to free space; dismissal removes its recovery and Undo actions.",
      });
      return null;
    }
    const id = (this.options.id ?? (() => crypto.randomUUID()))();
    const operation: Operation = {
      id,
      kind,
      parentId,
      companyName: record.companyName,
      previousStage: record.stage,
      createdAt: (this.options.clock ?? Date.now)(),
      attempts: 0,
      status: "queued",
      checking: false,
      canResume: false,
      command: Object.freeze({
        dealId: record.id,
        stage: target,
        expectedVersion: record.version,
        mutationId: id,
        sessionId: this.options.sessionId,
        actorId: this.options.actorId,
      }),
    };
    if (
      !this.activity.claim({
        id,
        dealId: record.id,
        stage: target,
        kind,
        status: "queued",
      })
    )
      return null;
    this.store.setState({
      byId: { ...state.byId, [id]: operation },
      order: [id, ...state.order],
      latestByDeal: { ...state.latestByDeal, [record.id]: id },
      knownVersions: {
        ...state.knownVersions,
        [record.id]:
          this.options.model.get(record.id)?.version ?? record.version,
      },
      notice: null,
    });
    if (kind === "undo" && parentId) this.patch(parentId, { undoId: id });
    void this.send(id);
    return id;
  }

  private async timed<T>(request: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          const cancel = () =>
            reject(
              new TransportError(
                new Error("Request timed out or session was closed."),
              ),
            );
          timer = setTimeout(cancel, this.options.timeoutMs ?? 10_000);
          this.timers.set(timer, cancel);
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
        this.timers.delete(timer);
      }
    }
  }

  private async send(id: string): Promise<void> {
    const operation = this.store.getState().byId[id];
    if (
      !this.active ||
      !operation ||
      operation.status === "saving" ||
      confirmed(operation)
    )
      return;
    this.patch(id, {
      status: "saving",
      attempts: operation.attempts + 1,
      canResume: false,
      checking: false,
      error: undefined,
      message: undefined,
    });
    this.store.setState((state) => ({
      latestByDeal: { ...state.latestByDeal, [operation.command.dealId]: id },
    }));
    try {
      const request = this.options.api.move(operation.command);
      // A timeout does not abort a server commit. A later result may still confirm this exact command.
      void request.then(
        (result) => this.finish(id, result),
        () => {},
      );
      this.finish(id, await this.timed(request));
    } catch (error) {
      if (
        !this.active ||
        !this.store.getState().byId[id] ||
        confirmed(this.store.getState().byId[id])
      )
        return;
      if (error instanceof ApiError && error.issue.code !== "session_expired") {
        this.patch(id, { status: "failed", error: error.issue });
      } else {
        this.patch(id, {
          status: "unconfirmed",
          message:
            "Save outcome is not confirmed. Checking the original command…",
        });
        if (error instanceof ApiError && error.issue.code === "session_expired")
          this.expire(id);
        else await this.reconcile(id);
      }
    }
  }

  private finish(id: string, result: MoveResult): void {
    const operation = this.store.getState().byId[id];
    if (
      !this.active ||
      !operation ||
      confirmed(operation) ||
      this.store.getState().sessionExpired
    )
      return;
    if (result.status === "succeeded" || result.status === "skipped") {
      this.acceptReceipt(result.receipt);
    } else if (result.status === "conflicted") {
      this.options.model.apply([result.latest]);
      this.patch(id, {
        status: "conflicted",
        conflict: this.options.model.get(result.latest.id) ?? result.latest,
        checking: false,
        canResume: false,
        message:
          "A newer version exists. Review it before submitting a new change.",
      });
    } else if (result.status === "failed") {
      this.patch(id, {
        status: "failed",
        error: result.error,
        checking: false,
        canResume: false,
        message: undefined,
      });
    }
  }

  /** Also used by Stage 4 when a matching change arrives before its HTTP response. */
  acceptReceipt(receipt: Receipt): void {
    const item = this.store.getState().byId[receipt.mutationId];
    if (
      !this.active ||
      !item ||
      confirmed(item) ||
      this.store.getState().sessionExpired ||
      receipt.sessionId !== item.command.sessionId ||
      receipt.actorId !== item.command.actorId ||
      receipt.record.id !== item.command.dealId ||
      receipt.record.stage !== item.command.stage ||
      receipt.record.version !==
        item.command.expectedVersion + (receipt.changed ? 1 : 0)
    )
      return;
    this.options.model.apply([receipt.record]);
    this.patch(item.id, {
      status: receipt.changed ? "succeeded" : "skipped",
      receipt: structuredClone(receipt),
      checking: false,
      canResume: false,
      error: undefined,
      message: undefined,
    });
  }

  confirmChange(event: ChangeEvent): void {
    const item = this.store.getState().byId[event.mutationId];
    if (!item) return;
    this.acceptReceipt({
      sessionId: this.options.sessionId,
      mutationId: event.mutationId,
      actorId: event.actorId,
      changed: true,
      previousStage: item.previousStage,
      record: event.record,
      committedAt: event.record.updatedAt,
    });
  }

  /** Read-only recovery after feed resync; never launches retry writes. */
  async reconcileOutstanding(): Promise<void> {
    const ids = this.store
      .getState()
      .order.filter(
        (id) => this.store.getState().byId[id]?.status === "unconfirmed",
      );
    for (let index = 0; this.active && index < ids.length; index += 4) {
      await Promise.all(
        ids.slice(index, index + 4).map((id) => this.reconcile(id)),
      );
    }
  }

  expireSession(): void {
    if (!this.active) return;
    this.store.setState({ sessionExpired: true });
    for (const item of Object.values(this.store.getState().byId)) {
      if (unresolved(item))
        this.patch(item.id, {
          status: "unconfirmed",
          checking: false,
          canResume: false,
          message:
            "The simulation session expired. Its receipts are no longer available. Reload the workspace.",
        });
    }
  }

  async retry(id: string): Promise<void> {
    const item = this.store.getState().byId[id];
    if (!this.active || !item || item.checking || this.isBlockedByOther(item))
      return;
    if (item.status === "failed" && item.error?.retryable) await this.send(id);
    else if (item.status === "unconfirmed") {
      await this.reconcile(id);
      const current = this.store.getState().byId[id];
      if (current?.status === "unconfirmed" && current.canResume)
        await this.send(id);
    }
  }

  private isBlockedByOther(item: Operation): boolean {
    return (
      this.store.getState().sessionExpired ||
      this.activity.isBlocked(item.command.dealId, item.id)
    );
  }

  async reconcile(id: string): Promise<void> {
    const item = this.store.getState().byId[id];
    if (
      !this.active ||
      !item ||
      confirmed(item) ||
      item.checking ||
      this.store.getState().sessionExpired
    )
      return;
    this.patch(id, { checking: true, canResume: false });
    try {
      const outcome = await this.timed(
        this.options.api.operation(item.command.mutationId),
      );
      if (
        !this.active ||
        !this.store.getState().byId[id] ||
        confirmed(this.store.getState().byId[id])
      )
        return;
      if (outcome.status === "completed") this.finish(id, outcome.result);
      else
        this.patch(id, {
          status: "unconfirmed",
          checking: false,
          canResume: outcome.status !== "pending",
          message:
            outcome.status === "pending"
              ? "The original command is still saving. Check its status again."
              : "No committed receipt was found. You can retry the original change with the same version guard.",
        });
    } catch (error) {
      if (
        !this.active ||
        !this.store.getState().byId[id] ||
        confirmed(this.store.getState().byId[id])
      )
        return;
      if (error instanceof ApiError && error.issue.code === "session_expired")
        this.expire(id);
      else
        this.patch(id, {
          status: "unconfirmed",
          checking: false,
          canResume: false,
          message:
            "Could not confirm the save. Check status when the connection is available.",
        });
    }
  }

  review(id: string, reviewed: Deal): string | null {
    const item = this.store.getState().byId[id];
    if (
      !item ||
      item.status !== "conflicted" ||
      item.reviewedBy ||
      item.keptVersion !== undefined ||
      reviewed.id !== item.command.dealId
    )
      return null;
    const nextId = this.start(reviewed, item.command.stage, "move", item.id);
    if (nextId) this.patch(id, { reviewedBy: nextId });
    return nextId;
  }

  /** Acknowledges an explicitly reviewed value locally; no save is issued or history removed. */
  keepLatest(id: string, reviewed: Deal): boolean {
    const item = this.store.getState().byId[id];
    if (!this.active || !item || item.status !== "conflicted" || item.reviewedBy ||
        item.keptVersion !== undefined || this.isBlockedByOther(item) ||
        reviewed.id !== item.command.dealId || this.options.model.get(reviewed.id)?.version !== reviewed.version) return false;
    this.patch(id, { keptVersion: reviewed.version, message: "Latest saved stage kept. No replacement change was submitted." });
    return true;
  }

  canUndo(id: string): boolean {
    const item = this.store.getState().byId[id];
    if (
      !item ||
      item.kind !== "move" ||
      item.status !== "succeeded" ||
      !item.receipt ||
      item.undoId ||
      this.isBlocked(item.command.dealId)
    )
      return false;
    return (
      this.options.model.get(item.command.dealId)?.version ===
      item.receipt.record.version
    );
  }

  undo(id: string): string | null {
    if (!this.canUndo(id)) return null;
    const item = this.store.getState().byId[id];
    return this.start(item.receipt!.record, item.previousStage, "undo", id);
  }

  canDismiss(id: string): boolean {
    const state = this.store.getState();
    const item = state.byId[id];
    return Boolean(
      item &&
      !unresolved(item) &&
      !Object.values(state.byId).some(
        (child) => child.parentId === id && unresolved(child),
      ),
    );
  }

  dismiss(id: string): void {
    if (!this.canDismiss(id)) return;
    this.store.setState((state) => {
      const byId = { ...state.byId };
      const dealId = byId[id].command.dealId;
      delete byId[id];
      this.activity.remove(dealId, id);
      const order = state.order.filter((key) => key !== id);
      const latestByDeal = { ...state.latestByDeal };
      const knownVersions = { ...state.knownVersions };
      const latest = order.find((key) => byId[key].command.dealId === dealId);
      if (latest) latestByDeal[dealId] = latest;
      else {
        delete latestByDeal[dealId];
        delete knownVersions[dealId];
      }
      return { byId, order, latestByDeal, knownVersions, notice: null };
    });
  }

  private expire(id: string): void {
    this.store.setState({ sessionExpired: true });
    this.patch(id, {
      status: "unconfirmed",
      checking: false,
      canResume: false,
      message:
        "The simulation session expired. Its receipts are no longer available. Reload the workspace.",
    });
  }
}
