import fs from "node:fs";
import path from "node:path";

import type { Payload, RelayLocator, SigningConfig } from "@alcove/core";
import {
  keepOperatorSuppliedText,
  messageWithOperatorText,
  OperatorConfigError,
  operatorSuppliedText,
  partnerPinIsPresent,
  redactAndRenderOperatorSuppliedText,
  removeUnsetPayloadReceiveNote,
  snakeizeKey,
  snakeizeKeys,
  UsageError,
} from "@alcove/core";

import { isMap, isScalar } from "yaml";
import type { Document } from "yaml";

import { writeFileOwnerOnly } from "../fileUtils";
import { editSensitiveYamlDocument } from "../sensitiveFile";
import type { SensitiveFileLabel } from "../sensitiveFile";

/**
 * The label the sensitive-parse chokepoint names the operator's own
 * configuration file by. Composed rather than concatenated so the path inside
 * it stays marked as the operator's: a failure the chokepoint reports shows it
 * as they typed it, separators and all.
 */
export function configFileLabel(configPath: string): SensitiveFileLabel {
  return messageWithOperatorText`config file ${operatorSuppliedText(configPath)}`;
}

/**
 * A refusal about the operator's own configuration file, reading
 * "config file <path> <rest>".
 *
 * `rest` is first-party copy and whatever the refusal quotes out of the
 * document -- a channel or mode the operator wrote -- which takes the escape
 * every unmarked fragment takes. Only the path is marked.
 */
export function configFileRefusal(
  configPath: string,
  rest: string,
): UsageError {
  const message = messageWithOperatorText`config file ${operatorSuppliedText(configPath)} ${rest}`;
  return keepOperatorSuppliedText(new UsageError(message.text), message);
}

/**
 * Read the configuration file at `configPath`, apply `edit` to its YAML
 * document, and write the result back in place: the operator's comments, key
 * order and formatting survive, and the parse, edit and serialization go
 * through the sensitive-file chokepoint ({@link editSensitiveYamlDocument}).
 * Returns the edited text.
 *
 * The write is {@link writeFileOwnerOnly}'s: owner-only permissions and an
 * atomic rename, the same {@link saveConfig} uses. With `write: false`
 * nothing is written, for a caller that checks or conditions the write
 * itself and then writes the returned text through {@link writeFileOwnerOnly}.
 *
 * Throws if the file cannot be read or parsed: every caller edits a file it
 * has just loaded, and a silent failure would leave the operator believing
 * the change was recorded.
 */
export function editConfigInPlace(
  configPath: string,
  edit: (doc: Document) => void,
  options: { write?: boolean } = {},
): string {
  const serialized = editSensitiveYamlDocument(
    fs.readFileSync(configPath, "utf8"),
    configFileLabel(configPath),
    edit,
  );
  if (options.write !== false) writeFileOwnerOnly(configPath, serialized);
  return serialized;
}

/**
 * Refuse the edit unless the scalar at `keyPath` is `expected`, with
 * `refusal` given what was found there: the value in quotes, or "absent or
 * non-scalar".
 *
 * `getIn` does not resolve aliases, so an alias-spelled value is treated as a
 * non-string node and refused even when it would resolve to `expected` -- the
 * safe direction, and not a form a hand-authored config uses.
 */
export function requireScalarAt(
  configPath: string,
  doc: Document,
  keyPath: readonly string[],
  expected: string,
  refusal: (found: string) => string,
): void {
  const value = doc.getIn(keyPath);
  if (value === expected) return;
  const found =
    typeof value === "string" ? `"${value}"` : "absent or non-scalar";
  throw configFileRefusal(configPath, refusal(found));
}

/**
 * Rewrite, along `keyPath`, every mapping key the exchange schema reads as the
 * path's snake_case segment -- a camelCase or mixed spelling -- to that
 * segment, so a following `setIn`/`deleteIn` on the snake_case path edits the
 * key the file holds instead of missing it or writing a second spelling the
 * next load refuses. Where the file already holds the snake_case spelling, the
 * other spellings are dropped; where it holds two others and no snake_case
 * one, it is refused, since renaming both would write one key twice. Stops at
 * the first segment that is not a mapping.
 */
