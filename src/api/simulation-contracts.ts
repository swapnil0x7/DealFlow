export interface SimulationSettings {
  minSaveDelayMs: number
  maxSaveDelayMs: number
  failureRate: number
  offline: boolean
  teammatesEnabled: boolean
  teammateIntervalMs: number
  changeDeliveryPaused: boolean
}

export interface SimulationConfiguration extends SimulationSettings {
  seed: number
  sessionId: string
}

export type SimulationFault = 'save-failure' | 'read-failure' | 'lost-response'
