import {
  WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
  describeUndeclaredColumns,
  sanitizeForDisplay,
} from "@alcove/core";
import type { PreparedExchange } from "@alcove/core";

/**
 * Fold one driver `onWarning` message into a seat's accumulated run warnings.
 *
 * The seat's display boundary: escapes `message` once via
 * {@link sanitizeForDisplay} before it reaches state or the shared renderer
 * ({@link RunWarningsAlert}), which adds no pass of its own -- a second pass
 * here or downstream would double every literal backslash. Every seat's
 * driver `onWarning` slot folds through this function; the seat warning-sink
 * lint rule (`apps/web/eslint.config.js`) holds that routing. `maxLength` is a
 * whole-message composition budget, not the per-value default -- see
 * docs/spec/CHANNEL_SECURITY.md, "Display sanitization escape format".
 */
export function appendSanitizedRunWarning(
  current: ReadonlyArray<string>,
  message: string,
): Array<string> {
  return [
    ...current,
    sanitizeForDisplay(message, {
      maxLength: WARNING_MESSAGE_MAX_DISPLAY_LENGTH,
    }),
  ];
}

/**
 * The run notice naming the input columns a run does not send because its
 * column settings do not declare them, or `undefined` when there are none.
 * Raised on a seat's run surface before the run connects; composed raw, since
 * the seat's `onWarning` sink escapes it ({@link appendSanitizedRunWarning}).
 */
export function undeclaredColumnsRunNotice(
  prepared: Pick<PreparedExchange, "undeclaredColumns">,
): string | undefined {
  const notice = describeUndeclaredColumns(prepared.undeclaredColumns ?? []);
  if (notice === undefined) return undefined;
  return `${notice} To send one, set it to "Sent to your partner" in the column settings.`;
}