export function normalizeKeyPathSpelling(
  configPath: string,
  doc: Document,
  keyPath: readonly string[],
): void {
  let node: unknown = doc.contents;
  for (const [depth, segment] of keyPath.entries()) {
    if (!isMap(node)) return;
    const spellingOf = (key: unknown): string | undefined => {
      const text = isScalar(key) ? key.value : key;
      return typeof text === "string" && snakeizeKey(text) === segment
        ? text
        : undefined;
    };
    const spellings = node.items.flatMap((pair) => {
      const spelling = spellingOf(pair.key);
      return spelling === undefined ? [] : [spelling];
    });
    const holdsSnakeCase = spellings.includes(segment);
    if (!holdsSnakeCase && spellings.length > 1) {
      const quoted = spellings.map((key) => `"${key}"`);
      const block =
        depth === 0 ? "" : ` under ${keyPath.slice(0, depth).join(".")}`;
      throw configFileRefusal(
        configPath,
        `has keys ${quoted.slice(0, -1).join(", ")} and ${quoted[quoted.length - 1]}${block}, ` +
          "which are read as one setting, so only one of them is kept. " +
          "Write the setting once.",
      );
    }
    node.items = node.items.filter((pair) => {
      const spelling = spellingOf(pair.key);
      if (spelling === undefined || spelling === segment) return true;
      if (holdsSnakeCase) return false;
      if (isScalar(pair.key)) pair.key.value = segment;
      else pair.key = doc.createNode(segment);
      return true;
    });
    node = node.get(segment, true);
  }
}

/**
 * Write (or overwrite) `connection.server.host_key_fingerprint` in an
 * existing `alcove.yaml`, used to persist a host-key pin established
 * interactively on first use, through {@link editConfigInPlace}.
 *
 * Fails closed on a non-sftp config: a host-key fingerprint is an sftp-only
 * pin, so any other `connection.channel` is rejected with a
 * {@link UsageError} before anything is written (config.test.ts).
 */
export function persistHostKeyFingerprint(
  configPath: string,
  fingerprint: string,
): void {
  editConfigInPlace(configPath, (doc) => {
    normalizeKeyPathSpelling(configPath, doc, ["connection", "channel"]);
    normalizeKeyPathSpelling(configPath, doc, [
      "connection",
      "server",
      "host_key_fingerprint",
    ]);
    // Read off the parsed document, not a schema-loaded spec.
    requireScalarAt(
      configPath,
      doc,
      ["connection", "channel"],
      "sftp",
      (found) =>
        `has a non-sftp connection.channel (${found}); a host-key ` +
        "fingerprint is an sftp-only pin and must not be written to a " +
        "non-sftp config.",
    );
    // setIn creates the connection/server path nodes if absent; for an
    // sftp config loaded by the exchange command they already exist. A
    // `connection`/`server` that is a scalar or sequence, not a mapping,
    // makes setIn throw a YAML error, reported here as a UsageError rather
    // than an opaque library stack trace.
    try {
      doc.setIn(["connection", "server", "host_key_fingerprint"], fingerprint);
    } catch (err) {
      throw configFileRefusal(
        configPath,
        "could not be updated to persist the host-key fingerprint " +
          `(${err instanceof Error ? err.message : String(err)}); ` +
          "connection.server must be a mapping.",
      );
    }
  });
}

/**
 * The two remedies an operator has when the partner fingerprint a first
 * authenticated contact adopts cannot be written into their configuration
 * file. Shared by {@link assertPartnerFingerprintRecordable}, which refuses
 * before the run connects, and by the write itself, so one instruction reaches
 * the operator wherever the failure is caught.
 */
const PARTNER_FINGERPRINT_REMEDIES =
  "record signing.partner_fingerprint in that file by hand, from the value " +
  "the partner's 'alcove fingerprint' prints, or mount the configuration " +
  "writable for the run that records the pin";

/**
 * Refuse a `certificate`-mode exchange that pins no partner fingerprint and
 * cannot record the one its first authenticated contact will adopt, before the
 * run opens a connection. The deployment shape this exists for is the
 * read-only configuration mount (see docs/DEPLOYMENT.md): without the refusal
 * the run connects, spends the SFTP credential, presents its terms and
 * certificate, and then dies at the adoption write with nothing recorded.
 *
 * The pin is recorded by writing a new file in the configuration's directory
 * and renaming it over the old one ({@link writeFileOwnerOnly}), so it is that
 * directory the run needs `W_OK` on; the configuration file's own mode does
 * not decide whether the rename lands. A run already holding a pin writes
 * nothing and is not held to this.
 *
 * An {@link OperatorConfigError} (exit 64): the configuration and its
 * permissions are the operator's own.
 */
