// Email → task extraction via Claude Haiku 4.5. The email body is passed in,
// read once, and never persisted by this module — the caller stores only the
// returned ExtractedTask. Uses structured outputs so the JSON is guaranteed to
// match the schema (the model is forced to produce valid output).

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-haiku-4-5';

export interface ExtractedTask {
  /** Whether the email contains something the user must act on. */
  hasTask: boolean;
  /** Imperative one-line task title (e.g. "Send Q3 numbers to Dana"). */
  title: string;
  /** <= ~200 char neutral summary of what's being asked. */
  summary: string;
  /** ISO date (YYYY-MM-DD) if a due date is stated/implied, else null. */
  dueDate: string | null;
  /** Name of who should do it, if the email names one, else null. */
  owner: string | null;
  /** 0-100 self-reported confidence that this is a real, actionable task. */
  confidence: number;
}

export interface EmailInput {
  from?: string;
  subject?: string;
  /** Plain-text body. Read here, never stored. */
  body: string;
}

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    hasTask: { type: 'boolean' },
    title: { type: 'string' },
    summary: { type: 'string' },
    dueDate: { type: ['string', 'null'] },
    owner: { type: ['string', 'null'] },
    confidence: { type: 'integer' },
  },
  required: ['hasTask', 'title', 'summary', 'dueDate', 'owner', 'confidence'],
} as const;

const SYSTEM = `You triage email for a personal task manager. Decide whether an email contains a concrete action the RECIPIENT must take, then extract it.

Set hasTask=false for: newsletters, marketing, receipts, notifications, social/thread chatter, FYIs, "thanks"/"sounds good" replies, anything informational with no ask of the recipient. Be strict — when in doubt that there is a real, specific action FOR THE RECIPIENT, set hasTask=false with low confidence. A false task is noise the user has to clean up.

Set hasTask=true only when the recipient is clearly being asked to DO something specific (reply with X, send Y, review Z, decide, schedule, pay, fix).

When hasTask=true:
- title: a short imperative line ("Send the signed contract to Dana"). No "You should".
- summary: <= 200 chars, neutral, what's being asked and any key detail.
- dueDate: an ISO date YYYY-MM-DD if a deadline is stated or clearly implied (use the email's own dates; do not invent one). Otherwise null.
- owner: the person expected to act if named, else null.
- confidence: 0-100, how sure you are this is a real actionable task for the recipient.

When hasTask=false, still return title/summary as a brief description, dueDate/owner null, and a low confidence.`;

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set — email task extraction is unavailable.');
  }
  client ??= new Anthropic();
  return client;
}

export async function extractTask(email: EmailInput): Promise<ExtractedTask> {
  const content = [
    email.from ? `From: ${email.from}` : null,
    email.subject ? `Subject: ${email.subject}` : null,
    '',
    email.body,
  ]
    .filter((l) => l !== null)
    .join('\n')
    // Hard cap input so a giant thread can't blow up cost/latency.
    .slice(0, 12000);

  const res = await getClient().messages.create({
    model: MODEL,
    max_tokens: 512,
    system: SYSTEM,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content }],
  });

  const block = res.content.find((b) => b.type === 'text');
  if (!block || block.type !== 'text') {
    throw new Error('extraction returned no text content');
  }
  const parsed = JSON.parse(block.text) as ExtractedTask;
  // Clamp/normalize defensively.
  parsed.confidence = Math.max(0, Math.min(100, Math.round(parsed.confidence ?? 0)));
  parsed.summary = (parsed.summary ?? '').slice(0, 200);
  return parsed;
}
