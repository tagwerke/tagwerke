// Issue (or rotate) the bearer token for ONE agent bound to ONE board (AGENT_API.md).
//
//   tsx server/scripts/issue-agent-token.ts <boardId> <agentName> [--scopes board:read,task:comment] [--days 90]
//   tsx server/scripts/issue-agent-token.ts --revoke <boardId> <agentName>
//
// Creates the agent user (<agentName>@agent.invalid, no password) if absent, makes it a VIEWER of
// that board and of nothing else, revokes any live token it held, and prints a new secret ONCE.
// An agent already attached to a different board is refused: one agent = one board.

import 'dotenv/config';
import { nanoid } from 'nanoid';
import { connect } from './_db.ts';
import { AGENT_SCOPES, newToken } from '../auth/agent.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const revoke = args.includes('--revoke');
const positional = args.filter((a, i) => !a.startsWith('--') && !['--scopes', '--days'].includes(args[i - 1]));
const [boardId, agentName] = positional;
if (!boardId || !agentName || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(agentName)) {
  console.error('usage: issue-agent-token.ts [--revoke] <boardId> <agentName: a-z0-9->  [--scopes a,b] [--days n]');
  process.exit(1);
}
const scopes = (flag('--scopes') ?? 'board:read,task:comment').split(',').map((s) => s.trim());
const bad = scopes.filter((s) => !(AGENT_SCOPES as readonly string[]).includes(s));
if (bad.length) {
  console.error(`unknown scope(s): ${bad.join(', ')} (known: ${AGENT_SCOPES.join(', ')})`);
  process.exit(1);
}
const days = Number(flag('--days') ?? 90);

const client = await connect();
try {
  const info = (await client.query(`SELECT current_database() AS db, inet_server_addr()::text AS host`)).rows[0];
  console.log(`Database: ${info.db} @ ${info.host ?? 'local socket'}`);
  const board = (await client.query(`SELECT id, name FROM tabs WHERE id = $1`, [boardId])).rows[0];
  if (!board) throw new Error(`no board ${boardId} in this database`);
  const email = `${agentName}@agent.invalid`;

  await client.query('BEGIN');
  let user = (await client.query(`SELECT id, kind FROM users WHERE email = $1`, [email])).rows[0];
  if (user && user.kind !== 'agent') throw new Error(`${email} exists and is not an agent user`);
  if (!user) {
    if (revoke) throw new Error(`no agent named ${agentName}`);
    user = { id: nanoid() };
    await client.query(`INSERT INTO users (id, email, role, kind) VALUES ($1, $2, 'member', 'agent')`, [user.id, email]);
  }
  const other = await client.query(`SELECT tab_id FROM board_members WHERE user_id = $1 AND tab_id <> $2`, [user.id, boardId]);
  if (other.rowCount) throw new Error(`${email} already belongs to another board — one agent, one board. Use a different name.`);

  await client.query(`UPDATE agent_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [user.id]);
  if (revoke) {
    await client.query('COMMIT');
    console.log(`Revoked ${email}'s token(s).`);
  } else {
    await client.query(
      `INSERT INTO board_members (tab_id, user_id, role) VALUES ($1, $2, 'viewer') ON CONFLICT (tab_id, user_id) DO UPDATE SET role = 'viewer'`,
      [boardId, user.id],
    );
    const { token, hash } = newToken();
    await client.query(
      `INSERT INTO agent_tokens (id, user_id, tab_id, token_hash, scopes, label, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, now() + ($7 || ' days')::interval)`,
      [nanoid(), user.id, boardId, hash, JSON.stringify(scopes), agentName, String(days)],
    );
    await client.query('COMMIT');
    console.log(`Agent ${email} -> board "${board.name}" (${boardId}), scopes [${scopes.join(', ')}], expires in ${days}d.`);
    console.log(`\nToken (shown once, store it now):\n${token}\n`);
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(String((err as Error).message ?? err));
  process.exitCode = 1;
} finally {
  await client.end();
}
