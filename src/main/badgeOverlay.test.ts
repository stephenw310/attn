import { expect, it } from 'vitest'
import { badgeOverlayPng } from './badgeOverlay'

it('clears at zero and reuses one valid 32px PNG for every positive count', () => {
  expect(badgeOverlayPng(0)).toBeNull()
  expect(badgeOverlayPng(-3)).toBeNull()
  expect(badgeOverlayPng(Number.NaN)).toBeNull()

  const one = badgeOverlayPng(1)
  const many = badgeOverlayPng(1_500)
  expect(one).toBe(many)
  expect(one?.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  // PNG IHDR stores width then height as big-endian uint32 values.
  expect(one?.readUInt32BE(16)).toBe(32)
  expect(one?.readUInt32BE(20)).toBe(32)
})
