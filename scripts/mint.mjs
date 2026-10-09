// One-line wrapper around server/scripts/issue-agent-token.ts.
//
//   node scripts/mint.mjs <boardId> <agentName> [--days n] [--scopes a,b]            # DATABASE_URL from .env (dev)
//   node scripts/mint.mjs --prod <boardId> <agentName>                               # the commented-out prod URL in .env
//   node scripts/mint.mjs --prod --revoke <boardId> <agentName>
//
// --prod reads the first `# DATABASE_URL=...` line in .env, for this one process only. The script
// it runs prints which database it is talking to before it changes anything — check that line.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const prod = argv.includes('--prod');
const args = argv.filter((a) => a !== '--prod');
if (!args.some((a) => !a.startsWith('--'))) {
  console.error('usage: node scripts/mint.mjs [--prod] [--revoke] <boardId> <agentName> [--days n] [--scopes a,b]');
  process.exit(1);
}

const env = { ...process.env };
if (prod) {
  const m = existsSync('.env') && readFileSync('.env', 'utf8').match(/^#\s*DATABASE_URL=(.+)$/m);
  if (!m) {
    console.error('no commented "# DATABASE_URL=..." line found in .env');
    process.exit(1);
  }
  env.DATABASE_URL = m[1].trim().replace(/^['"]|['"]$/g, '');
}

const r = spawnSync('npx', ['tsx', 'server/scripts/issue-agent-token.ts', ...args], {
  env,
  stdio: 'inherit',
  shell: true,
});
process.exit(r.status ?? 1);
