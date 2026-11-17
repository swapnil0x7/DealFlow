import { createRoot } from 'react-dom/client'
import './index.css'
import './styles/tokens.css'
import App from './App'
import { initializeTheme } from './features/theme/browser'

initializeTheme()

const root = createRoot(document.getElementById('root')!)
root.render(
  <main className="workspace">
    <p role="status">Starting your workspace…</p>
  </main>,
)

async function bootstrap() {
  try {
    const { startSimulation } = await import('./mocks/browser')
    await startSimulation()
    root.render(<App />)
  } catch {
    root.render(
      <main className="workspace" role="alert">
        <h1>DealDesk couldn’t start</h1>
        <p>
          The demo service could not initialize. Use localhost or HTTPS, allow service workers, then
          reload.
        </p>
        <button onClick={() => window.location.reload()}>Reload workspace</button>
      </main>,
    )
  }
}

void bootstrap()
