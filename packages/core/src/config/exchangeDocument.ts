import YAML from "yaml";

import { snakeizeKeys } from "../utils/camelizeKeys.js";
import { annotateConnectionGuidance } from "./connectionGuidance.js";
import type { ExchangeSpec } from "./exchangeSpec.js";
import type { LinkageTerms } from "./linkageTermsSchema.js";
import { payloadReceiveFillsOnFirstRun } from "./recurringTerms.js";
import { commentBlock } from "./yamlComments.js";

/**
 * Serialize an {@link ExchangeSpec} into the snake_case YAML document Alcove
 * writes as an operator's `alcove.yaml`, guidance comments included. The
 * caller's spec is not mutated.
 *
 * The shared secret and its expiration live only in the key file: they are
 * stripped from the top-level `authentication` block here even if the caller
 * left them populated, so the secret cannot be duplicated onto disk. The strip
 * is part of this serializer rather than of any one caller, so every writer
 * that renders the document through it inherits it; a writer that serializes
 * a spec by another route does not, and must not carry an `authentication`
 * secret into what it writes.
 *
 * The `connection` block is annotated with the operator guidance
 * {@link annotateConnectionGuidance} attaches -- the channel alternatives, where
 * each channel's block is documented, and the connection tuning as a commented
 * example -- since a config written by `invite`, `accept`, or a saved zero-setup
 * exchange is one the operator edits by hand from here on. Linkage terms that
 * leave `payload.receive` unset say what the first run does with it
 * ({@link annotateUnsetPayloadReceive}).
 */
export function serializeExchangeDocument(spec: ExchangeSpec): string {
  const sanitized = structuredClone(spec);
  const auth = sanitized.authentication;
  if (auth) {
    delete auth.sharedSecret;
    delete auth.expires;
    // Drop the container if those were its only keys, so the config holds no
    // noisy empty `authentication: {}` block. Operator-policy fields (e.g.
    // token_max_age_days) keep it non-empty when present.
    if (Object.keys(auth).length === 0) delete sanitized.authentication;
  }
  const doc = new YAML.Document(snakeizeKeys(sanitized));
  annotateConnectionGuidance(doc);
  annotateUnsetPayloadReceive(doc, spec.linkageTerms);
  return doc.toString();
}

/** The comment {@link annotateUnsetPayloadReceive} places in a `payload`
 * mapping that holds no `receive`. */
const UNSET_RECEIVE_IN_PAYLOAD = commentBlock([
  "receive is not set: the first exchange sets it to the payload columns your",
  "partner declares it sends, and later exchanges refuse a partner that sends",
  "a different list. Write receive: [] to receive none.",
]);

/** The comment {@link annotateUnsetPayloadReceive} places at the end of a
 * `linkage_terms` mapping that holds no `payload`. */
const UNSET_RECEIVE_IN_TERMS = commentBlock([
  "payload.receive is not set: the first exchange sets it to the payload",
  "columns your partner declares it sends, and later exchanges refuse a",
  "partner that sends a different list. Write payload: {receive: []} to",
  "receive none.",
]);

/**
 * State, where `payload.receive` would go, that the terms leave it unset and
 * the first run fills it ({@link payloadReceiveFillsOnFirstRun}): at the end
 * of the `payload` mapping, or of `linkage_terms` where there is none. A no-op
 * for terms the fill does not apply to and for a document holding no
 * `linkage_terms` mapping.
 */
export function annotateUnsetPayloadReceive(
  doc: YAML.Document,
  terms: LinkageTerms | undefined,
): void {
  if (terms === undefined || !payloadReceiveFillsOnFirstRun(terms)) return;
  const linkageTerms = doc.get("linkage_terms", true);
  if (!YAML.isMap(linkageTerms)) return;
  const payload = linkageTerms.get("payload", true);
  if (YAML.isMap(payload)) payload.comment = UNSET_RECEIVE_IN_PAYLOAD;
  else linkageTerms.comment = UNSET_RECEIVE_IN_TERMS;
}

/**
 * Remove the comment {@link annotateUnsetPayloadReceive} placed, from a
 * document whose `payload.receive` has since been set. A comment the operator
 * wrote after it, which a parse joins to the same trailing comment, is kept,
 * and one written in its place is left as it is.
 */
export function removeUnsetPayloadReceiveNote(doc: YAML.Document): void {
  const withoutNote = (
    comment: string | null | undefined,
    note: string,
  ): string | null | undefined => {
    if (comment === note) return null;
    return comment?.startsWith(`${note}\n`) === true
      ? comment.slice(note.length + 1)
      : comment;
  };
  const linkageTerms = doc.get("linkage_terms", true);
  if (!YAML.isMap(linkageTerms)) return;
  linkageTerms.comment = withoutNote(
    linkageTerms.comment,
    UNSET_RECEIVE_IN_TERMS,
  );
  const payload = linkageTerms.get("payload", true);
  if (YAML.isMap(payload))
    payload.comment = withoutNote(payload.comment, UNSET_RECEIVE_IN_PAYLOAD);
}
