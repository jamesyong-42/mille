// Command enablement evaluation (shared by registry dispatch + menus).
//
// Kept as a leaf module so the headless registry can honor enablement
// without pulling in contribution lifecycle / menu partition code.

import type { Command, CommandContext } from './types.js';
import { evaluateWhen } from './when.js';

/**
 * Whether a visible command is currently enabled. Defaults to `true`.
 * Disabled commands may still appear greyed in menus.
 */
export function evaluateEnablement(
  command: Command,
  ctx: CommandContext,
): boolean {
  const e = command.enablement;
  if (e === undefined) return true;
  if (typeof e === 'function') return Boolean(e(ctx));
  return evaluateWhen(e, ctx);
}
