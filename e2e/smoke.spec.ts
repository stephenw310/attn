import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './electron'

const seedThreadCount = 8
const initialUnread = 4

function selectedIndex(page: Page): Promise<number> {
  return page
    .getByTestId('thread-row')
    .evaluateAll((rows) => rows.findIndex((row) => row.hasAttribute('data-selected')))
}

test('boots the built app with an isolated store and working IPC bridge', async ({
  app,
  page,
  userData,
  mainLog
}) => {
  await expect(page).toHaveTitle('Attn')
  await expect(page.getByTestId('login-screen')).toBeVisible()

  const resolvedUserData = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  expect(resolvedUserData).toBe(userData)
  expect(existsSync(join(userData, 'attn.db'))).toBe(true)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible())).toBe(
    process.env.ATTN_E2E_VISIBLE === '1'
  )

  // The teed main.log covers boot-time lines (Playwright consumes early
  // stdout), so the store's open/migrate line is assertable — inside the
  // isolated dir, at a migrated schema version.
  await expect.poll(mainLog).toMatch(/\[log\] \[db\] open at .*attn-e2e-.*attn\.db \(schema v\d+\)/)

  expect(await page.evaluate(() => typeof window.attn?.mail.listThreads)).toBe('function')
  expect(await page.evaluate(() => window.attn.auth.getStatus())).toEqual({
    configured: false,
    signedIn: false
  })
  expect(await page.evaluate(() => window.attn.mail.listThreads('inbox'))).toEqual([])
  expect(await page.evaluate(() => window.attn.mail.getUnreadCount())).toBe(0)
  expect(
    await page.evaluate(() => window.attn.mail.getConversation('no-such-thread', false, 'normal'))
  ).toBeNull()
  expect(await page.evaluate(() => window.attn.sync.getState())).toEqual({ phase: 'idle' })
  expect(mainLog()).not.toContain('[sync] history poller started')
})

test('prevents a file drop from navigating the sandboxed renderer', async ({ app, page }) => {
  const originalUrl = page.url()
  const prevented = await app.evaluate(({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]?.webContents
    if (!contents) return false
    let wasPrevented = false
    contents.emit(
      'will-navigate',
      { preventDefault: () => (wasPrevented = true) } as never,
      'file:///tmp/dropped-attachment.txt'
    )
    return wasPrevented
  })

  expect(prevented).toBe(true)
  expect(page.url()).toBe(originalUrl)
  await expect(page.getByTestId('login-screen')).toBeVisible()
})

test('shows onboarding instead of mock mail while signed out', async ({ page }) => {
  await expect(page.getByTestId('login-screen')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Make space for what matters.' })).toBeVisible()
  await expect(page.getByText('Your inbox, in focus')).toBeVisible()
  await expect(page.getByTestId('login-google')).toContainText('Continue with Google')
  await expect(page.getByTestId('login-google')).toBeDisabled()
  await expect(page.getByTestId('login-setup-message')).toContainText('Google OAuth client')
  await expect(page.getByTestId('thread-row')).toHaveCount(0)
  await expect(page.getByTestId('thread-list')).toHaveCount(0)
  await expect(page.getByTestId('account-menu')).toHaveCount(0)
  await expect(page.getByTestId('footer-shortcuts')).toHaveCount(0)
})

test('leaves the inbox keyboard loop unmounted while signed out', async ({ page }) => {
  await expect(page.getByTestId('login-screen')).toBeVisible()

  // The button carries autoFocus so Enter signs in without a Tab first, but it is
  // disabled in a credential-free run and a disabled control cannot take focus.
  // What is assertable here is that nothing else grabbed it either — the sign-in
  // screen leaves the keyboard alone. Enter-to-sign-in needs an OAuth client and
  // so stays outside the hermetic suite.
  await expect(page.getByTestId('login-google')).toBeDisabled()

  // Inbox shortcuts must not be swallowed by a mail key handler that has no mail
  // to act on: with `Inbox` unmounted there is no window listener to call
  // preventDefault, so every key reaches the page untouched. Before the split this
  // returned every key, because the inbox hook tree mounted behind the login screen.
  const swallowed = await page.evaluate(async () => {
    const seen: string[] = []
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.defaultPrevented) seen.push(e.key)
    }
    window.addEventListener('keydown', onKeyDown)
    document.body.focus()
    for (const key of ['j', 'k', 'e', 'x', 'g', 'c', '#']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
    }
    window.removeEventListener('keydown', onKeyDown)
    return seen
  })
  expect(swallowed).toEqual([])
  await expect(page.getByTestId('composer')).toHaveCount(0)
})

test('captures signed-out onboarding for visual review', async ({ page }, testInfo) => {
  await expect(page.getByTestId('login-screen')).toBeVisible()
  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'login.png')
  await page.screenshot({ path })
  await testInfo.attach('login', { path, contentType: 'image/png' })
})

