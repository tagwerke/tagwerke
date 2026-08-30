// Static reference copy for the in-board Help pane (InfoPane, kind="help"). Plain data, not user
// content — no schema, no persistence, just code, since it's documentation rather than a document.
// Keep this in sync with tasks/actions.ts — the one list of what can be done to a task —
// when it changes. Nothing enforces that automatically.
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
    body: 'A board holds your tasks. Table shows them all, Kanban shows where they are stuck, and Notes is for thinking that has no task yet.',
  },
  {
    heading: 'Make your first task',
    steps: [
      'Click the "Add a task" line at the top (or just press `n`).',
      'Type what you need to do.',
      'Press Enter. The line stays put for the next one.',
    ],
  },
  {
    heading: 'Check something off',
    body: 'Click the circle next to a task. Click it again to undo.',
  },
];

/** One "add details" card: a real field on a task, and the click-first way to set it — verified
 *  against the shared action menu (tasks/actions.ts) and the quick-add parser, not guessed. Since
 *  the notes split there is one place every field lives, so every card here says the same thing
 *  two ways: click the cell, or type the command while adding. */
export interface HelpDetail { heading: string; body: string }

export const HELP_DETAILS: HelpDetail[] = [
  {
    heading: 'Due date',
    body: 'Click the Due cell in the Table and pick a day — or type `/due friday` while adding the task.',
  },
  {
    heading: 'Priority',
    body: 'Click the Pri cell, or type `!` while adding — `!` low, `!!` medium, `!!!` high.',
  },
  {
    heading: 'Assignee',
    body: 'Click the Assignee cell, or type `@` and a name while adding.',
  },
  {
    heading: 'Everything else',
    body: 'Right-click any task — or click the `⋯` on the row — for the full list: status, sprint, reviewer, move to another board, delete. The same menu opens from a cell, already on that field.',
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
    title: 'Adding tasks',
    rows: [
      { cmd: 'n', desc: 'Jump to the "Add a task" line' },
      { cmd: 'Enter', desc: 'Add it, and stay put for the next one' },
      { cmd: 'Shift + Enter', desc: 'Add it and open its page' },
      { cmd: 'Type it all at once', desc: '"Fix login bug /p1 /due friday @sam" works — the commands are stripped out and applied' },
    ],
  },
  {
    title: 'On a task',
    rows: [
      { cmd: 'Right-click / `⋯`', desc: 'Everything you can do to it' },
      { cmd: 'Click a cell', desc: 'The same menu, already on that field' },
      { cmd: 'Click the title', desc: 'Open the task — description, sub-tasks, comments, history' },
    ],
  },
  {
    title: 'Notes',
    rows: [
      { cmd: 'Select text', desc: 'Then "Make a task" — the words become a task and a link to it stays in the note' },
      { cmd: 'A task in a note', desc: 'Shows its live title and status; click to open it. Deleting the link never deletes the task' },
    ],
  },
];

/** A dated, ordered "what's new" feed — newest first. Add an entry whenever a change here is
 *  worth surfacing; the Help pane badges the "?" button until the entry has been seen. */
export interface HelpUpdate { id: string; date: string; title: string; body: string }

export const HELP_UPDATES: HelpUpdate[] = [
  {
    id: '2026-08-30-notes-split',
    date: '2026-08-30',
    title: 'Tasks left the document',
    body: 'A board now has three views: Table, Kanban and Notes. Tasks are added on the "Add a task" line (or press "n") instead of by typing "-" in the document, and a row shows its status, its title and a way to open it — everything else moved to the task page and to one menu you reach by right-clicking any task. The old Doc view is Notes: prose, with links to tasks rather than the tasks themselves. Select some text there and "Make a task" turns it into one. List and the board Calendar are gone — the Table with "Group: Status" is the old List, and the Calendar tab in the sidebar is the real one. Sprints moved into the board panel on the right.',
  },
  {
    id: '2026-07-22-commands',
    date: '2026-07-22',
    title: 'Smarter slash commands',
    body: 'Typing "/" now shows a ranked, per-item list instead of an overwhelming grab-bag, and three new commands are available: "/me" (assign yourself), "/unassign", and "/p0" (clear priority).',
  },
];

export const LATEST_HELP_UPDATE_ID = HELP_UPDATES[0]?.id ?? null;
