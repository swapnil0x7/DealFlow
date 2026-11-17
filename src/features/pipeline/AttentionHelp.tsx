import { InfoTooltip } from '../../shared/ui/InfoTooltip'
import styles from './Pipeline.module.css'

export function AttentionHelp() {
  return (
    <InfoTooltip label="How attention works">
      <strong className={styles.helpTitle}>Clear reasons. No hidden scores.</strong>
      <ul className={styles.helpRules}>
        <li>
          <span>14 days</span>
          <div>
            <strong>Inactive negotiations</strong>
            <p>Highest urgency when customer activity goes quiet.</p>
          </div>
        </li>
        <li>
          <span>2 days</span>
          <div>
            <strong>Waiting new leads</strong>
            <p>Leads that have waited since creation rank next.</p>
          </div>
        </li>
        <li>
          <span>7 days</span>
          <div>
            <strong>Other inactive deals</strong>
            <p>Open deals without recent customer activity.</p>
          </div>
        </li>
      </ul>
      <p className={styles.helpNote}>
        Won and Lost deals are excluded. We count whole elapsed days and use the creation date when
        activity is missing.
      </p>
      <p className={styles.helpNote}>
        Ties use oldest activity, highest value, then deal ID. Needs attention starts sorted by
        priority; column headers let you change it.
      </p>
      <p className={styles.helpNote}>
        Attention updates automatically. If priorities would move the list while you work, you
        choose when to refresh.
      </p>
    </InfoTooltip>
  )
}
