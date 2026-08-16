import { describe, expect, it } from 'vitest'
import { formatActionRevertToast, type RevertedAction } from './actionRevert'

function reverted(kind: RevertedAction['kind'], subject: string): RevertedAction {
  return {
    threadId: subject,
    kind,
    subject,
    returnedToInbox: kind === 'archive',
    resolution: 'restored'
  }
}

describe('failed-action toast batching', () => {
  it('explains a single archive returning to the inbox', () => {
    expect(formatActionRevertToast([reverted('archive', 'Q3 roadmap review')])).toBe(
      "Couldn't archive 'Q3 roadmap review' — it's back in your inbox."
    )
  })

  it('batches several archive failures into one notice', () => {
    expect(
      formatActionRevertToast([
        reverted('archive', 'One'),
        reverted('archive', 'Two'),
        reverted('archive', 'Three')
      ])
    ).toBe("Couldn't archive 3 conversations — they're back in your inbox.")
  })

  it('uses a truthful generic notice for mixed actions', () => {
    expect(formatActionRevertToast([reverted('star', 'One'), reverted('trash', 'Two')])).toBe(
      "Couldn't complete 2 mail actions — Gmail's versions were restored."
    )
  })

  it('does not claim restoration when the authoritative refetch is unavailable', () => {
    expect(formatActionRevertToast([{ ...reverted('unsnooze', 'Roadmap'), resolution: 'unavailable' }])).toBe(
      "Couldn't unsnooze 'Roadmap', and Gmail's current version couldn't be loaded. The cached copy was kept."
    )
  })
})
