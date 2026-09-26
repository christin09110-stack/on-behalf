// Everything Standby can be asked to do, in one list.

import type { ToolDef } from './registry.ts';
import { householdTools } from './tools-household.ts';
import { delegateTools } from './tools-delegate.ts';

export const ALL_TOOLS: ToolDef[] = [...householdTools, ...delegateTools];

export const toolByName = (name: string): ToolDef | undefined =>
  ALL_TOOLS.find((t) => t.name === name);

/** Every page the console has to serve for the touch-only requirement to hold. */
export const TOUCH_ROUTES = [...new Set(ALL_TOOLS.map((t) => t.touchRoute))].sort();