export function assertPartnerFingerprintRecordable(
  signing: SigningConfig | undefined,
  configPath: string,
): void {
  if (signing?.mode !== "certificate") return;
  if (partnerPinIsPresent(signing.partnerFingerprint)) return;
  try {
    fs.accessSync(path.dirname(configPath), fs.constants.W_OK);
  } catch {
    const message = messageWithOperatorText`${UNRECORDABLE_PIN_PREAMBLE}${operatorSuppliedText(
      configPath,
    )}${UNRECORDABLE_PIN_REMEDY}`;
    throw keepOperatorSuppliedText(
      new OperatorConfigError(message.text),
      message,
    );
  }
}

/** What {@link assertPartnerFingerprintRecordable} states ahead of the path. */
const UNRECORDABLE_PIN_PREAMBLE =
  "this exchange signs receipts (signing.mode: certificate) and pins no " +
  "partner fingerprint, so its first authenticated contact records the " +
  "certificate the partner presents into ";

/** What {@link assertPartnerFingerprintRecordable} states behind the path. */
const UNRECORDABLE_PIN_REMEDY =
  ". That file cannot be replaced: recording the pin writes a new file " +
  "in the directory holding it and renames that over the old one, which " +
  "needs the directory writable by the user this run is. The run stopped " +
  `before connecting. Either ${PARTNER_FINGERPRINT_REMEDIES}.`;

/**
 * Write `signing.partner_fingerprint` into an existing `alcove.yaml`, used to
 * record the pin an exchange adopted on its first authenticated contact with a
 * partner, through {@link editConfigInPlace}.
 *
 * Two refusals stand ahead of the write, both raised as a {@link UsageError}
 * before anything reaches disk. A document whose `signing.mode` is not
 * `certificate` is not one this pin belongs in. And a document that already
 * pins a partner fingerprint is never rewritten: changing a pin is a
 * deliberate act, as changing a host-key pin is, so a value already on file is
 * left exactly as it stands.
 *
 * A read or replace this party's own filesystem refuses -- a mount that turned
 * read-only after {@link assertPartnerFingerprintRecordable} passed -- becomes
 * an {@link OperatorConfigError} naming the adopted fingerprint and the same
 * two remedies, since the run stops here and the value has to be on file
 * before the next one.
 */
export function persistPartnerFingerprint(
  configPath: string,
  fingerprint: string,
): void {
  try {
    editConfigInPlace(configPath, (doc) =>
      recordPartnerFingerprint(configPath, doc, fingerprint),
    );
  } catch (err) {
    // A UsageError (OperatorConfigError included) is already an operator-facing
    // refusal the document edit composed; anything else is the read or the
    // atomic replace, which reaches the operator only here.
    if (err instanceof UsageError) throw err;
    const message = messageWithOperatorText`${PARTNER_PIN_UNRECORDED_PREAMBLE}${operatorSuppliedText(
      configPath,
    )} (${
      err instanceof Error ? err.message : String(err)
    }), so the run stops here. The partner's fingerprint is ${fingerprint}; before the next run, either ${PARTNER_FINGERPRINT_REMEDIES}.`;
    throw keepOperatorSuppliedText(
      new OperatorConfigError(message.text),
      message,
    );
  }
}

/** What {@link persistPartnerFingerprint} states ahead of the path. */
const PARTNER_PIN_UNRECORDED_PREAMBLE =
  "the partner's signing certificate was pinned on this first contact, but " +
  "the fingerprint could not be recorded in ";

/** The edit {@link persistPartnerFingerprint} makes: `signing.partner_fingerprint`
 * set to `fingerprint`, behind its two refusals. */
