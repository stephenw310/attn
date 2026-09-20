// The sample inbox on the landing page. It copies four Attn shortcuts: J, K, E, and Z.
const CONVERSATIONS = [
  {
    id: 'c1',
    sender: 'Maya Lin',
    subject: 'Q3 roadmap review',
    snippet: 'I added the launch milestones.',
    time: '10:12 AM',
    unread: true
  },
  {
    id: 'c2',
    sender: 'Northstar Books',
    subject: 'Your receipt',
    snippet: 'Thanks for your order.',
    time: '8:55 AM'
  },
  {
    id: 'c3',
    sender: 'Theo Park',
    subject: 'Design notes',
    snippet: 'A few thoughts on the overlay.',
    time: 'Yesterday',
    unread: true
  },
  {
    id: 'c4',
    sender: 'Amara Singh',
    subject: 'Lunch next week',
    snippet: 'Tuesday works for me.',
    time: 'Yesterday'
  },
  {
    id: 'c5',
    sender: 'Finance Team',
    subject: 'August budget',
    snippet: 'Please review by Friday.',
    time: 'Wed',
    unread: true
  },
  {
    id: 'c6',
    sender: 'Travel Desk',
    subject: 'Flight options',
    snippet: 'Three routes are available.',
    time: 'Mon'
  }
]

const LEAVE_MS = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 170

const list = document.getElementById('demo-list')
const empty = document.getElementById('demo-empty')
const status = document.getElementById('demo-status')
const count = document.querySelector('[data-demo-count]')
const buttons = new Map(
  [...document.querySelectorAll('[data-demo-key]')].map((button) => [button.dataset.demoKey, button])
)

const inbox = [...CONVERSATIONS]
let selectedId = inbox[0].id
const done = []
let leaving = false

function span(className, text) {
  const node = document.createElement('span')
  node.className = className
  node.textContent = text
  return node
}

function row(conversation) {
  const item = document.createElement('div')
  item.className = 'demo-row'
  item.id = `demo-${conversation.id}`
  item.setAttribute('role', 'option')
  item.setAttribute('aria-selected', String(conversation.id === selectedId))
  if (conversation.unread) item.dataset.unread = ''
  const text = span('demo-text', '')
  text.append(span('demo-subject', conversation.subject), span('demo-snippet', conversation.snippet))
  item.append(
    span('demo-dot', ''),
    span('demo-sender', conversation.sender),
    text,
    span('demo-time', conversation.time)
  )
  item.addEventListener('click', () => {
    selectedId = conversation.id
    render()
  })
  return item
}

function render() {
  list.replaceChildren(...inbox.map(row))
  list.hidden = inbox.length === 0
  empty.hidden = inbox.length > 0
  if (inbox.length > 0) list.setAttribute('aria-activedescendant', `demo-${selectedId}`)
  else list.removeAttribute('aria-activedescendant')
  count.textContent = inbox.length > 0 ? String(inbox.length) : ''
  for (const key of ['j', 'k', 'e']) buttons.get(key).disabled = inbox.length === 0
  buttons.get('z').disabled = done.length === 0
}

function move(step) {
  const index = inbox.findIndex((conversation) => conversation.id === selectedId)
  const next = inbox[Math.min(inbox.length - 1, Math.max(0, index + step))]
  if (!next) return
  selectedId = next.id
  render()
}

function markDone() {
  const index = inbox.findIndex((conversation) => conversation.id === selectedId)
  if (index < 0 || leaving) return
  const conversation = inbox[index]
  leaving = true
  document.getElementById(`demo-${conversation.id}`).dataset.leaving = ''
  window.setTimeout(() => {
    leaving = false
    inbox.splice(index, 1)
    done.push({ conversation, index })
    selectedId = (inbox[index] ?? inbox[index - 1])?.id
    status.textContent = `Marked done: ${conversation.subject}. Press Z to undo.`
    render()
  }, LEAVE_MS)
}

function undo() {
  const last = done.pop()
  if (!last) return
  inbox.splice(last.index, 0, last.conversation)
  selectedId = last.conversation.id
  status.textContent = `Returned to the inbox: ${last.conversation.subject}.`
  render()
}

const ACTIONS = { j: () => move(1), k: () => move(-1), e: markDone, z: undo }

document.addEventListener('keydown', (event) => {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select')) return
  const action = ACTIONS[event.key.toLowerCase()]
  if (!action) return
  event.preventDefault()
  action()
})

for (const [key, button] of buttons) button.addEventListener('click', () => ACTIONS[key]())

render()
