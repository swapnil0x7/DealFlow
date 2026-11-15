import type { DealApi } from '../../api/client'
import type { Snapshot } from '../../api/contracts'
import type { SimulationConfiguration } from '../../api/simulation-contracts'
import { CURRENT_OWNER_ID } from '../../domain/filters'
import { OperationService } from '../operations/service'
import { ConfirmedReadModel } from './read-model'
import { ChangeFeed } from './feed'

export class WorkspaceSession {
  readonly api: DealApi
  readonly model: ConfirmedReadModel
  readonly operations: OperationService
  readonly feed: ChangeFeed
  readonly snapshot: Pick<Snapshot, 'owners' | 'sessionId' | 'cursor'>
  readonly configuration: SimulationConfiguration

  constructor(api: DealApi, snapshot: Snapshot, configuration: SimulationConfiguration) {
    this.api = api
    this.snapshot = { owners: snapshot.owners, sessionId: snapshot.sessionId, cursor: snapshot.cursor }
    this.configuration = configuration
    this.model = new ConfirmedReadModel(snapshot.deals)
    this.operations = new OperationService({ api, model: this.model, sessionId: snapshot.sessionId, actorId: CURRENT_OWNER_ID })
    this.feed = new ChangeFeed({ api, model: this.model, operations: this.operations, sessionId: snapshot.sessionId, cursor: snapshot.cursor })
    this.feed.setSimulationOffline(configuration.offline)
  }

  dispose(): void {
    this.feed.dispose()
    this.operations.dispose()
    this.api.invalidate()
  }
}
