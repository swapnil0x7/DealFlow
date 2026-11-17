import { Button } from '../../shared/ui/Button'
import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import type { SimulationConfiguration, SimulationFault } from '../../api/simulation-contracts'
import type { WorkspaceSession } from './session'
import styles from './Simulation.module.css'

export function SimulationPanelContent({
  session,
  activeDealId,
  onReset,
}: {
  session: WorkspaceSession
  activeDealId: string | null
  onReset: (seed: number) => void
}) {
  const [open, setOpen] = useState(true)
  const [settings, setSettings] = useState(session.configuration)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [settingsReady, setSettingsReady] = useState(false)
  const [message, setMessage] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const [seed, setSeed] = useState(String(session.configuration.seed))
  const cancelResetRef = useRef<HTMLButtonElement>(null)
  const alive = useRef(true)
  const active = activeDealId ? session.model.get(activeDealId) : undefined

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  useEffect(() => {
    if (!open) return
    let current = true
    session.api
      .simulation()
      .then((value) => {
        if (current) {
          setSettings(value)
          setSettingsReady(true)
        }
      })
      .catch(() => {
        if (current) setMessage('Could not read simulation settings. Try reopening the panel.')
      })
      .finally(() => {
        if (current) setLoading(false)
      })
    return () => {
      current = false
    }
  }, [open, session])
  useEffect(() => {
    if (confirmReset) cancelResetRef.current?.focus()
  }, [confirmReset])

  async function perform(action: () => Promise<void>) {
    setBusy(true)
    setMessage('')
    try {
      await action()
    } catch (error) {
      if (alive.current)
        setMessage(error instanceof Error ? error.message : 'Simulation action failed.')
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  function accept(configuration: SimulationConfiguration) {
    if (!alive.current) return
    setSettings(configuration)
    session.feed.setSimulationOffline(configuration.offline)
    if (!configuration.offline) session.feed.wake()
  }

  async function fault(fault: SimulationFault) {
    await session.api.forceFault(fault)
    if (alive.current)
      setMessage(
        fault === 'read-failure'
          ? 'The next data read will fail once.'
          : fault === 'save-failure'
            ? 'The next user save will fail before commit.'
            : 'The next user save response will be lost after commit.',
      )
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (value) {
          setConfirmReset(false)
          setLoading(true)
          setSettingsReady(false)
          setMessage('')
        }
        setOpen(value)
      }}
    >
      <Dialog.Trigger asChild>
        <Button className={styles.trigger}>Simulation</Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} data-motion="overlay" />
        <Dialog.Content
          className={styles.dialog}
          aria-modal="true"
          data-motion="modal"
          inert={!open}
        >
          <Dialog.Title>Simulation controls</Dialog.Title>
          <Dialog.Description>
            Adjust delays, failures, and teammate activity. Delay and failure settings apply to new
            attempts; offline mode can interrupt current saves. All data stays inside this demo
            session.
          </Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault()
              void perform(async () => {
                const {
                  minSaveDelayMs,
                  maxSaveDelayMs,
                  failureRate,
                  offline,
                  teammatesEnabled,
                  teammateIntervalMs,
                  changeDeliveryPaused,
                } = settings
                accept(
                  await session.api.configure({
                    minSaveDelayMs,
                    maxSaveDelayMs,
                    failureRate,
                    offline,
                    teammatesEnabled,
                    teammateIntervalMs,
                    changeDeliveryPaused,
                  }),
                )
                if (alive.current) setMessage('Simulation settings applied.')
              })
            }}
          >
            <fieldset disabled={busy || loading || !settingsReady}>
              <legend>Save behavior</legend>
              <div className={styles.fields}>
                <label>
                  Minimum save delay (ms)
                  <input
                    type="number"
                    min="0"
                    max="30000"
                    required
                    value={Number.isNaN(settings.minSaveDelayMs) ? '' : settings.minSaveDelayMs}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        minSaveDelayMs: event.target.valueAsNumber,
                      })
                    }
                  />
                </label>
                <label>
                  Maximum save delay (ms)
                  <input
                    type="number"
                    min="0"
                    max="30000"
                    required
                    value={Number.isNaN(settings.maxSaveDelayMs) ? '' : settings.maxSaveDelayMs}
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        maxSaveDelayMs: event.target.valueAsNumber,
                      })
                    }
                  />
                </label>
                <label>
                  Save failure rate (%)
                  <input
                    type="number"
                    min="0"
                    max="100"
                    required
                    value={
                      Number.isNaN(settings.failureRate)
                        ? ''
                        : Math.round(settings.failureRate * 100)
                    }
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        failureRate: event.target.valueAsNumber / 100,
                      })
                    }
                  />
                </label>
                <label>
                  Teammate interval (ms)
                  <input
                    type="number"
                    min="500"
                    max="30000"
                    required
                    value={
                      Number.isNaN(settings.teammateIntervalMs) ? '' : settings.teammateIntervalMs
                    }
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        teammateIntervalMs: event.target.valueAsNumber,
                      })
                    }
                  />
                </label>
              </div>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={settings.teammatesEnabled}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      teammatesEnabled: event.target.checked,
                    })
                  }
                />
                Simulate teammate activity
              </label>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={settings.offline}
                  onChange={(event) => setSettings({ ...settings, offline: event.target.checked })}
                />
                Offline simulation
              </label>
              <label className={styles.toggle}>
                <input
                  type="checkbox"
                  checked={settings.changeDeliveryPaused}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      changeDeliveryPaused: event.target.checked,
                    })
                  }
                />
                Pause change delivery
              </label>
              <Button type="submit">Apply settings</Button>
            </fieldset>
          </form>
          <fieldset disabled={busy || loading}>
            <legend>Repeatable scenarios</legend>
            <div className={styles.actions}>
              <Button onClick={() => void perform(() => fault('save-failure'))}>
                Fail next save
              </Button>
              <Button onClick={() => void perform(() => fault('lost-response'))}>
                Lose next save response
              </Button>
              <Button onClick={() => void perform(() => fault('read-failure'))}>
                Fail next read
              </Button>
            </div>
            <p>
              Last focused deal:{' '}
              <strong>{active?.companyName ?? 'Focus a deal in the table first'}</strong>
            </p>
            <Button
              disabled={!active}
              onClick={() =>
                void perform(async () => {
                  accept(await session.api.configure({ changeDeliveryPaused: true }))
                  const result = await session.api.forceConflict(active!.id)
                  if (result.status !== 'succeeded')
                    throw new Error('The teammate edit lost a race. Try again.')
                  if (alive.current)
                    setMessage(
                      'A teammate changed this deal. Delivery is paused; close this panel and edit its stage to see the conflict.',
                    )
                })
              }
            >
              Create unseen teammate edit
            </Button>
          </fieldset>
          <fieldset disabled={busy || loading}>
            <legend>Start a fresh demo</legend>
            <label>
              Demo seed
              <input
                type="number"
                min="0"
                max="4294967295"
                step="1"
                value={seed}
                onChange={(event) => setSeed(event.target.value)}
              />
            </label>
            {!confirmReset ? (
              <Button onClick={() => setConfirmReset(true)}>Reset demo…</Button>
            ) : (
              <div className={styles.reset}>
                <p>
                  Reset clears saved changes, pending saves, bulk queues, selections, results,
                  filters, and focused-deal state. Old receipts cannot be recovered.
                </p>
                <div className={styles.actions}>
                  <Button ref={cancelResetRef} onClick={() => setConfirmReset(false)}>
                    Cancel reset
                  </Button>
                  <Button
                    onClick={() => {
                      const value = Number(seed)
                      if (
                        !seed.trim() ||
                        !Number.isInteger(value) ||
                        value < 0 ||
                        value > 0xffff_ffff
                      ) {
                        setMessage('Enter a seed from 0 to 4294967295.')
                        return
                      }
                      onReset(value)
                    }}
                  >
                    Confirm reset
                  </Button>
                </div>
              </div>
            )}
          </fieldset>
          <p role="status" aria-live="polite">
            {loading
              ? 'Loading simulation settings…'
              : busy
                ? 'Applying simulation action…'
                : message}
          </p>
          <Dialog.Close asChild>
            <Button variant="primary">Close simulation</Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
