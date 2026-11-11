import {
  clipToRenderedCost,
  DEFAULT_MAX_DISPLAY_LENGTH,
  renderedDisplayCost,
} from "../utils/sanitizeForDisplay";
import { redactPrivateKeyMaterial } from "../utils/sanitizeErrorForDisplay";

/**
 * The figures of the SFTP transports' operation bounds, shared by the CLI's
 * adapter and the web app's browser SFTP transport so both enforce one value:
 * docs/spec/TRANSPORT_LIVENESS.md#per-operation-liveness-bounds and
 * docs/spec/TRANSPORT_BOUNDS.md#directory-listing-bound.
 */

/**
 * How long, in milliseconds, an SFTP operation may wait on the server before it
 * is judged stalled: a whole-operation deadline or a progress idle window,
 * depending on the operation. Fixed, not operator-configurable.
 */
export const SFTP_STALL_DEADLINE_MS = 60_000;

/**
 * Chunk size, in bytes, of an SFTP upload. The idle window resets on each
 * acknowledged chunk, so a whole-payload write would show no progress until it
 * finished; 64 KiB chunks let a ~1 KiB/s upload progress within the window.
 */
export const SFTP_PUT_PROGRESS_CHUNK_BYTES = 64 * 1024;

/** Maximum entries a transport directory listing enumerates, of any type. */
export const MAX_DIRECTORY_ENTRIES = 8192;

/**
 * Maximum READDIR round-trips one SFTP listing issues, so empty non-EOF
 * batches cannot loop forever.
 */
export const MAX_LISTING_READDIR_BATCHES = 2 * MAX_DIRECTORY_ENTRIES;

/**
 * What one labelled cause link, label and fragment together, may render to: the
 * per-value display budget, well under the renderer's per-link cap
 * (`COMPOSED_MESSAGE_MAX_DISPLAY_LENGTH`), so the clip only bites an anomalous
 * fragment.
 */
const CAUSE_LINK_VALUE_BUDGET = DEFAULT_MAX_DISPLAY_LENGTH;

/**
 * Compose one labelled cause link of a bounded-transport refusal, `fragment`
 * redacted and then fitted to the per-value display budget with the label's
 * cost included. Redact before clipping, or a kept `BEGIN` marker meets
 * {@link clipToRenderedCost}'s fail-closed dangling rule. The result stays raw,
 * escaped once where rendered.
 */
export function fittedCauseLink(label: string, fragment: string): string {
  return `${label}${clipToRenderedCost(
    redactPrivateKeyMaterial(fragment),
    CAUSE_LINK_VALUE_BUDGET - renderedDisplayCost(label),
  )}`;
}
