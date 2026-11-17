/** Shared workflow states, independent of either single or bulk orchestration. */
export type ItemState =
  | 'queued'
  | 'saving'
  | 'succeeded'
  | 'failed'
  | 'conflicted'
  | 'unconfirmed'
  | 'skipped'
