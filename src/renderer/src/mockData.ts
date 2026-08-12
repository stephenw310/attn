import type { ConversationView, ThreadSummary } from './types'

// Static mock inbox so the M0 list/reader/keyboard loop is testable
// before Gmail sync exists. Replaced wholesale by the local store at M0-final.

export const mockThreads: ThreadSummary[] = [
  {
    id: 't1',
    from: 'Maya Lin',
    subject: 'Q3 roadmap review — moved to Thursday',
    snippet: 'Heads up: moving our roadmap review to Thursday 2pm so Priya can join. Agenda attached…',
    at: '9:41 AM',
    unread: true,
    hasAttachment: true
  },
  {
    id: 't2',
    from: 'GitHub',
    subject: '[attn] PR #14: Sync engine backfill pagination',
    snippet:
      'chao-wu requested your review on: Implement threads.list pagination with historyId checkpointing…',
    at: '9:12 AM',
    unread: true
  },
  {
    id: 't3',
    from: 'Stripe',
    subject: 'Your invoice from Acme Cloud is available',
    snippet: 'Invoice #A-2041 for $48.00 is now available. Payment is scheduled for Aug 12…',
    at: '8:55 AM',
    unread: true
  },
  {
    id: 't4',
    from: 'Daniel Okafor',
    subject: 'Re: Coffee next week?',
    snippet: "Tuesday works great. There's a new place on Valencia I've been meaning to try — 10am?",
    at: '8:20 AM',
    unread: false,
    starred: true
  },
  {
    id: 't5',
    from: 'Linear',
    subject: 'Weekly digest: 12 issues completed',
    snippet: 'Your team closed 12 issues this week. Top project: Sync Engine (7 issues)…',
    at: 'Yesterday',
    unread: false
  },
  {
    id: 't6',
    from: 'Priya Raman',
    subject: 'Design tokens for the reading pane',
    snippet:
      'I pushed the first pass of spacing/typography tokens. Two open questions on message card density…',
    at: 'Yesterday',
    unread: true
  },
  {
    id: 't7',
    from: 'Anthropic',
    subject: 'Your API usage summary for July',
    snippet: 'Your organization used 2.1M tokens in July. View the full breakdown in the console…',
    at: 'Yesterday',
    unread: false
  },
  {
    id: 't8',
    from: 'Ken Watanabe',
    subject: 'Fwd: Conference talk proposal deadline',
    snippet:
      'Forwarding in case you missed it — CFP closes Friday. Your local-first sync talk would be perfect…',
    at: 'Yesterday',
    unread: false
  },
  {
    id: 't9',
    from: 'The Pragmatic Engineer',
    subject: 'The Pulse #147: Desktop apps are back',
    snippet:
      'A look at why high-performance desktop email clients and local-first software are having a moment…',
    at: 'Wed',
    unread: false
  },
  {
    id: 't10',
    from: 'Elena Volkov',
    subject: 'Re: Re: Apartment lease renewal',
    snippet: 'The landlord confirmed the renewal terms. Same rent through next June if we sign by the 20th…',
    at: 'Wed',
    unread: false
  },
  {
    id: 't11',
    from: 'Google Cloud',
    subject: 'Reminder: OAuth consent screen in Testing mode',
    snippet: 'Your app attn-dev is in Testing mode. Refresh tokens for test users expire after 7 days…',
    at: 'Wed',
    unread: false
  },
  {
    id: 't12',
    from: 'Sam Torres',
    subject: 'Benchmark results: FTS5 on 50k messages',
    snippet: 'Ran the numbers on my machine: p50 11ms, p95 63ms with the trigram tokenizer. Details inline…',
    at: 'Tue',
    unread: false,
    starred: true
  },
  {
    id: 't13',
    from: 'Notion',
    subject: 'Comments on "M1 triage-loop spec"',
    snippet:
      'Maya Lin mentioned you: "@chao should undo restore selection position too, or just the thread state?"…',
    at: 'Tue',
    unread: false
  },
  {
    id: 't14',
    from: 'Aunt Rosa',
    subject: 'Photos from the lake house 🏞️',
    snippet:
      'Finally uploaded everything from last month. The one of you falling off the paddleboard is framed…',
    at: 'Mon',
    unread: false,
    hasAttachment: true
  },
  {
    id: 't15',
    from: 'Vercel',
    subject: 'Deployment failed: docs-site (main)',
    snippet: 'Build failed with exit code 1: Cannot find module "@/components/nav". View build logs…',
    at: 'Mon',
    unread: false
  },
  {
    id: 't16',
    from: 'Jess Nakamura',
    subject: 'Intro: Chao <> Felix (local-first sync)',
    snippet:
      "Chao, meet Felix — he's been building CRDT tooling for two years and would love to compare notes…",
    at: 'Mon',
    unread: false
  },
  {
    id: 't17',
    from: 'Hacker News Digest',
    subject: 'Top stories: SQLite as an application file format',
    snippet: 'Also: Why keyboard latency matters more than you think; Electron 43 release notes…',
    at: 'Aug 2',
    unread: false
  },
  {
    id: 't18',
    from: 'Dr. Chen’s Office',
    subject: 'Appointment confirmation — Aug 15, 3:30 PM',
    snippet: 'This confirms your appointment on Friday, Aug 15 at 3:30 PM. Reply CHANGE to reschedule…',
    at: 'Aug 2',
    unread: false
  },
  {
    id: 't19',
    from: 'Marco Bianchi',
    subject: 'Re: Splitting the sync reducer',
    snippet:
      'Agree on the single-reducer approach. Server events and optimistic actions through one code path…',
    at: 'Aug 1',
    unread: false
  },
  {
    id: 't20',
    from: '1Password',
    subject: 'New sign-in to your account from macOS',
    snippet: 'We noticed a new sign-in on a Mac in San Francisco, CA. If this was you, no action is needed…',
    at: 'Aug 1',
    unread: false
  }
]

