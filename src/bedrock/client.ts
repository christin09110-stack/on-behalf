// Bedrock, kept where it belongs.
//
// The MCP Toolkit asks for a round trip under 500 ms. A model call cannot promise
// that, so nothing in this directory is reachable from a tool handler. Every caller
// here runs after a turn has already been answered: writing the brief the delegate
// reads later, arguing a held request, or turning a sentence the delegate typed into
// terms the household can accept.
//
// `tests/no-model-on-read-path.test.ts` walks the import graph from the MCP tool
// registry and fails if anything under `src/bedrock/` becomes reachable from it.
//
// Three things every call here has: a deadline, a model chain, and a caller that works
// without it.

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';

export interface ModelReply {
  text: string;
  model: string;
  latencyMs: number;
}

export class ModelUnavailable extends Error {
  // Written out rather than declared as constructor parameter properties: Node's
  // native TypeScript runtime only accepts erasable syntax, and parameter properties
  // are not erasable.
  attempts: Array<{ model: string; error: string }>;
  latencyMs: number;

  constructor(attempts: Array<{ model: string; error: string }>, latencyMs: number) {
    super(
      `No model answered. Tried: ${attempts.map((a) => `${a.model} (${a.error})`).join('; ')}`,
    );
    this.name = 'ModelUnavailable';
    this.attempts = attempts;
    this.latencyMs = latencyMs;
  }
}

/**
 * Preference order, most capable first.
 *
 * Sonnet 5 is listed in this account's own `ListFoundationModels` and
 * `ListInferenceProfiles` output and still returns AccessDenied on invoke, so it sits
 * at the head of the chain rather than being removed: the day entitlement lands,
 * Standby uses it without a code change.
 */
export const MODEL_CHAIN = (
  process.env.STANDBY_MODELS ??
  'us.anthropic.claude-sonnet-5,us.anthropic.claude-sonnet-4-6,us.anthropic.claude-sonnet-4-5-20250929-v1:0'
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const REGION = process.env.AWS_REGION ?? 'us-east-1';
const DEADLINE_MS = Number(process.env.STANDBY_MODEL_TIMEOUT_MS ?? 12_000);

let client: BedrockRuntimeClient | null = null;
function runtime(): BedrockRuntimeClient {
  client ??= new BedrockRuntimeClient({ region: REGION });
  return client;
}

export interface AskOptions {
  system: string;
  user: string;
  maxTokens?: number;
  /** Anthropic's own trick for reliable JSON: start the reply for it. */
  prefill?: string;
  temperature?: number;
}

/** Off by default nowhere: this is the switch tests and the offline demo use. */
export function modelsDisabled(): boolean {
  return process.env.STANDBY_NO_MODEL === '1';
}

export async function ask(opts: AskOptions): Promise<ModelReply> {
  const started = Date.now();
  if (modelsDisabled()) {
    throw new ModelUnavailable(
      [{ model: 'disabled', error: 'STANDBY_NO_MODEL=1' }],
      Date.now() - started,
    );
  }
  const attempts: Array<{ model: string; error: string }> = [];
  for (const model of MODEL_CHAIN) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DEADLINE_MS);
    try {
      const messages: Array<{ role: string; content: string }> = [
        { role: 'user', content: opts.user },
      ];
      if (opts.prefill) messages.push({ role: 'assistant', content: opts.prefill });
      const res = await runtime().send(
        new InvokeModelCommand({
          modelId: model,
          contentType: 'application/json',
          accept: 'application/json',
          body: JSON.stringify({
            anthropic_version: 'bedrock-2023-05-31',
            max_tokens: opts.maxTokens ?? 900,
            temperature: opts.temperature ?? 0.2,
            system: opts.system,
            messages,
          }),
        }),
        { abortSignal: controller.signal },
      );
      const parsed = JSON.parse(new TextDecoder().decode(res.body)) as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (parsed.content ?? [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('');
      if (!text.trim()) throw new Error('empty reply');
      return {
        text: plainPunctuation((opts.prefill ?? '') + text),
        model,
        latencyMs: Date.now() - started,
      };
    } catch (e) {
      attempts.push({ model, error: e instanceof Error ? e.name : String(e) });
    } finally {
      clearTimeout(timer);
    }
  }
  throw new ModelUnavailable(attempts, Date.now() - started);
}

/**
 * Models reach for em dashes and this project does not use them anywhere a person
 * reads. Applied to every model reply before it is stored or shown.
 */
export function plainPunctuation(text: string): string {
  return text
    .replace(/\s*\u2014\s*/g, ', ')
    .replace(/\s*\u2013\s*/g, ' to ')
    .replace(/\u2018|\u2019/g, "'")
    .replace(/\u201c|\u201d/g, '"');
}

/** Pull the first JSON object out of a reply, tolerating a model that chats first. */
export function firstJson<T>(text: string): T {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object in reply');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      return JSON.parse(text.slice(start, i + 1)) as T;
    }
  }
  throw new Error('unterminated JSON object in reply');
}
