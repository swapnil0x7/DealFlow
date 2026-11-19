import { Button } from '../../shared/ui/Button'
import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useStore } from 'zustand'
import { STAGE_LABELS } from '../../domain/deal'
import { formatCount, formatMoney } from '../../shared/format'
import { usePreparation } from '../../shared/use-preparation'
import { useExitSnapshot } from '../../shared/use-exit-snapshot'
import type { BulkPreview } from './types'
import type { BulkService } from './service'
import styles from './Bulk.module.css'

export function BulkReview({
  preview: livePreview,
  service,
  onClose,
  trigger,
  fallback,
  restoreFocus,
  onSubmitted,
}: {
  preview: BulkPreview | null
  service: BulkService
  onClose: () => void
  trigger?: RefObject<HTMLElement | null>
  fallback?: RefObject<HTMLElement | null>
  restoreFocus?: () => HTMLElement | null
  onSubmitted?: (id: string) => void
}) {
  const preparation = usePreparation()
  const { cancel } = preparation
  useEffect(() => () => cancel(), [livePreview, cancel])
  const expired = useStore(service.store, (state) => state.expired)
  const notice = useStore(service.store, (state) => state.notice)
  const content = useRef<HTMLDivElement>(null)
  const [preview, release] = useExitSnapshot(livePreview)
  const setContent = useCallback(
    (element: HTMLDivElement | null) => {
      content.current = element
      if (!element)
        queueMicrotask(() => {
          if (!content.current) release()
        })
    },
    [release],
  )
  return (
    <Dialog.Root
      open={Boolean(livePreview)}
      onOpenChange={(open) => {
        if (!open) {
          preparation.cancel()
          onClose()
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} data-motion="overlay" />
        <Dialog.Content
          aria-modal="true"
          ref={setContent}
          data-motion="modal"
          inert={!livePreview}
          className={styles.dialog}
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            ;(
              restoreFocus?.() ??
              (trigger?.current?.isConnected ? trigger.current : fallback?.current)
            )?.focus({ preventScroll: true })
          }}
        >
          <Dialog.Title>
            {preview?.kind === 'undo' ? 'Review bulk Undo' : 'Review bulk stage change'}
          </Dialog.Title>
          <Dialog.Description>
            Confirm the fixed membership and reviewed versions below. Closing this dialog makes no
            changes.
          </Dialog.Description>
          {preview && (
            <>
              <dl className={styles.reviewFacts}>
                <dt>Selected deals</dt>
                <dd>{formatCount(preview.items.length)}</dd>
                <dt>Source</dt>
                <dd>{preview.source}</dd>
                <dt>Target stage</dt>
                <dd>
                  {preview.target ? STAGE_LABELS[preview.target] : 'Each deal’s previous stage'}
                </dd>
                <dt>Total reviewed value</dt>
                <dd>{formatMoney(preview.totalValuePaise)}</dd>
                <dt>Changed since selection</dt>
                <dd>{formatCount(preview.changed)} — original version guards retained</dd>
                <dt>Already pending</dt>
                <dd>{formatCount(preview.pending)} — will be skipped</dd>
                <dt>Already in target stage</dt>
                <dd>{formatCount(preview.noops)} — no change needed</dd>
                {preview.excluded > 0 && (
                  <>
                    <dt>Successes excluded from Undo</dt>
                    <dd>
                      {formatCount(preview.excluded)} — changed, pending, or already linked to Undo
                    </dd>
                  </>
                )}
              </dl>
              <p>
                Every command uses the version captured for this review. Later matches will not
                join. A newly pending local save will be reported as skipped.
              </p>
              {preview.changed > 0 && (
                <p>
                  Changed records will use their original selection versions and may conflict.
                  Review those results individually before accepting a newer version.
                </p>
              )}
              <details>
                <summary>Inspect captured commands</summary>
                <ul className={styles.previewItems}>
                  {preview.items.slice(0, 20).map((item) => (
                    <li key={item.command.mutationId}>
                      {item.companyName}: {STAGE_LABELS[item.previousStage]} →{' '}
                      {STAGE_LABELS[item.command.stage]} (version {item.command.expectedVersion})
                      {item.skipReason && ` · ${item.skipReason}`}
                    </li>
                  ))}
                </ul>
                {preview.items.length > 20 && (
                  <p>
                    First 20 of {formatCount(preview.items.length)} captured commands. Every item
                    will be inspectable in the operation results.
                  </p>
                )}
              </details>
              {notice && <p role="alert">{notice}</p>}
              {preparation.busy && (
                <p role="status">
                  Preparing commands… No changes are sent until preparation finishes.
                </p>
              )}
              {preparation.error && <p role="alert">{preparation.error}</p>}
              <div className={styles.actions}>
                <Dialog.Close asChild>
                  <Button>Cancel bulk review</Button>
                </Dialog.Close>
                <Button
                  disabled={expired || !livePreview}
                  aria-disabled={expired || !livePreview || preparation.busy}
                  onClick={() => {
                    if (preparation.busy) return
                    void preparation
                      .run((signal) => service.prepareSubmit(preview, signal))
                      .then((id) => {
                        if (id) {
                          onClose()
                          onSubmitted?.(id)
                        } else if (!preparation.busy) content.current?.focus()
                      })
                  }}
                >
                  {preview.kind === 'undo' ? 'Confirm bulk Undo' : 'Confirm bulk move'}
                </Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
