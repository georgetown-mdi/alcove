/**
 * The pure half of an exchange's Connection settings: the coordination
 * server its runs and re-invites use, shown as a `ws://` or `wss://` address,
 * and its own relays, shown one url per line, read back into the edits
 * {@link ManagedExchangeLocalEdits} takes. A new invitation's and an accepted
 * one's settings read the same way.
 */

import {
  OWN_SIGNALING_PATH,
  ownSignalingAddress,
  refusedSignalingEndpointField,
  resolveInviterSignalingAddress,
} from "@psi/transport/signalingAddress";
import {
  coordinationServerFormMessage,
  parseCoordinationServerUrl,
} from "@psi/transport/coordinationServerSetting";
import {
  parseRelayUrlLines,
  parseWebSocketRelayUrl,
} from "@psi/transport/ownRelaySetting";

import type {
  ManagedExchangeLocalEdits,
  ManagedExchangeRecord,
} from "@psi/managed/managedExchangeRecord";
import type { OwnRelay, RelayUrlLines } from "@psi/transport/ownRelaySetting";
import type { SignalingAddress } from "@psi/transport/signalingAddress";

/** What the operator typed in the Connection settings fields. */
export interface ConnectionSettingsText {
  server: string;
  turn: string;
  stun: string;
  websocket: string;
  defaultRelayOn: boolean;
}

/** The field errors of {@link ConnectionSettingsText}, each absent where its
 * field can be saved. */
export interface ConnectionSettingsErrors {
  server?: string;
  turn?: string;
  stun?: string;
  websocket?: string;
}

/**
 * The address of the coordination server `record` names, as a page served
 * with `pageProtocol` dials it, or blank where it names none. A port the
 * scheme uses by default is left out.
 */
export function signalingServerText(
  record: Pick<ManagedExchangeRecord, "exchangeFile">,
  pageProtocol: string,
): string {
  const connection = record.exchangeFile.connection;
  if (connection.channel !== "webrtc") return "";
  return addressText(connection.server, pageProtocol);
}

/** The address of this site's own coordination server, as
 * {@link signalingServerText} shows it: what a new invitation's
 * Coordination server field starts from. Browser only. */
export function siteSignalingServerText(pageProtocol: string): string {
  return addressText(ownSignalingAddress(), pageProtocol);
}

function addressText(
  { host, port, path }: { host: string; port?: number; path?: string },
  pageProtocol: string,
): string {
  const secure = pageProtocol === "https:";
  const statedPort =
    port === undefined || port === (secure ? 443 : 80) ? "" : `:${port}`;
  return `${secure ? "wss" : "ws"}://${host}${statedPort}${path ?? OWN_SIGNALING_PATH}`;
}

/** The fields' starting text: what `record` holds. */
export function connectionSettingsTextFrom(
  record: Pick<
    ManagedExchangeRecord,
    "exchangeFile" | "ownRelay" | "defaultRelayOn"
  >,
  pageProtocol: string,
): ConnectionSettingsText {
  return {
    server: signalingServerText(record, pageProtocol),
    turn: record.ownRelay?.turn.join("\n") ?? "",
    stun: record.ownRelay?.stun.join("\n") ?? "",
    websocket: record.ownRelay?.websocket ?? "",
    defaultRelayOn: record.defaultRelayOn === true,
  };
}

function linesError(lines: RelayUrlLines): string | undefined {
  if (lines.ok) return undefined;
  return lines.problems
    .map((problem) =>
      problem.line === undefined
        ? problem.message
        : `Line ${problem.line}: ${problem.message}`,
    )
    .join("; ");
}

/** What {@link connectionSettingsEdits} made of the typed text. */
export type ConnectionSettingsRead =
  | { ok: true; edits: ManagedExchangeLocalEdits }
  | { ok: false; errors: ConnectionSettingsErrors };

/**
 * The edits `text` asks for, or the error of each field it cannot save. The
 * server is written only where its text changed from `saved`, so an
 * untouched server keeps the port and path the record states. Relay fields
 * naming no url drop the exchange's own relays.
 */
export function connectionSettingsEdits(
  text: ConnectionSettingsText,
  saved: string,
  pageProtocol: string,
): ConnectionSettingsRead {
  const errors: ConnectionSettingsErrors = {};
  let signalingServer: ManagedExchangeLocalEdits["signalingServer"];
  if (text.server.trim() !== saved) {
    const entry = parseCoordinationServerUrl(text.server, pageProtocol);
    if (!entry.ok) errors.server = entry.message;
    else if (entry.url === undefined)
      errors.server = coordinationServerFormMessage(pageProtocol);
    else {
      const address = resolveInviterSignalingAddress(
        entry.url,
        ownSignalingAddress,
      );
      if (refusedSignalingEndpointField(address) !== undefined)
        errors.server = coordinationServerFormMessage(pageProtocol);
      else
        signalingServer = {
          host: address.host,
          ...(address.port !== undefined ? { port: address.port } : {}),
          path: address.path,
        };
    }
  }
  const turn = parseRelayUrlLines(text.turn, "turn");
  const stun = parseRelayUrlLines(text.stun, "stun");
  const websocket = parseWebSocketRelayUrl(text.websocket);
  const turnError = linesError(turn);
  const stunError = linesError(stun);
  if (turnError !== undefined) errors.turn = turnError;
  if (stunError !== undefined) errors.stun = stunError;
  if (!websocket.ok) errors.websocket = websocket.message;
  if (!turn.ok || !stun.ok || !websocket.ok || Object.keys(errors).length > 0)
    return { ok: false, errors };
  const named =
    turn.urls.length + stun.urls.length > 0 || websocket.url !== undefined;
  return {
    ok: true,
    edits: {
      ...(signalingServer !== undefined ? { signalingServer } : {}),
      ownRelay: named
        ? {
            turn: turn.urls,
            stun: stun.urls,
            ...(websocket.url !== undefined
              ? { websocket: websocket.url }
              : {}),
          }
        : null,
      defaultRelayOn: text.defaultRelayOn,
    },
  };
}

/** What {@link exchangeConnectionRead} made of the typed text. */
export type ExchangeConnectionRead =
  | {
      ok: true;
      /** Absent where the server is this site's own. */
      signaling?: SignalingAddress;
      ownRelay?: OwnRelay;
      defaultRelayOn: boolean;
    }
  | { ok: false; errors: ConnectionSettingsErrors };

/**
 * The settings `text` names for an invitation this page creates or accepts,
 * or the error of each field it cannot use: the coordination server where
 * its text changed from `site`, this site's own address, the exchange's own
 * relay where its fields name a url, and its switch. An accepted
 * invitation's settings have no server field, so their blank server and
 * `site` agree.
 */
export function exchangeConnectionRead(
  text: ConnectionSettingsText,
  site: string,
  pageProtocol: string,
): ExchangeConnectionRead {
  const read = connectionSettingsEdits(text, site, pageProtocol);
  if (!read.ok) return read;
  const { signalingServer, ownRelay } = read.edits;
  return {
    ok: true,
    ...(signalingServer !== undefined && {
      signaling: {
        ...signalingServer,
        path: signalingServer.path ?? OWN_SIGNALING_PATH,
        secure: pageProtocol === "https:",
      },
    }),
    ...(ownRelay !== undefined && ownRelay !== null && { ownRelay }),
    defaultRelayOn: text.defaultRelayOn,
  };
}
