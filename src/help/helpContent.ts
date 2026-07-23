// Static reference copy for the in-board Help pane (InfoPane, kind="help"). Plain data, not user
// content — no schema, no persistence, just code, since it's documentation rather than a document.
// Keep this in sync with the actual command set in editor/suggestEngine.ts + editor/embeddedCommands.ts
// when either changes — nothing enforces that automatically.
//
// Content is split into three tiers, shown in this order (see InfoPane.tsx):
//   HELP_BASICS + HELP_DETAILS — the required reading for a brand-new user: how to make a task,
//     check it off, and add a due date/priority/assignee by clicking. Always visible, unfolded.
//   HELP_SECTIONS — the old reference sheet (typed shortcuts, keyboard behaviour). Real and
//     accurate, but optional: it lives under a collapsed "Go faster" toggle so it never competes
//     with the basics above it.
//   HELP_UPDATES — the changelog. Demoted to the very bottom for the same reason: a first-time
//     user shouldn't meet a changelog entry before they've met the feature it's changing.

/** A single line of the required-reading block: a task-shaped heading, plus either one sentence
 *  (`body`) or a literal, ordered list of clicks/keystrokes (`steps`). Backtick-quoted text (e.g.
 *  `` `-` ``) renders in monospace — see InfoPane's `renderInline`. */
export interface HelpBasic { heading: string; body?: string; steps?: string[] }

export const HELP_BASICS: HelpBasic[] = [
  {
    heading: 'What this is',
    body: 'A board is a page for your tasks. Each line is one task.',
  },
  {
    heading: 'Make your first task',
    steps: [
      'Click the empty line on the board.',
      'Type `-` then a space.',
      'Type what you need to do.',
      'Press Enter to start the next one.',
    ],
  },
  {
    heading: 'Check something off',
    body: 'Click the circle next to a task. Click it again to undo.',
  },
];

/** One "add details" card: a real field on a task, and the click-first way to set it — verified
 *  against TaskMeta.tsx / TaskTitleSuggest.tsx, not guessed. Priority and assignee don't have a
 *  standing button the way the due date does; typing `!`/`@` opens a small list you click into. */
export interface HelpDetail { heading: string; body: string }

export const HELP_DETAILS: HelpDetail[] = [
  {
    heading: 'Due date',
    body: 'Under the task, click `+date` and pick a day. Click the date again later to change it.',
  },
  {
    heading: 'Priority',
    body: 'Type `!` right after the text — `!` for low, `!!` for medium, `!!!` for high — then click the level in the list that pops up.',
  },
  {
    heading: 'Assignee',
    body: 'Type `@` and a name, then click them in the list that pops up.',
  },
];

export interface HelpRow { cmd: string; desc: string }
export interface HelpSection { title: string; rows: HelpRow[] }

/** The optional speed-up reference, unfolded under "Go faster" — unchanged in substance from the
 *  original all-in-one pane, just no longer the first thing anyone sees. */
export const HELP_SECTIONS: HelpSection[] = [
  {
    title: 'Due dates',
    rows: [
      { cmd: '/today', desc: 'Set the due date to today' },
      { cmd: '/tomorrow', desc: 'Set the due date to tomorrow' },
      { cmd: '/due <day>', desc: 'e.g. "/due friday" or "/due 2026-08-01"' },
    ],
  },
  {
    title: 'Status',
    rows: [
      { cmd: '/todo', desc: 'Mark as todo' },
      { cmd: '/doing', desc: 'Mark as in progress (also "wip", "inprogress")' },
      { cmd: '/review', desc: 'Mark as in review (also "inreview")' },
      { cmd: '/done', desc: 'Mark as done' },
      { cmd: '/cancel', desc: 'Mark as cancelled (also "cancelled")' },
    ],
  },
  {
    title: 'Priority',
    rows: [
      { cmd: '/p1 · /p2 · /p3', desc: 'Set priority — or just type !, !!, !!!' },
      { cmd: '/p0', desc: 'Clear priority (also "noprio")' },
    ],
  },
  {
    title: 'Assign',
    rows: [
      { cmd: '@name', desc: 'Assign a teammate — type @ and pick from the list' },
      { cmd: '/me', desc: 'Assign yourself' },
      { cmd: '/unassign', desc: 'Clear the assignee' },
    ],
  },
  {
    title: 'Writing a task',
    rows: [
      { cmd: 'Enter', desc: 'Create the next task' },
      { cmd: 'Shift + Enter', desc: 'Escape back to plain text (not a task)' },
      { cmd: 'Tab / Shift+Tab', desc: 'Nest a task under the one above / un-nest it' },
      { cmd: 'Type it all at once', desc: '"Fix login bug /p1 /due friday @sam" works too — commands anywhere in the title are picked up the moment you click away' },
    ],
  },
];

/** A dated, ordered "what's new" feed — newest first. Add an entry whenever a change here is
 *  worth surfacing; the Help pane badges the "?" button until the entry has been seen. */
export interface HelpUpdate { id: string; date: string; title: string; body: string }

export const HELP_UPDATES: HelpUpdate[] = [
  {
    id: '2026-07-22-commands',
    date: '2026-07-22',
    title: 'Smarter slash commands',
    body: 'Typing "/" now shows a ranked, per-item list instead of an overwhelming grab-bag, and three new commands are available: "/me" (assign yourself), "/unassign", and "/p0" (clear priority).',
  },
];

export const LATEST_HELP_UPDATE_ID = HELP_UPDATES[0]?.id ?? null;
