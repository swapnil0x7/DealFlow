import { setupWorker } from 'msw/browser'
import { createHandlers } from './handlers'
import { Simulation } from './simulation'
import { changeNotifications } from '../api/change-notifications'

const simulation = new Simulation({
  onNotification: (notice) => changeNotifications.publish(notice),
})
const worker = setupWorker(...createHandlers(simulation))

// The submitted app is a browser-only simulator, so MSW intentionally runs in built previews too.
export async function startSimulation(): Promise<void> {
  await worker.start({
    serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    onUnhandledFrame: 'bypass',
    quiet: true,
  })
}

if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    simulation.dispose()
    worker.stop()
  })
}
