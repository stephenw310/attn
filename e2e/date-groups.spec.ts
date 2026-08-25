import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-year-groups.json' })

function yearForDaysAgo(days: number, hours: number, minutes: number): string {
  const now = new Date()
  return String(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() - days, hours, minutes).getFullYear()
  )
}

test('separates old Starred mail under calendar-year headings', async ({ page }) => {
  await page.getByTestId('sidebar-mailbox').filter({ hasText: 'Starred' }).click()

  await expect(page.getByTestId('mailbox-title')).toHaveText('Starred')
  await expect(page.getByTestId('thread-row')).toHaveCount(3)
  await expect(page.getByTestId('thread-date-group')).toHaveText([
    'Yesterday',
    yearForDaysAgo(400, 10, 10),
    yearForDaysAgo(800, 8, 5)
  ])
})
