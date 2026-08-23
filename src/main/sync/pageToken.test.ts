import { describe, expect, it } from 'vitest'
import { GmailApiError } from '../gmail/client'
import { isExpiredPageTokenError } from './pageToken'

describe('expired page-token errors', () => {
  it.each([
    new GmailApiError(400, 'invalid pageToken'),
    new GmailApiError(404, 'requested page token was not found'),
    new GmailApiError(400, 'gmail failed: {"error":{"location":"page_token"}}')
  ])('accepts a token-specific Gmail diagnostic', (error) => {
    expect(isExpiredPageTokenError(error)).toBe(true)
  })

  it.each([
    new GmailApiError(400, 'invalid labelIds argument'),
    new GmailApiError(404, 'thread was not found'),
    new GmailApiError(500, 'pageToken failed'),
    new Error('invalid page token')
  ])('rejects an unrelated error', (error) => {
    expect(isExpiredPageTokenError(error)).toBe(false)
  })
})
