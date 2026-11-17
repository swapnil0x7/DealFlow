import type { DealApi } from "../../api/client";
import type { Snapshot } from "../../api/contracts";
import type { SimulationConfiguration } from "../../api/simulation-contracts";
import { CURRENT_OWNER_ID } from "../../domain/filters";
import { OperationService } from "../operations/service";
import { ActivityRegistry } from "../operations/activity";
import { BulkService } from "../bulk/service";
import { SelectionService } from "../bulk/selection";
import { ConfirmedReadModel } from "./read-model";
import { ChangeFeed } from "./feed";

export class WorkspaceSession {
  readonly api: DealApi;
  readonly model: ConfirmedReadModel;
  readonly operations: OperationService;
  readonly bulk: BulkService;
  readonly selection: SelectionService;
  readonly feed: ChangeFeed;
  readonly snapshot: Pick<Snapshot, "owners" | "sessionId" | "cursor">;
  readonly configuration: SimulationConfiguration;
  private readonly unsubscribeConnection: () => void;

  constructor(
    api: DealApi,
    snapshot: Snapshot,
    configuration: SimulationConfiguration,
  ) {
    this.api = api;
    this.snapshot = {
      owners: snapshot.owners,
      sessionId: snapshot.sessionId,
      cursor: snapshot.cursor,
    };
    this.configuration = configuration;
    this.model = new ConfirmedReadModel(snapshot.deals);
    const activity = new ActivityRegistry();
    const options = {
      api,
      model: this.model,
      sessionId: snapshot.sessionId,
      actorId: CURRENT_OWNER_ID,
      activity,
    };
    this.operations = new OperationService(options);
    this.bulk = new BulkService(options);
    this.selection = new SelectionService(this.model);
    this.feed = new ChangeFeed({
      api,
      model: this.model,
      operations: {
        confirmChange: (event) => {
          this.operations.confirmChange(event);
          this.bulk.confirmChange(event);
        },
        reconcileOutstanding: async () => {
          await this.operations.reconcileOutstanding();
          await this.bulk.reconcileOutstanding();
        },
        expireSession: () => {
          this.operations.expireSession();
          this.bulk.expireSession();
        },
      },
      sessionId: snapshot.sessionId,
      cursor: snapshot.cursor,
    });
    this.unsubscribeConnection = this.feed.store.subscribe(({ status }) => {
      if (status === "offline") this.bulk.setOnline(false);
      else if (status === "live" || status === "paused")
        this.bulk.setOnline(true);
    });
    this.feed.setSimulationOffline(configuration.offline);
  }

  dispose(): void {
    this.unsubscribeConnection();
    this.feed.dispose();
    this.selection.dispose();
    this.bulk.dispose();
    this.operations.dispose();
    this.api.invalidate();
  }
}
