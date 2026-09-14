// OpenAI-compatible chat client (CONTRACT_TO_PROJECT_PLAN.md D5).
//
// One implementation reaches Ollama, llama.cpp's server, vLLM, LM Studio and every hosted gateway,
// because all of them speak `/chat/completions`. That is what makes "bring your own endpoint"
// cheap, and a LOCAL endpoint is what keeps the air-gap guarantee literally true — the whole
// reason this is BYO rather than a hardcoded vendor.
//
// Unconfigured is a first-class state, not a startup error: the feature is simply off and says so,
// exactly like `blobstore()` returning null without S3_*. Someone self-hosting who never wants a
// model near their contracts should not have to configure one to run the app.
//
// Two things here are deliberate and easy to undo by accident:
//
//   1. Every call carries a timeout. A local 7B on a laptop can wedge; without AbortSignal the
//      fetch would hold a Node socket — and an extraction run — open indefinitely.
//   2. NOTHING in this file logs the prompt, the completion, or the key. The prompt *is* the
//      customer's contract. An error path that echoes it into the app log is a data leak with no
//      upside, so error messages carry the provider's own `error.message` and a status code, and
//      never the response body verbatim (a 400 from some gateways echoes the request back).

export interface AiConfig {
  /** Base URL up to and including any `/v1`. `/chat/completions` is appended. */
  endpoint: string;
  model: string;
  /** Optional: a local Ollama or llama.cpp server needs no key, a hosted gateway does. */
  apiKey?: string;
  timeoutMs: number;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Env keys that must ALL be present for commitment extraction to be enabled. */
const REQUIRED = ['AI_ENDPOINT', 'AI_MODEL'] as const;

const DEFAULT_TIMEOUT_MS = 120_000;

export function configFromEnv(): AiConfig | null {
  if (REQUIRED.some((k) => !process.env[k])) return null;
  const raw = Number(process.env.AI_TIMEOUT_MS);
  return {
    // Trailing slashes are the single most common way a BYO endpoint is typed wrong
    // (`http://localhost:11434/v1/`), and the resulting `//chat/completions` 404s on some servers.
    endpoint: process.env.AI_ENDPOINT!.replace(/\/+$/, ''),
    model: process.env.AI_MODEL!,
    apiKey: process.env.AI_API_KEY || undefined,
    timeoutMs: Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * Read per call rather than memoised like `blobstore()`: there is no connection pool to reuse here
 * (fetch handles that), and the verify script points AI_ENDPOINT at a stub server it starts
 * itself, which a cached config would make untestable.
 */
export function aiConfigured(): boolean {
  return configFromEnv() !== null;
}

/** Which env keys are missing, so a 503 can name the gap instead of just refusing. */
export function missingAiConfig(): string[] {
  return REQUIRED.filter((k) => !process.env[k]);
}

/** The configured model name, or null. For audit rows and the run log. */
export function aiModel(): string | null {
  return configFromEnv()?.model ?? null;
}

/** A provider's own diagnostic, if it sent one in the documented OpenAI error shape. */
function providerMessage(body: string): string | null {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    if (typeof parsed.error === 'string') return parsed.error.slice(0, 200);
    const msg = (parsed.error as { message?: unknown } | undefined)?.message;
    return typeof msg === 'string' ? msg.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/**
 * One chat completion, forced to JSON, parsed.
 *
 * `response_format: {type:'json_object'}` is honoured by OpenAI, vLLM, LM Studio and Ollama's
 * OpenAI shim. A server that ignores it still usually returns JSON because the prompt demands it —
 * and if it does not, the parse fails here and the caller drops that chunk, which is the correct
 * failure mode: fewer items, never invented ones.
 *
 * Throws on: unconfigured, non-2xx, a malformed envelope, or unparseable content. Every throw is
 * a message safe to put in a run log.
 */
export async function chatJSON(
  messages: ChatMessage[],
  opts: { temperature?: number } = {},
): Promise<unknown> {
  const cfg = configFromEnv();
  if (!cfg) throw new Error('AI endpoint is not configured');

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  let res: Response;
  try {
    res = await fetch(`${cfg.endpoint}/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        messages,
        // Extraction, not prose. Near-zero temperature is what makes "quote exactly" achievable at
        // all; a creative sampler paraphrases, and a paraphrased quote is a dropped item (D6).
        temperature: opts.temperature ?? 0,
        response_format: { type: 'json_object' },
      }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });
  } catch (err) {
    // TimeoutError is what AbortSignal.timeout raises; say so plainly, because "the model is slow"
    // and "the endpoint is wrong" look identical otherwise.
    const name = (err as { name?: string }).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error(`AI request timed out after ${cfg.timeoutMs}ms`, { cause: err });
    }
    throw new Error(`AI endpoint unreachable: ${(err as Error).message}`, { cause: err });
  }

  if (!res.ok) {
    const detail = providerMessage(await res.text().catch(() => ''));
    throw new Error(`AI endpoint returned ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const envelope = (await res.json().catch(() => null)) as
    | { choices?: { message?: { content?: unknown } }[] }
    | null;
  const content = envelope?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error('AI response had no message content');
  }

  try {
    return JSON.parse(content);
  } catch {
    // Deliberately does not include `content` — it is a transform of the contract text.
    throw new Error('AI response was not valid JSON');
  }
}
