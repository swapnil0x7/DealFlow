import { Button } from '../../shared/ui/Button'
import type { Deal, Stage } from '../../domain/deal'
import { STAGE_LABELS } from '../../domain/deal'
import styles from './Changes.module.css'

interface ConflictReviewProps {
  previousStage: Stage
  expectedVersion: number
  intendedStage: Stage
  reviewed: Deal
  latest: Deal
  disabled: boolean
  onReviewLatest: () => void
  onKeep: () => void
  onApply: () => void
}

export function ConflictReview({
  previousStage,
  expectedVersion,
  intendedStage,
  reviewed,
  latest,
  disabled,
  onReviewLatest,
  onKeep,
  onApply,
}: ConflictReviewProps) {
  const changedAgain = latest.version !== reviewed.version
  return (
    <section aria-label="Compare stage changes" className={styles.review}>
      <p>
        This deal changed while you were editing. Compare the saved stage with your requested
        change.
      </p>
      <dl className={styles.comparison}>
        <div>
          <dt>Previously shown</dt>
          <dd>
            {STAGE_LABELS[previousStage]} <small>(version {expectedVersion})</small>
          </dd>
        </div>
        <div>
          <dt>{changedAgain ? 'Previously reviewed saved stage' : 'Latest saved stage'}</dt>
          <dd>
            {STAGE_LABELS[reviewed.stage]} <small>(version {reviewed.version})</small>
          </dd>
        </div>
        <div className={styles.intention}>
          <dt>Your requested stage</dt>
          <dd>{STAGE_LABELS[intendedStage]}</dd>
        </div>
      </dl>
      {changedAgain && (
        <div className={styles.warning} role="status">
          <strong>This deal changed again.</strong> The latest saved stage is{' '}
          {STAGE_LABELS[latest.stage]}. Review it before choosing an action.
          <Button onClick={onReviewLatest}>Review latest stage</Button>
        </div>
      )}
      <p className={styles.hint}>
        Closing this panel leaves the conflict available in Changes. Every submitted change checks
        the version you reviewed.
      </p>
      <div className={styles.reviewActions}>
        <Button disabled={disabled || changedAgain} onClick={onKeep}>
          Keep {STAGE_LABELS[reviewed.stage]}
        </Button>
        <Button className={styles.primary} disabled={disabled || changedAgain} onClick={onApply}>
          Move to {STAGE_LABELS[intendedStage]}
        </Button>
      </div>
    </section>
  )
}