function recordPartnerFingerprint(
  configPath: string,
  doc: Document,
  fingerprint: string,
): void {
  normalizeKeyPathSpelling(configPath, doc, ["signing", "mode"]);
  normalizeKeyPathSpelling(configPath, doc, ["signing", "partner_fingerprint"]);
  // Read off the parsed document, not a schema-loaded spec.
  requireScalarAt(
    configPath,
    doc,
    ["signing", "mode"],
    "certificate",
    (found) =>
      `does not sign receipts with a certificate (signing.mode is ` +
      `${found}); a partner certificate fingerprint must not be ` +
      "written to it.",
  );
  const existing = doc.getIn(["signing", "partner_fingerprint"]);
  if (existing !== undefined && existing !== null)
    throw configFileRefusal(
      configPath,
      "already pins a partner fingerprint; it was left unchanged. " +
        "Changing a pin is a deliberate act: confirm the partner's " +
        "fingerprint out-of-band and edit signing.partner_fingerprint " +
        "yourself.",
    );
  // setIn creates the signing path node if absent; for a certificate-mode
  // config loaded by the exchange command it already exists. A `signing`
  // that is a scalar or sequence, not a mapping, makes setIn throw a YAML
  // error, reported here as a UsageError rather than an opaque library
  // stack trace.
  try {
    doc.setIn(["signing", "partner_fingerprint"], fingerprint);
  } catch (err) {
    throw configFileRefusal(
      configPath,
      "could not be updated to record the partner certificate " +
        `fingerprint (${err instanceof Error ? err.message : String(err)}); ` +
        "signing must be a mapping.",
    );
  }
}

/**
 * Write `linkage_terms.payload.receive` into an existing `alcove.yaml`: the
 * payload columns a run whose terms left the list unset took from the
 * partner's declared send set, which the next run holds the partner to, through
 * {@link editConfigInPlace}, removing the note that stated the list unset.
 *
 * A document that already states the list, or holds no `linkage_terms`
 * mapping, is refused and left unchanged. Any failure stops the run before a
 * linkage key or payload row moves, so the refusal says so and how to state
 * the list by hand.
 *
 * @throws {OperatorConfigError} when the list cannot be written.
 */
export function persistFilledPayloadReceive(
  configPath: string,
  columns: readonly string[],
): void {
  try {
    editConfigInPlace(configPath, (doc) => {
      normalizeKeyPathSpelling(configPath, doc, [
        "linkage_terms",
        "payload",
        "receive",
      ]);
      if (!isMap(doc.get("linkage_terms", true)))
        throw configFileRefusal(configPath, "holds no linkage_terms mapping.");
      const existing = doc.getIn(["linkage_terms", "payload", "receive"]);
      if (existing !== undefined && existing !== null)
        throw configFileRefusal(
          configPath,
          "already states linkage_terms.payload.receive; it was left " +
            "unchanged.",
        );
      doc.setIn(
        ["linkage_terms", "payload", "receive"],
        doc.createNode(columns.map((name) => ({ name }))),
      );
      removeUnsetPayloadReceiveNote(doc);
    });
  } catch (err) {
    const message = messageWithOperatorText`the payload columns your partner declares it sends could not be recorded as linkage_terms.payload.receive in ${operatorSuppliedText(
      configPath,
    )} (${
      err instanceof Error ? err.message : String(err)
    }), so the run stopped before any data moved. Make the file writable and run again, or list the columns you expect under linkage_terms.payload.receive yourself.`;
    throw keepOperatorSuppliedText(
      new OperatorConfigError(message.text),
      message,
    );
  }
}

/**
 * Write `linkage_terms.payload.send` into an existing `alcove.yaml`: the
 * columns an invitation or terms update minted from the configuration states
 * this party sends, from its `metadata`, where the terms left the list unset
 * or named other columns, through {@link editConfigInPlace}.
 *
 * @throws when the file cannot be read, parsed, or written, or holds no
 *   `linkage_terms` mapping.
 */
export function persistStatedPayloadSend(
  configPath: string,
  send: NonNullable<Payload["send"]>,
): void {
  editConfigInPlace(configPath, (doc) => {
    normalizeKeyPathSpelling(configPath, doc, [
      "linkage_terms",
      "payload",
      "send",
    ]);
    if (!isMap(doc.get("linkage_terms", true)))
      throw configFileRefusal(configPath, "holds no linkage_terms mapping.");
    doc.setIn(
      ["linkage_terms", "payload", "send"],
      doc.createNode(send.map((column) => snakeizeKeys(column))),
    );
  });
}

