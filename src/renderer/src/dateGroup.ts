export type DateGroup = 'Today' | 'Yesterday' | 'Last 7 days' | 'Earlier this month' | 'Older'

export function dateGroup(thread: { lastMsgAt?: number; at: string }, now = new Date()): DateGroup {
  if (thread.lastMsgAt) {
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
    return 'Older'
  }
  if (/\d{1,2}:\d{2}/.test(thread.at)) return 'Today'
  if (thread.at === 'Yesterday') return 'Yesterday'
  if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/.test(thread.at)) return 'Last 7 days'
  return 'Earlier this month'
}
