type RelativeDateGroup = 'Today' | 'Yesterday' | 'Last 7 days' | 'Earlier this month'
type YearDateGroup = `${number}`

export type DateGroup = RelativeDateGroup | YearDateGroup

export function dateGroup(thread: { lastMsgAt: number }, now = new Date()): DateGroup {
  const messageDate = new Date(thread.lastMsgAt)
  const startOfDay = (date: Date): number =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const dayDiff = Math.floor((startOfDay(now) - startOfDay(messageDate)) / 86_400_000)
  if (dayDiff <= 0) return 'Today'
  if (dayDiff === 1) return 'Yesterday'
  if (dayDiff < 7) return 'Last 7 days'
  if (messageDate.getFullYear() === now.getFullYear() && messageDate.getMonth() === now.getMonth()) {
    return 'Earlier this month'
  }
  return String(messageDate.getFullYear()) as YearDateGroup
}