test.describe('seeded inbox smoke coverage', () => {
  test.use({ seed: 'fixtures/seed-inbox.json' })

  test('groups the list by age and labels the list-context shortcuts', async ({ page }) => {
    // The fixture is day-anchored (`receivedDaysAgo`), so these headers hold on
    // any calendar day — the reason absolute stamps were retired from the seed.
    const now = new Date()
    const oldestMessage = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 40, 7, 30)
    const oldestGroup =
      oldestMessage.getFullYear() === now.getFullYear() && oldestMessage.getMonth() === now.getMonth()
        ? 'Earlier this month'
        : String(oldestMessage.getFullYear())
    await expect(page.getByTestId('thread-date-group')).toHaveText([
      'Today',
      'Yesterday',
      'Last 7 days',
      oldestGroup
    ])
    await expect(page.getByTestId('queue-readout')).toHaveText(`${initialUnread} to zero`)
    await expect(page.getByTestId('pending-count')).toHaveCount(0)
    await expect(page.getByTestId('footer-shortcut-navigate')).toContainText('J/K/↑/↓navigate')
    await expect(page.getByTestId('footer-shortcut-open')).toContainText('Enteropen')
    for (const [id, text] of [
      ['done', 'Edone'],
      ['move', 'Vmove'],
      ['trash', '#trash'],
      ['star', 'Sstar'],
      ['unread', 'Uunread'],
      ['spam', '!spam'],
      ['undo', 'Zundo']
    ]) {
      await expect(page.getByTestId(`footer-shortcut-${id}`)).toContainText(text)
    }
  })

  test('J/K and arrow keys move list selection without opening a conversation', async ({ page }) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(seedThreadCount)
    await expect.poll(() => selectedIndex(page)).toBe(0)

    await page.keyboard.press('j')
    await page.keyboard.press('j')
    await expect.poll(() => selectedIndex(page)).toBe(2)

    await page.keyboard.press('ArrowDown')
    await expect.poll(() => selectedIndex(page)).toBe(3)

    await page.keyboard.press('k')
    await page.keyboard.press('ArrowUp')
    await expect.poll(() => selectedIndex(page)).toBe(1)

    await page.keyboard.press('k')
    await page.keyboard.press('k')
    await expect.poll(() => selectedIndex(page)).toBe(0)
    await expect(page.getByTestId('conversation-view')).toHaveCount(0)
  })

  test('Enter opens the reader; J/K navigates; boundary K, Back, and Esc restore the list', async ({
    page
  }) => {
    const rows = page.getByTestId('thread-row')
    await expect(rows).toHaveCount(seedThreadCount)
    await expect(rows.first()).toHaveAttribute('data-unread', 'true')
    await expect(page.getByTestId('queue-readout')).toHaveText(`${initialUnread} to zero`)

    await page.keyboard.press('Enter')
    await expect(page.getByTestId('conversation-view')).toBeVisible()
    await expect(page.getByTestId('thread-list')).toBeHidden()
    await expect(page.getByTestId('conversation-back')).toHaveText('← Inbox')
    await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')
    await expect(page.getByTestId('conversation-position')).toHaveText(`1 of ${seedThreadCount}`)
    await expect(page.getByTestId('footer-shortcut-navigate')).toContainText('J/Knext conversation')
    await expect(page.getByTestId('footer-shortcut-scroll')).toContainText('↑/↓/Spacescroll')
    await expect(page.getByTestId('footer-shortcut-back')).toContainText('Escback to list')
    await expect(page.getByTestId('footer-shortcut-done')).toContainText('Edone')
    // Pin the whole reader hint set rather than the absence of named hints: this
    // fails on a stray hint too, and cannot go vacuous when an id is renamed.
    await expect
      .poll(() =>
        page
          .getByTestId('footer-shortcuts')
          .evaluate((element) =>
            Array.from(element.querySelectorAll('[data-testid^="footer-shortcut-"]')).map((hint) =>
              hint.getAttribute('data-testid')?.replace('footer-shortcut-', '')
            )
          )
      )
      .toEqual([
        'navigate',
        'scroll',
        'back',
        'select',
        'done',
        'snooze',
        'move',
        'label',
        'trash',
        'star',
        'unread',
        'spam',
        'undo'
      ])
    await expect(page.getByTestId('message-card')).toHaveCount(2)
    await expect(page.getByTestId('message-card').first()).toContainText('Maya Lin')
    await expect(rows.first()).not.toHaveAttribute('data-unread', 'true')
    // Scoped to the count itself: the readout also carries the pending-action
    // suffix once opening a thread queues its mark-read, and a substring match on
    // "3 to zero" would happily match "13 to zero".
    await expect(page.getByTestId('queue-unread')).toHaveText(String(initialUnread - 1))
    await expect(page.getByTestId('pending-count')).toContainText('1 pending')

    await page
      .getByTestId('conversation-content')
      .evaluate((element) => element.style.setProperty('min-height', '4000px'))
    const scroll = page.getByTestId('conversation-scroll')
    await page.keyboard.press('ArrowDown')
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThanOrEqual(120)
    const afterArrow = await scroll.evaluate((element) => element.scrollTop)
    await page.keyboard.press('Space')
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(afterArrow)
    const afterSpace = await scroll.evaluate((element) => element.scrollTop)
    await page.keyboard.press('PageDown')
    await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(afterSpace)
    await expect(page.getByTestId('conversation-position')).toHaveText(`1 of ${seedThreadCount}`)
    await scroll.evaluate((element) => element.scrollTo({ top: 0, behavior: 'instant' }))
    await page
      .getByTestId('conversation-content')
      .evaluate((element) => element.style.removeProperty('min-height'))

    // The second seed thread is already read; the third verifies that navigating
    // the real store marks an unread conversation read on open.
    await expect(rows.nth(2)).toHaveAttribute('data-unread', 'true')
    await page.keyboard.press('j')
    await expect(page.getByTestId('conversation-subject')).toHaveText('Your receipt')
    await expect(page.getByTestId('queue-unread')).toHaveText(String(initialUnread - 1))
    await page.keyboard.press('j')
    await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
    await expect(page.getByTestId('conversation-position')).toHaveText(`3 of ${seedThreadCount}`)
    await expect.poll(() => selectedIndex(page)).toBe(2)
    await expect(rows.nth(2)).not.toHaveAttribute('data-unread', 'true')
    await expect(page.getByTestId('queue-unread')).toHaveText(String(initialUnread - 2))

    await page.keyboard.press('ArrowUp')
    await expect(page.getByTestId('conversation-position')).toHaveText(`3 of ${seedThreadCount}`)
    await page.keyboard.press('k')
    await page.keyboard.press('k')
    await expect(page.getByTestId('conversation-position')).toHaveText(`1 of ${seedThreadCount}`)
    await page.keyboard.press('k')
    await expect(page.getByTestId('conversation-view')).toHaveCount(0)
    await expect(page.getByTestId('thread-list')).toBeVisible()
    await expect.poll(() => selectedIndex(page)).toBe(0)

    await page.keyboard.press('Enter')
    await page.getByTestId('conversation-back').click()
    await expect(page.getByTestId('conversation-view')).toHaveCount(0)
    await expect(page.getByTestId('thread-list')).toBeVisible()
    await expect.poll(() => selectedIndex(page)).toBe(0)

    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('conversation-view')).toHaveCount(0)
    await expect(page.getByTestId('thread-list')).toBeVisible()
    await expect.poll(() => selectedIndex(page)).toBe(0)
  })

  test('restores list scroll on reader exit, and follows a cursor moved by J/K', async ({ app, page }) => {
    // Clamped up to the window's 600px minimum height; the point is a short window.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setContentSize(1200, 600))
    await expect.poll(() => page.evaluate(() => window.innerHeight)).toBeLessThan(700)
    const list = page.getByTestId('thread-list')
    // The window has a 600px minimum height and the real-store fixture is eight
    // rows, which fits without overflowing. Inflate the rows instead of scrolling
    // by hand, so reaching the end of the list is what produces the scroll — the
    // behaviour under test — rather than a scrollTop the test set itself.
    //
    // Wait for the seeded rows first: J/K clamps to the last index, so pressing
    // ahead of the store's first render silently walks a one-row list and leaves
    // the cursor — and the scroll — at the top.
    await expect(page.getByTestId('thread-row')).toHaveCount(seedThreadCount)
    await page.addStyleTag({ content: '[data-testid="thread-row"] { min-height: 120px; }' })
    for (let index = 1; index < seedThreadCount; index++) await page.keyboard.press('j')
    await expect.poll(() => selectedIndex(page)).toBe(seedThreadCount - 1)
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
    const before = await list.evaluate((element) => element.scrollTop)
    const selectedBefore = await selectedIndex(page)
    expect(selectedBefore).toBeGreaterThan(0)

    // Reading without navigating must land back on the exact same offset.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('conversation-view')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(list).toBeVisible()
    await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(before)
    await expect.poll(() => selectedIndex(page)).toBe(selectedBefore)

    // Navigating inside the reader moves the cursor while the list is
    // display:none and cannot scroll — returning has to bring it back into view.
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('conversation-view')).toBeVisible()
    for (let index = selectedBefore; index > 0; index--) await page.keyboard.press('k')
    await expect(page.getByTestId('conversation-position')).toHaveText(`1 of ${seedThreadCount}`)
    await page.keyboard.press('Escape')

    await expect(list).toBeVisible()
    await expect.poll(() => selectedIndex(page)).toBe(0)
    await expect
      .poll(async () => {
        const viewport = await list.boundingBox()
        const row = await page.getByTestId('thread-row').first().boundingBox()
        if (!viewport || !row) return false
        return row.y >= viewport.y - 1 && row.y + row.height <= viewport.y + viewport.height + 1
      })
      .toBe(true)
  })

  test('captures the Dispatch inbox for visual review', async ({ page }, testInfo) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(seedThreadCount)
    const dir = join(__dirname, '.artifacts')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'inbox.png')
    await page.screenshot({ path })
    await testInfo.attach('inbox', { path, contentType: 'image/png' })
  })
})
