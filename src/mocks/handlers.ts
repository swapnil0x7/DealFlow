import { http, HttpResponse } from 'msw'
import { ApiError } from '../api/contracts'
import type { Simulation } from './simulation'

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid object')
    return body as Record<string, unknown>
  } catch {
    throw new ApiError('invalid_request', 'Expected a JSON object.')
  }
}

function session(request: Request): string {
  return request.headers.get('X-DealDesk-Session') ?? ''
}

async function respond<T extends object>(action: () => T | Promise<T>): Promise<Response> {
  try {
    return HttpResponse.json(await action())
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    if (error.issue.code === 'offline' || error.issue.code === 'response_lost') return HttpResponse.error()
    const status = error.issue.code === 'not_found' ? 404 :
      ['session_expired', 'mutation_reused'].includes(error.issue.code) ? 409 :
        ['save_failed', 'read_failed'].includes(error.issue.code) ? 503 : error.issue.code === 'history_full' ? 429 : 400
    return HttpResponse.json({ error: error.issue }, { status })
  }
}

export function createHandlers(simulation: Simulation) {
  return [
    http.get('*/api/deals', () => respond(() => simulation.snapshot())),
    http.patch('*/api/deals/:id', ({ request, params }) => respond(async () => {
      const body = await jsonBody(request)
      return simulation.move({ ...body, dealId: params.id, sessionId: session(request) })
    })),
    http.post('*/api/deals/bulk-move', ({ request }) => respond(async () => {
      const body = await jsonBody(request)
      if (!Array.isArray(body.commands)) throw new ApiError('invalid_request', 'Expected commands array.')
      return simulation.bulk(body.commands.map((command: unknown) => ({
        ...(command && typeof command === 'object' ? command : {}), sessionId: session(request),
      })))
    })),
    http.get('*/api/operations/:mutationId', ({ request, params }) => respond(() =>
      simulation.operation(String(params.mutationId), session(request)))),
    http.get('*/api/changes', ({ request }) => respond(() => {
      const after = new URL(request.url).searchParams.get('after')
      if (after === null || !/^\d+$/.test(after)) throw new ApiError('invalid_request', 'A nonnegative cursor is required.')
      return simulation.changes(Number(after), session(request))
    })),
    // Local control-plane routes remain reachable offline so the demo can reconnect or reset.
    http.get('*/api/simulation', () => respond(() => simulation.configuration())),
    http.patch('*/api/simulation', ({ request }) => respond(async () => simulation.configure(await jsonBody(request)))),
    http.post('*/api/simulation/faults', ({ request }) => respond(async () => {
      simulation.forceFault((await jsonBody(request)).fault)
      return { ok: true }
    })),
    http.post('*/api/simulation/reset', ({ request }) => respond(async () => simulation.reset((await jsonBody(request)).seed))),
    http.all('*/api/*', () => respond(() => { throw new ApiError('not_found', 'Unknown API endpoint.') })),
  ]
}
