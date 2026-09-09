const paths = {
  inbox: 'M3 4h18v16H3z M3 13h5l2 3h4l2-3h5',
  starred: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9Z',
  snoozed: 'M12 7v5l3 2 M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  drafts: 'M5 3h9l5 5v13H5z M14 3v6h5 M8 13h8 M8 17h5',
  sent: 'm3 10 18-7-7 18-3-8Z M11 13 21 3',
  allMail: 'M4 7h16v14H4z M3 3h18v4H3z M9 11h6',
  spam: 'm8 3-5 5v8l5 5h8l5-5V8l-5-5Z M12 7v6 M12 17v.1',
  trash: 'M3 6h18 M9 3h6 M6 6l1 15h10l1-15 M10 10v7 M14 10v7',
  outbox: 'M4 14v7h16v-7 M12 16V3 M7 8l5-5 5 5',
  write: 'm4 16 12-12 4 4L8 20l-5 1Z M14 6l4 4',
  attachment: 'm8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9 M6 15l8-8',
  keyboard: 'M3 5h18v14H3z M7 9h.1 M11 9h.1 M15 9h.1 M18 9h.1 M7 12h.1 M11 12h.1 M15 12h.1 M7 16h10'
} as const

export function MailIcon({ name }: { name: keyof typeof paths }): React.JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-4 flex-none fill-none stroke-current"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  )
}
