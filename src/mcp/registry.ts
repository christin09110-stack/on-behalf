// The tool registry.
//
// One list, two surfaces. The MCP server registers every entry as a tool; the console
// registers every entry's `touchRoute` as a page. That is not tidiness, it is a
// certification requirement: Amazon's accessibility guidance for Alexa+ add-ons says
// the experience has to be completable "touch only, including on-screen keyboard,
// without voice". `tests/touch-parity.test.ts` walks this list and fails if a tool
// exists that a person cannot reach with their hands.
//
// Both surfaces enter through `invokeTool` and neither may call `tool.run` itself. That
// is what makes the authorisation gate and the output screen apply to the tools that
// exist now and to the ones that do not yet, and `tests/authorisation.test.ts` reads
// both files to check that it stayed true.

import { z } from 'zod';
import type { Db } from '../db.ts';
import type { Caller } from './auth.ts';
import type { SubjectResolver } from './authorize.ts';
import { authorizeCall } from './authorize.ts';
import { assertNoHealthContent, assertSafeForVoice } from '../domain/screening.ts';
import { assertNoDirective } from '../domain/readback.ts';

export { targetHousehold } from './authorize.ts';

export interface ToolResult {
  ok: boolean;
  code: string;
  facts?: Record<string, unknown>;
  rows?: Array<Record<string, unknown>>;
  options?: Array<Record<string, unknown>>;
}

export interface ToolDef {
  name: string;
  title: string;
  /** Written for the model that picks the tool, not for a person. */
  description: string;
  audience: 'household' | 'delegate' | 'both';
  /** Where a person does the same thing with their hands. Required, always. */
  touchRoute: string;
  /** True when this tool changes something. Used by the console and the ledger. */
  writes: boolean;
  /**
   * Which household this call is about and what it does to it. Required, with no
   * default: a safety parameter that defaults to the open value means the next tool
   * added fails open silently and the compiler helps nobody.
   */
  subject: SubjectResolver;
  input: z.ZodRawShape;
  run(db: Db, caller: Caller, args: Record<string, unknown>): ToolResult;
}

/**
 * Everything Standby is prepared to say out loud gets screened first: for identifiers,
 * for health, and for anything that reads as an instruction to the model rather than a
 * fact for it.
 *
 * Health used to be screened only on text a person typed. That looked sufficient because
 * `tests/no-model-on-read-path.ts` proves no module under `src/bedrock/` is reachable
 * from the MCP server, and it is true and still enforced. But it proves the *module* is
 * unreachable, not the *text*: `writeBrief` runs on a console POST, stores its prose in
 * the `brief` table, and `latest_brief` reads that row back on a voice turn and returns
 * it as `facts.body`. Alexa then says it. The round trip through SQLite walks around the
 * import graph entirely.
 *
 * The same argument applies to `assertReadbackSafe`'s directive rule, and it took longer
 * to notice. That rule is the prompt-injection defence for a voice path, and it was
 * applied at seven call sites inside `src/domain/`, every one of which hands it facts the
 * app's own rules composed — a provider name, a day, a formatted price. It was not
 * applied to `latest_brief`, the one tool whose facts a model wrote. The guard was
 * correct and it was pointed at the only text that could not attack it.
 *
 * So all three run here, at the one point every tool result passes through on its way to
 * the spoken channel. They fire on model prose and on a person's typing alike, which is
 * correct: the channel is what is being protected, not the author.
 */
export function screenResult(result: ToolResult): ToolResult {
  const check = (o: Record<string, unknown> | undefined) => {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (typeof v !== 'string') continue;
      assertSafeForVoice(v);
      assertNoHealthContent(v);
      assertNoDirective(k, v);
    }
  };
  check(result.facts);
  (result.rows ?? []).forEach(check);
  (result.options ?? []).forEach(check);
  return result;
}

/**
 * The one way a tool runs. Authorise, run, screen, in that order.
 *
 * Authorising first is not a preference. A denied call must not reach the database, must
 * not write an audit row, and must not compose a refusal out of facts it was not entitled
 * to read.
 */
export function invokeTool(
  db: Db,
  caller: Caller,
  tool: ToolDef,
  args: Record<string, unknown> = {},
): ToolResult {
  authorizeCall(db, caller, tool.subject, args);
  return screenResult(tool.run(db, caller, args));
}

export const householdArg = {
  household: z
    .string()
    .optional()
    .describe('Which home this is about. Leave empty for the speaker\'s own home.'),
};
