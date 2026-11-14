import { ApiError } from './contracts'
import type { ApiIssue, ChangePage, MoveCommand, MoveResult, OperationStatus, Snapshot } from './contracts'

/** A transport error does not say whether a write committed. Reconcile before assuming failure. */
export class TransportError extends Error {
  constructor(cause: unknown) {
    super('Connection interrupted. Reconcile unresolved saves before retrying.', { cause })
    this.name = 'TransportError'
  }
}

export class DealApi {
  private generation = 0
  private sessionId: string | undefined
  private readonly baseUrl: string

  constructor(baseUrl = '') { this.baseUrl = baseUrl }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const generation = this.generation
    const assertCurrent = () => {
      if (generation !== this.generation) throw new ApiError('session_expired', 'This request belongs to an older client session.')
    }
    let response: Response
    try {
      response = await fetch(`${this.baseUrl}/api${path}`, init)
    } catch (cause) {
      assertCurrent()
      throw new TransportError(cause)
    }
    let body: unknown
    try {
      body = await response.json()
    } catch (cause) {
      assertCurrent()
      throw new TransportError(cause)
    }
    assertCurrent()
    if (!response.ok) {
      const issue = (body as { error?: ApiIssue } | null)?.error
      if (!issue || typeof issue.code !== 'string' || typeof issue.message !== 'string' || typeof issue.retryable !== 'boolean') {
        throw new TransportError(new Error('The API returned an unreadable error response.'))
      }
      const { code, message, retryable } = issue
      throw new ApiError(code, message, retryable)
    }
    return body as T
  }

  async load(): Promise<Snapshot> {
    this.generation++
    this.sessionId = undefined
    const snapshot = await this.request<Snapshot>('/deals')
    this.sessionId = snapshot.sessionId
    return snapshot
  }

  private headers(sessionId = this.sessionId): Record<string, string> {
    if (!sessionId) throw new ApiError('session_expired', 'Load the current snapshot before issuing commands.')
    return { 'Content-Type': 'application/json', 'X-DealDesk-Session': sessionId }
  }

  move(command: MoveCommand): Promise<MoveResult> {
    return this.request(`/deals/${encodeURIComponent(command.dealId)}`, {
      method: 'PATCH', headers: this.headers(command.sessionId), body: JSON.stringify(command),
    })
  }

  bulk(commands: readonly MoveCommand[]): Promise<{ results: { mutationId: string; dealId: string; result: MoveResult }[] }> {
    const sessionId = commands[0]?.sessionId
    if (commands.some((command) => command.sessionId !== sessionId)) {
      throw new ApiError('invalid_request', 'A batch cannot mix simulation sessions.')
    }
    return this.request('/deals/bulk-move', {
      method: 'POST', headers: this.headers(sessionId), body: JSON.stringify({ commands }),
    })
  }

  operation(mutationId: string): Promise<OperationStatus> {
    return this.request(`/operations/${encodeURIComponent(mutationId)}`, { headers: this.headers() })
  }

  changes(after: number): Promise<ChangePage> {
    return this.request(`/changes?after=${after}`, { headers: this.headers() })
  }

  async reset(seed = 42): Promise<void> {
    this.generation++
    this.sessionId = undefined
    await this.request('/simulation/reset', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed }),
    })
  }
}
