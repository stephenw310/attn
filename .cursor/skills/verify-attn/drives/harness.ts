import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page, TestInfo } from '@playwright/test'
import { expect } from '../../../../e2e/electron'

export const REPO_ROOT = join(__dirname, '../../../..')
export const RUN_ID = process.env.ATTN_VERIFY_RUN
if (!RUN_ID) throw new Error('ATTN_VERIFY_RUN is unset. Run drives through scripts/drive.mjs.')
export const EVIDENCE_ROOT = join(REPO_ROOT, 'e2e/.artifacts/verify-attn', RUN_ID)

export function evidenceDir(testInfo: TestInfo): string {
  const slug = testInfo.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
  const dir = join(EVIDENCE_ROOT, slug)
  mkdirSync(dir, { recursive: true })
  return dir
}

export async function snap(page: Page, testInfo: TestInfo, name: string): Promise<string> {
  const path = join(evidenceDir(testInfo), `${name}.png`)
  await page.screenshot({ path })
  return path
}

export function record(testInfo: TestInfo, name: string, body: unknown): string {
  const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
  const path = join(evidenceDir(testInfo), name)
  writeFileSync(path, text)
  return path
}

/**
 * The live-instance doctor. Confirms the app under test runs against the
 * throwaway profile this drive owns and opened its own SQLite store there, so
 * nothing below can touch a developer's real mailbox.
 */
export async function assertIsolated(
  app: ElectronApplication,
  userData: string,
  mainLog: () => string
): Promise<void> {
  const resolved = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'))
  expect(resolved).toBe(userData)
  await expect.poll(mainLog).toMatch(/\[db\] open at .*attn-e2e-.*attn\.db \(schema v\d+\)/)
}
