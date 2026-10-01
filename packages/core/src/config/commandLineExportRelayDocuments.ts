// The `alcove.yaml` documents the web app's command-line export writes for a
// managed exchange enrolled with a relay registrar, one per relay its runs use,
// each with the registrar a command-line run of it registers at. One set behind
// the `./testing` subpath, so the composer that writes the file and the CLI
// loader that reads it cannot drift: the web leg composes each document from
// the inputs below and compares the YAML data it writes, and the CLI leg loads
// the document through its own config loader. The set holds the inputs, the
// documents and the expected answer only; each leg drives its own code.

import type { LinkageTerms } from "./linkageTermsSchema.js";
import type { RelayRegistrar } from "./connection.js";
import type { WebRTCEndpoint } from "./invitation.js";

/**
 * @internal
 *
 * One exported record, keyed so a case added here fails both legs to compile.
 */
export type CommandLineExportRelayCaseId = "ownRelay" | "partnerRelay";

/**
 * @internal
 *
 * One record's inputs, its exported document, and the registrar a run of that
 * document registers at.
 */
export interface CommandLineExportRelayCase {
  /** The side the record runs as. */
  readonly side: "inviter" | "acceptor";
  /** The locator the record's document is composed from. */
  readonly locator: WebRTCEndpoint;
  /** The exported `alcove.yaml`'s content: the YAML data the export writes,
   * without the serializer's guidance comments. */
  readonly document: string;
  /** The registrar a command-line run of the document registers at, or null
   * where it registers nothing. */
  readonly runRegistrar: RelayRegistrar | null;
  /** Why this record exports that, in one line. */
  readonly because: string;
}

/** @internal */
export const COMMAND_LINE_EXPORT_RELAY_REGISTRAR: RelayRegistrar = {
  url: "https://relay.example.org:8443",
  exchangeId: "riverbend-q3",
};

/**
 * @internal
 *
 * The exporting browser's own TURN url. The invitation in the partner case
 * names the same url: what a case writes depends on which relay its runs use,
 * not on the url.
 */
export const COMMAND_LINE_EXPORT_OWN_TURN_URL =
  "turns:relay.example.org:443?transport=tcp";

/** @internal */
export const COMMAND_LINE_EXPORT_LINKAGE_TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Dept",
  date: "2025-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: false },
  deduplicate: false,
  linkageFields: [{ name: "ssn", type: "ssn" }],
  linkageKeys: [{ name: "SSN", elements: [{ field: "ssn" }] }],
};

/**
 * @internal
 *
 * Every case is enrolled with {@link COMMAND_LINE_EXPORT_RELAY_REGISTRAR}, and
 * the exporting browser's relay settings name
 * {@link COMMAND_LINE_EXPORT_OWN_TURN_URL}.
 */
export const COMMAND_LINE_EXPORT_RELAY_CASES: Readonly<
  Record<CommandLineExportRelayCaseId, CommandLineExportRelayCase>
> = {
  ownRelay: {
    side: "inviter",
    locator: { channel: "webrtc", host: "signaling.example.org" },
    document: [
      "connection:",
      "  channel: webrtc",
      "  server:",
      "    host: signaling.example.org",
      "  role: inviter",
      "  turn:",
      "    - url: turns:relay.example.org:443?transport=tcp",
      "  relay_registrar:",
      "    url: https://relay.example.org:8443",
      "    exchange_id: riverbend-q3",
      "linkage_terms:",
      "  version: 1.0.0",
      "  identity: County Health Dept",
      "  date: 2025-01-01",
      "  algorithm: psi",
      "  linkage_strategy: cascade",
      "  output:",
      "    expects_output: true",
      "    share_with_partner: false",
      "  deduplicate: false",
      "  linkage_fields:",
      "    - type: ssn",
      "      name: ssn",
      "  linkage_keys:",
      "    - name: SSN",
      "      elements:",
      "        - field: ssn",
    ].join("\n"),
    runRegistrar: COMMAND_LINE_EXPORT_RELAY_REGISTRAR,
    because:
      "its runs relay through this party's own TURN relay, which they " +
      "register at the registrar",
  },
  partnerRelay: {
    side: "acceptor",
    locator: {
      channel: "webrtc",
      host: "signaling.example.org",
      relay: { turn: [COMMAND_LINE_EXPORT_OWN_TURN_URL] },
    },
    document: [
      "connection:",
      "  channel: webrtc",
      "  server:",
      "    host: signaling.example.org",
      "  role: acceptor",
      "  invitation_relay:",
      "    turn:",
      "      - turns:relay.example.org:443?transport=tcp",
      "linkage_terms:",
      "  version: 1.0.0",
      "  identity: County Health Dept",
      "  date: 2025-01-01",
      "  algorithm: psi",
      "  linkage_strategy: cascade",
      "  output:",
      "    expects_output: true",
      "    share_with_partner: false",
      "  deduplicate: false",
      "  linkage_fields:",
      "    - type: ssn",
      "      name: ssn",
      "  linkage_keys:",
      "    - name: SSN",
      "      elements:",
      "        - field: ssn",
    ].join("\n"),
    runRegistrar: null,
    because:
      "its runs relay through the relay the invitation named, which the " +
      "partner registers at",
  },
};