/**
 * The warning an invitation or terms update minted from the configuration at
 * `configPath` logs before {@link persistStatedPayloadSend} replaces a present
 * `linkage_terms.payload.send` that named other columns than the metadata
 * sends.
 */
export function replacedPayloadSendWarning(
  configPath: string,
  document: "invitation" | "terms update",
): string {
  const shownConfig = redactAndRenderOperatorSuppliedText(
    operatorSuppliedText(configPath),
  );
  return (
    `linkage_terms.payload.send in ${shownConfig} named other columns than ` +
    `its metadata sends. The ${document} states the columns the metadata ` +
    `sends, and payload.send in ${shownConfig} is rewritten to match. To ` +
    `send other columns, change is_payload or role in the metadata block of ` +
    `${shownConfig} and generate the ${document} again.`
  );
}

/**
 * Write or overwrite the top-level `expected_partner_deduplicate` in an
 * existing `alcove.yaml`: the consent commitment to the `deduplicate` the
 * accepted invitation declared for the inviting party's own side, which a
 * later `alcove exchange` holds the partner's presented value to
 * ({@link assertPresentedDeduplicateMatchesInvitation} in core), refusing a
 * contradiction before any key or payload moves.
 *
 * Written by both accept-reuse paths (offline, and the online hook's reuse
 * branch), through {@link editConfigInPlace}.
 *
 * Takes a plain `boolean`: `deduplicate` is mandatory on the linkage-terms
 * schema, so an acceptance always has a declaration to record and there is
 * no removal to express.
 */
export function persistExpectedPartnerDeduplicate(
  configPath: string,
  declared: boolean,
): void {
  editConfigInPlace(configPath, (doc) => {
    normalizeKeyPathSpelling(configPath, doc, ["expected_partner_deduplicate"]);
    doc.setIn(["expected_partner_deduplicate"], declared);
  });
}

/**
 * What {@link persistInvitationRelay} did to a kept configuration's
 * `connection.invitation_relay`.
 */
export type InvitationRelayRefresh = "set" | "removed" | "absent" | "notWebrtc";

/**
 * Write, overwrite, or remove `connection.invitation_relay` in an existing
 * `alcove.yaml` from the invitation an acceptance has just consented to,
 * leaving every other key of the connection block untouched. The field is
 * invitation-derived rather than the operator's own, so an acceptance that
 * keeps the configuration refreshes it: a relay a prior invitation named must
 * not stay in force after the operator was shown this invitation's.
 *
 * `relay === undefined` removes the field. A connection block whose channel
 * is not webrtc holds no relay and is left as it is. Edited through
 * {@link editConfigInPlace}, and written only when the field changed.
 */
export function persistInvitationRelay(
  configPath: string,
  relay: RelayLocator | undefined,
): InvitationRelayRefresh {
  // Widened by the assertion: the edit callback assigns it, which control-flow
  // narrowing does not follow.
  let outcome = "notWebrtc" as InvitationRelayRefresh;
  const serialized = editConfigInPlace(
    configPath,
    (doc) => {
      normalizeKeyPathSpelling(configPath, doc, ["connection", "channel"]);
      if (doc.getIn(["connection", "channel"]) !== "webrtc") return;
      const field = ["connection", "invitation_relay"];
      normalizeKeyPathSpelling(configPath, doc, field);
      if (relay === undefined) {
        outcome = doc.hasIn(field) ? "removed" : "absent";
        doc.deleteIn(field);
        return;
      }
      outcome = "set";
      doc.setIn(
        field,
        doc.createNode({
          ...(relay.turn !== undefined ? { turn: relay.turn } : {}),
          ...(relay.stun !== undefined ? { stun: relay.stun } : {}),
          ...(relay.websocket !== undefined
            ? { websocket: relay.websocket }
            : {}),
          ...(relay.websocketExchangeId !== undefined
            ? { websocket_exchange_id: relay.websocketExchangeId }
            : {}),
          ...(relay.registrar !== undefined
            ? { registrar: relay.registrar }
            : {}),
        }),
      );
    },
    { write: false },
  );
  if (outcome === "set" || outcome === "removed")
    writeFileOwnerOnly(configPath, serialized);
  return outcome;
}
