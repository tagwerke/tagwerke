// Issue (or revoke) a bearer token for an agent bound to ONE board (AGENT_API.md). The same thing a
// board admin does from Share → API tokens, for when there is no browser to hand — an admin fallback.
//
//   tsx server/scripts/issue-agent-token.ts <boardId> <name> [--scopes task:comment,task:write] [--days 90]
//   tsx server/scripts/issue-agent-token.ts --revoke <boardId> <name>
//
// Every token gets its OWN agent user (<name>-<random>@agent.invalid, no password), so the same name
// can be used on different boards. The agent is an editor of that board when the token can write tasks
// and a viewer otherwise, and a member of nothing else. `--revoke` revokes the board's live tokens
// with that name and takes their agents off the board. The secret is printed ONCE.

import 'dotenv/config';
import { nanoid } from 'nanoid';
import { connect } from './_db.ts';
import { AGENT_PREFIX, AGENT_SCOPES, agentEmail, newToken } from '../auth/agent.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const revoke = args.includes('--revoke');
const positional = args.filter((a, i) => !a.startsWith('--') && !['--scopes', '--days'].includes(args[i - 1]));
const [boardId, agentName] = positional;
if (!boardId || !agentName || !/^[a-z0-9][a-z0-9-]{1,30}$/.test(agentName)) {
  console.error('usage: issue-agent-token.ts [--revoke] <boardId> <name: a-z0-9->  [--scopes a,b] [--days n]');
  process.exit(1);
}
// `board:read` is always on; the flag lists the extras.
const extras = (flag('--scopes') ?? 'task:comment').split(',').map((s) => s.trim()).filter((s) => s && s !== 'board:read');
const bad = extras.filter((s) => !(AGENT_SCOPES as readonly string[]).includes(s));
if (bad.length) {
  console.error(`unknown scope(s): ${bad.join(', ')} (known: ${AGENT_SCOPES.filter((s) => s !== 'board:read').join(', ')})`);
  process.exit(1);
}
const scopes = ['board:read', ...new Set(extras)];
const days = Number(flag('--days') ?? 90);

const client = await connect();
try {
  const info = (await client.query(`SELECT current_database() AS db, inet_server_addr()::text AS host`)).rows[0];
  console.log(`Database: ${info.db} @ ${info.host ?? 'local socket'}`);
  const board = (await client.query(`SELECT id, name FROM tabs WHERE id = $1`, [boardId])).rows[0];
  if (!board) throw new Error(`no board ${boardId} in this database`);

  await client.query('BEGIN');
  if (revoke) {
    const live = (
      await client.query(
        `UPDATE agent_tokens SET revoked_at = now() WHERE tab_id = $1 AND label = $2 AND revoked_at IS NULL RETURNING user_id`,
        [boardId, agentName],
      )
    ).rows;
    if (!live.length) throw new Error(`no live token named ${agentName} on this board`);
    await client.query(`DELETE FROM board_members WHERE tab_id = $1 AND user_id = ANY($2::text[])`, [boardId, live.map((r) => r.user_id)]);
    await client.query('COMMIT');
    console.log(`Revoked ${live.length} token(s) named ${agentName} on "${board.name}".`);
  } else {
    const userId = nanoid();
    const email = agentEmail(agentName);
    const role = scopes.includes('task:write') ? 'editor' : 'viewer';
    await client.query(`INSERT INTO users (id, email, role, kind) VALUES ($1, $2, 'member', 'agent')`, [userId, email]);
    await client.query(`INSERT INTO board_members (tab_id, user_id, role) VALUES ($1, $2, $3)`, [boardId, userId, role]);
    const { token, hash } = newToken(AGENT_PREFIX);
    await client.query(
      `INSERT INTO agent_tokens (id, user_id, tab_id, token_hash, scopes, label, expires_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, now() + ($7 || ' days')::interval)`,
      [nanoid(), userId, boardId, hash, JSON.stringify(scopes), agentName, String(days)],
    );
    await client.query('COMMIT');
    console.log(`Agent ${email} (${role}) -> board "${board.name}" (${boardId}), scopes [${scopes.join(', ')}], expires in ${days}d.`);
    console.log(`\nToken (shown once, store it now):\n${token}\n`);
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error(String((err as Error).message ?? err));
  process.exitCode = 1;
} finally {
  await client.end();
}
