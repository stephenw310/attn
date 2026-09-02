// Windows owns a fixed 16px taskbar-overlay slot. A single conventional dot
// stays legible there; an exact count does not. Keep the exact unread count in
// the overlay description while every positive count reuses this 32px @2x PNG.
// PNG deliberately avoids nativeImage.createFromBitmap's platform-dependent
// raw channel order (the former RGBA numeral rendered red as blue on Windows).

const WINDOWS_UNREAD_DOT_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAFiSURBVFhH7ZYhTwQxEIVPIpG4JWEGZLskJOfgJyCRSCQSeQ55EolE3k9AIjEXtsWsPIlEQmY5ktvXLrvtzSWI/ZLndua10850J5ORkUzeTmlamaOLTeE36ojpu6VHZ/nDW/5COcufztKTM8eXGLsVy7PiwFtaoGGPnr1hi7mSkV17y6uIQa+kIr7kK8w5GDlXTJqlnEVU5uQwd+eophKpx5Fx5n/KWXpFj07USg+qDF+jVxRpJQxW0gt6BdTnxV5zZmGwiuRuoWeLddsFgWrq6wiZYkGQopyhW/RsUZV0g0GqMjxDzxZSoiBIUc7SHXq22FUL/qq3FWtT7GOQqoZMxOYlw0AVUY1eUXZ2EUu+R69OZHYHCbbTSoYc+nSifRl7L18MGRqYKFNzzD0Y6dtIwhQ9YM5k1seR9HMiP65ymTFXNj+vpFSDajQDyULnMk8whxoyTJrFGJ5tSl5S/Hbk3/MNoJcCB+1C0rwAAAAASUVORK5CYII='

let windowsUnreadDotPng: Buffer | null = null

/** Zero clears the overlay; every positive unread count shows the same dot. */
export function badgeOverlayPng(unreadCount: number): Buffer | null {
  if (!Number.isFinite(unreadCount) || unreadCount <= 0) return null
  windowsUnreadDotPng ??= Buffer.from(WINDOWS_UNREAD_DOT_PNG_BASE64, 'base64')
  return windowsUnreadDotPng
}
