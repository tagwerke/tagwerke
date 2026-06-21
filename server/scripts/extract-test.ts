// Quality test harness for email→task extraction. Runs Haiku over real emails
// WITHOUT any DB, auth, or HTTP — so you can judge extraction quality before
// building the mail pipeline. Needs ANTHROPIC_API_KEY in your .env.
//
// Usage:
//   npm run extract:test -- path/to/email.eml [more.eml ...]
//   npm run extract:test -- emails/            (every .eml/.txt/.mbox in the folder)
//   npm run extract:test -- All-mail.mbox      (Gmail Takeout export — split per message)
//   cat email.txt | npm run extract:test        (pasted/piped text on stdin)
//   npm run extract:test -- emails/ --limit=50  (cap how many to process; default 100)
//
// For each email it prints the AI's verdict so you can eyeball precision/recall
// across a messy batch (real asks, FYIs, newsletters, thread chatter).

import 'dotenv/config';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import { nanoid } from 'nanoid';
import { extractTask, type EmailInput, type ExtractedTask } from '../lib/extractTask.ts';

const DEFAULT_LIMIT = 100;

/** Light .eml parse: headers above the first blank line, body below. Good enough
 *  for eyeballing quality; the real pipeline uses a full MIME parser. */
function parseEmail(raw: string): EmailInput {
  const norm = raw.replace(/\r\n/g, '\n');
  const split = norm.indexOf('\n\n');
  const headerText = split === -1 ? '' : norm.slice(0, split);
  const body = split === -1 ? norm : norm.slice(split + 2);
  const header = (name: string): string | undefined => {
    const m = headerText.match(new RegExp(`^${name}:\\s*(.+)$`, 'im'));
    return m?.[1]?.trim();
  };
  return { from: header('From'), subject: header('Subject'), body: body.trim() || norm.trim() };
}

/** Split a Unix mbox (Gmail Takeout) into individual RFC822 messages. Messages
 *  begin at a line starting with "From " (the mbox separator); that line is not
 *  part of the message. Body lines escaped as ">From " are left as-is (harmless). */
function splitMbox(raw: string): string[] {
  return raw
    .replace(/\r\n/g, '\n')
    .split(/\n(?=From )/)
    .map((p) => p.replace(/^From .*\n/, '').trim())
    .filter((p) => p.length > 0);
}

interface Unit {
  label: string;
  email: EmailInput;
}

/** Turn a file path into one-or-many email units (.mbox fans out). */
function fileToUnits(path: string): Unit[] {
  const raw = readFileSync(path, 'utf8');
  if (extname(path).toLowerCase() === '.mbox') {
    const msgs = splitMbox(raw);
    return msgs.map((m, i) => ({ label: `${path}#${i + 1}`, email: parseEmail(m) }));
  }
  return [{ label: path, email: parseEmail(raw) }];
}

function collectFiles(args: string[]): string[] {
  const files: string[] = [];
  for (const arg of args) {
    if (statSync(arg).isDirectory()) {
      for (const name of readdirSync(arg)) {
        if (['.eml', '.txt', '.mbox'].includes(extname(name).toLowerCase())) files.push(join(arg, name));
      }
    } else {
      files.push(arg);
    }
  }
  return files;
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

async function run(unit: Unit): Promise<ExtractedTask | null> {
  try {
    const ex = await extractTask(unit.email);
    const tag = ex.hasTask ? `✅ TASK (${ex.confidence}%)` : `⬜ no task (${ex.confidence}%)`;
    console.log(`\n${tag}  — ${unit.label}`);
    if (unit.email.subject) console.log(`   subject: ${unit.email.subject}`);
    console.log(`   title:   ${ex.title}`);
    console.log(`   summary: ${ex.summary}`);
    if (ex.dueDate) console.log(`   due:     ${ex.dueDate}`);
    if (ex.owner) console.log(`   owner:   ${ex.owner}`);
    return ex;
  } catch (err) {
    console.error(`\n❌ ERROR — ${unit.label}:`, (err as Error).message);
    return null;
  }
}

/** Resolve --enqueue=<email> to a user id and return an inserter, or null. Lazily
 *  imports the DB so plain quality runs don't need DATABASE_URL. */
async function makeEnqueuer(email: string | null): Promise<((ex: ExtractedTask, unit: Unit) => Promise<void>) | null> {
  if (!email) return null;
  const { db, schema } = await import('../db/client.ts');
  const { eq } = await import('drizzle-orm');
  const rows = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email)).limit(1);
  const userId = rows[0]?.id;
  if (!userId) {
    console.error(`No user with email ${email}. Sign up first, then re-run.`);
    process.exit(1);
  }
  return async (ex, unit) => {
    const snippet = unit.email.body.replace(/\s+/g, ' ').trim().slice(0, 200);
    await db.insert(schema.inboundDrafts).values({
      id: `d_${nanoid(8)}`,
      userId,
      status: 'pending',
      title: ex.title || unit.email.subject || '(untitled)',
      summary: ex.summary ?? null,
      suggestedDate: ex.dueDate ?? null,
      suggestedOwner: ex.owner ?? null,
      confidence: ex.confidence ?? null,
      fromAddr: unit.email.from ?? null,
      subject: unit.email.subject ?? null,
      snippet,
      extractionFailed: false,
    });
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const limitArg = args.find((a) => a.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : DEFAULT_LIMIT;
  const enqueueArg = args.find((a) => a.startsWith('--enqueue='));
  const enqueue = await makeEnqueuer(enqueueArg ? (enqueueArg.split('=')[1] ?? null) : null);
  const paths = args.filter((a) => !a.startsWith('--'));

  let units: Unit[];
  if (paths.length === 0) {
    const raw = await readStdin();
    if (!raw.trim()) {
      console.error('No input. Pass .eml/.mbox file(s) or a folder as args, or pipe email text on stdin.');
      process.exit(1);
    }
    units = [{ label: 'stdin', email: parseEmail(raw) }];
  } else {
    const files = collectFiles(paths);
    if (!files.length) {
      console.error('No .eml/.txt/.mbox files found.');
      process.exit(1);
    }
    units = files.flatMap(fileToUnits);
  }

  const total = units.length;
  if (total > limit) {
    console.log(`${total} emails found; processing the first ${limit} (raise with --limit=N).`);
    units = units.slice(0, limit);
  }

  let taskCount = 0;
  let enqueued = 0;
  for (const unit of units) {
    const ex = await run(unit);
    if (ex?.hasTask) {
      taskCount++;
      if (enqueue) {
        await enqueue(ex, unit);
        enqueued++;
      }
    }
  }
  console.log(`\n— ${taskCount}/${units.length} flagged as actionable —`);
  if (enqueue) console.log(`— ${enqueued} drafts added to your Inbox (refresh the app) —`);
  // The pg pool keeps the event loop alive when --enqueue imported the DB.
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
