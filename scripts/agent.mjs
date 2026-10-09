// Talk to the agent API from the command line (see server/routes/agent.ts).
//
//   node scripts/agent.mjs                       # board summary
//   node scripts/agent.mjs me                    # who this token is and what it may do
//   node scripts/agent.mjs board --json          # the raw response
//   node scripts/agent.mjs task <taskId>         # one task in full, with its comments
//   node scripts/agent.mjs comment <taskId> "text"
//
// Reads TAGWERKE_AGENT_TOKEN (and optionally TAGWERKE_URL) from the environment or from .env.

import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');
const token = process.env.TAGWERKE_AGENT_TOKEN;
const base = (process.env.TAGWERKE_URL ?? 'https://tagwerke.knyazev.ca').replace(/\/$/, '');
if (!token) {
  console.error('TAGWERKE_AGENT_TOKEN is not set (put it in .env).');
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(base + path, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`${res.status} ${text}`);
    process.exit(1);
  }
  return JSON.parse(text);
}

const [cmd = 'board', ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith('--'));
const args = rest.filter((a) => !a.startsWith('--'));
const one = (s) => (s ?? '').replace(/\s+/g, ' ').trim();

if (cmd === 'me') {
  console.log(JSON.stringify(await api('/api/agent/me'), null, 2));
} else if (cmd === 'board' || cmd === 'task') {
  const b = await api('/api/agent/board');
  if (flags.includes('--json') && cmd === 'board') {
    console.log(JSON.stringify(b, null, 2));
  } else if (cmd === 'board') {
    console.log(`${b.board.name}  [${b.members.map((m) => `${m.name}:${m.role}`).join(', ')}]`);
    console.log(`notes: ${one(b.notes.text).slice(0, 300) || '(empty)'}\n`);
    for (const t of b.tasks) {
      console.log(`${t.id}  ${t.status.padEnd(11)} ${t.title.text}  (${t.comments.length} comments${t.description.text ? ', has description' : ''})`);
    }
  } else {
    const t = b.tasks.find((x) => x.id === args[0]);
    if (!t) {
      console.error(`no task ${args[0]} on this board`);
      process.exit(1);
    }
    console.log(`${t.title.text}\nstatus ${t.status} | assignee ${t.assignee?.name ?? '-'} | reviewer ${t.reviewer?.name ?? '-'} | due ${t.dueDate ?? '-'}`);
    console.log(`\n${t.description.text || '(no description)'}\n`);
    for (const c of t.comments) console.log(`-- ${c.content.author?.name} (${c.content.author?.role}) ${c.createdAt}\n${c.content.text}\n`);
  }
} else if (cmd === 'comment') {
  const [taskId, ...words] = args;
  const body = words.join(' ');
  if (!taskId || !body) {
    console.error('usage: node scripts/agent.mjs comment <taskId> "text"');
    process.exit(1);
  }
  console.log(JSON.stringify(await api(`/api/agent/tasks/${taskId}/comments`, { method: 'POST', body: JSON.stringify({ body }) })));
} else {
  console.error('commands: me | board [--json] | task <id> | comment <id> "text"');
  process.exit(1);
}
