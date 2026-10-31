// The `alcove.yaml` documents the web app's command-line export writes for a
// managed exchange enrolled with a relay registrar, one per side, each with the
// registrar a command-line run of it registers at and the registrar its
// `invitation_relay` names, where a run enrolls without a token only when the
// relay it allocates on is one the invitation names. One set behind
// the `./testing` subpath, so the composer that writes the file and the CLI
// loader that reads it cannot drift: the web leg composes each document from
// the inputs below and compares the YAML data it writes, and the CLI leg loads
// the document through its own config loader. The set holds the inputs, the
// documents and the expected answer only; each leg drives its own code.

import type { LinkageTerms } from "./linkageTermsSchema.js";
import type { RelayLocator, RelayRegistrar } from "./connection.js";
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
  /** The registrar the document's `invitation_relay` names, or null where it
   * names none. A command-line run enrolls there without a token only when
   * the relay it allocates on is one the invitation names. */
  readonly invitationRegistrar: string | null;
  /** Why this record exports that, in one line; the parity tests' title. */
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
 * The exporting browser's own TURN url.
 */
export const COMMAND_LINE_EXPORT_OWN_TURN_URL =
  "turns:relay.example.org:443?transport=tcp";

/**
 * @internal
 *
 * The relay a hosted invitation names in the partner case: a build's default
 * relay, its TURN url and its registrar.
 */
export const COMMAND_LINE_EXPORT_INVITATION_RELAY: RelayLocator = {
  turn: ["turns:default-relay.example.org:443?transport=tcp"],
  registrar: "https://default-relay.example.org",
};

/** @internal */
export const COMMAND_LINE_EXPORT_LINKAGE_TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: "County Services Agency",
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
 * {@link COMMAND_LINE_EXPORT_OWN_TURN_URL}. The partner case's invitation
 * names {@link COMMAND_LINE_EXPORT_INVITATION_RELAY}.
 */
export const COMMAND_LINE_EXPORT_RELAY_CASES: Readonly<
  Record<CommandLineExportRelayCaseId, CommandLineExportRelayCase>
> = {
  ownRelay: {
    side: "inviter",
    locator: { channel: "webrtc", host: "signaling.example.org" },
    document: [
      "format_version: 1",
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
      "  identity: County Services Agency",
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
    invitationRegistrar: null,
    because:
      "its runs relay through this party's own TURN relay, which they " +
      "register at the registrar",
  },
  partnerRelay: {
    side: "acceptor",
    locator: {
      channel: "webrtc",
      host: "signaling.example.org",
      relay: COMMAND_LINE_EXPORT_INVITATION_RELAY,
    },
    document: [
      "format_version: 1",
      "connection:",
      "  channel: webrtc",
      "  server:",
      "    host: signaling.example.org",
      "  role: acceptor",
      "  turn:",
      "    - url: turns:relay.example.org:443?transport=tcp",
      "  relay_registrar:",
      "    url: https://relay.example.org:8443",
      "    exchange_id: riverbend-q3",
      "  invitation_relay:",
      "    turn:",
      "      - turns:default-relay.example.org:443?transport=tcp",
      "    registrar: https://default-relay.example.org",
      "linkage_terms:",
      "  version: 1.0.0",
      "  identity: County Services Agency",
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
    invitationRegistrar: "https://default-relay.example.org",
    because:
      "its runs list this party's own TURN relay, which they register at the " +
      "registrar, beside the relay the invitation named, whose registrar " +
      "they enroll at only when the relay they allocate on is one the " +
      "invitation names",
  },
};