const conversationBodies: Record<string, ConversationView> = {
  t1: {
    threadId: 't1',
    subject: 'Q3 roadmap review — moved to Thursday',
    messages: [
      {
        id: 't1m1',
        fromName: 'Maya Lin',
        fromEmail: 'maya@acme.dev',
        to: 'you',
        at: 'Today, 9:41 AM',
        body: [
          'Heads up: moving our roadmap review to Thursday 2pm so Priya can join from the Berlin office.',
          'Agenda attached — mostly unchanged, but I added a section at the end on the sync-engine milestone and what "daily-drivable" means for the beta group.',
          'If Thursday doesn’t work, grab any slot on my calendar Friday morning.'
        ]
      }
    ]
  },
  t2: {
    threadId: 't2',
    subject: '[attn] PR #14: Sync engine backfill pagination',
    messages: [
      {
        id: 't2m1',
        fromName: 'GitHub',
        fromEmail: 'notifications@github.com',
        to: 'you',
        at: 'Today, 9:12 AM',
        body: [
          'chao-wu requested your review on: attn#14 — Implement threads.list pagination with historyId checkpointing.',
          '“This adds cursor persistence to sync_state so a killed backfill resumes instead of restarting. Also batches metadata fetches 50-per-request to stay inside quota.”',
          '1 approval required · 14 files changed, +612 −88'
        ]
      }
    ]
  },
  t4: {
    threadId: 't4',
    subject: 'Re: Coffee next week?',
    messages: [
      {
        id: 't4m1',
        fromName: 'You',
        fromEmail: 'magicchao1989@gmail.com',
        to: 'Daniel Okafor',
        at: 'Yesterday, 4:02 PM',
        body: ['Long overdue! I’m free Tuesday or Wednesday morning next week — your side of town this time.']
      },
      {
        id: 't4m2',
        fromName: 'Daniel Okafor',
        fromEmail: 'daniel.okafor@gmail.com',
        to: 'you',
        at: 'Today, 8:20 AM',
        body: [
          'Tuesday works great. There’s a new place on Valencia I’ve been meaning to try — 10am?',
          'And bring the laptop, I want to see this email client thing you keep talking about.'
        ]
      }
    ]
  },
  t6: {
    threadId: 't6',
    subject: 'Design tokens for the reading pane',
    messages: [
      {
        id: 't6m1',
        fromName: 'Priya Raman',
        fromEmail: 'priya@acme.dev',
        to: 'you',
        at: 'Yesterday, 2:17 PM',
        body: [
          'I pushed the first pass of spacing/typography tokens for the reading pane.',
          'Two open questions: (1) message card density — compact vs comfortable as the default? (2) do quoted trails collapse to one line or three?',
          'My vote is comfortable + one line, matching the “one clear focus” principle.'
        ]
      }
    ]
  },
  t12: {
    threadId: 't12',
    subject: 'Benchmark results: FTS5 on 50k messages',
    messages: [
      {
        id: 't12m1',
        fromName: 'Sam Torres',
        fromEmail: 'sam.torres@fastmail.com',
        to: 'you',
        at: 'Tue, 11:03 AM',
        body: [
          'Ran the numbers on my machine (M2 Air): p50 11ms, p95 63ms on 50k messages with the trigram tokenizer.',
          'The p95 outliers are all queries with two operators plus a phrase — still well inside your 100ms budget.',
          'Happy to rerun on spinning rust if you want a worst-case floor.'
        ]
      }
    ]
  }
}

const genericBody = (t: ThreadSummary): ConversationView => ({
  threadId: t.id,
  subject: t.subject,
  messages: [
    {
      id: `${t.id}m1`,
      fromName: t.from,
      fromEmail: `${t.from.toLowerCase().replace(/[^a-z]+/g, '.')}@example.com`,
      to: 'you',
      at: t.at,
      body: [
        t.snippet.replace(/…$/, '.'),
        'This is mock content standing in for the real message body until Gmail sync lands (M0-final).'
      ]
    }
  ]
})

export function getConversation(threadId: string): ConversationView {
  const thread = mockThreads.find((t) => t.id === threadId)
  if (!thread) throw new Error(`unknown thread ${threadId}`)
  return conversationBodies[threadId] ?? genericBody(thread)
}
