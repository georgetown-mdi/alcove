// What a relay check says a cause means and what to do about it, held here so
// `alcove doctor relay` and the console that shows its verdict state each
// cause alike. The web app's check of an exchange's relays words each cause
// itself. Contract: docs/spec/CLI_DOCTOR.md, The relay check.

/** A cause's meaning and the change that fixes it. */
export interface RelayCheckWords {
  meaning: string;
  action: string;
}

/**
 * What to do when no relay candidate was gathered from a configured relay,
 * as docs/CLI.md, When a WebRTC exchange does not connect, states it.
 */
export const RELAY_NOT_REACHED_REMEDY =
  "Fix the relay, or arrange a direct path; waiting longer changes nothing.";

/** What a TURN relay that gave no relay candidate means, its cause unread. */
export const TURN_RELAY_NOT_REACHED_MEANING =
  "nothing on this host reached this relay, the relay refused the " +
  "credential, or it presented a certificate this host does not trust; " +
  "the reason is not reported, so the check cannot tell which.";

/** Why a relay keyed by its registrar refuses a run, where a run enrolls there. */
export const RELAY_REFUSES_UNTIL_ENROLLED_AT_REGISTRAR =
  "this relay refuses the credential derived from the exchange's shared " +
  "secret until the exchange's relay key is enrolled at its registrar.";

/** Why the relay an invitation names refuses a run whose key is not enrolled. */
export const INVITATION_RELAY_REFUSES_UNTIL_ENROLLED =
  "This relay refuses the credential derived from the exchange's shared " +
  "secret until the exchange's relay key is enrolled there.";

/** Why a relay of one's own refuses a run whose key is not enrolled. */
export const OWN_RELAY_REFUSES_UNTIL_ENROLLED =
  "A relay that takes enrolled keys refuses the credential derived from " +
  "the exchange's shared secret until the exchange's relay key is enrolled " +
  "there with alcove enroll-relay.";

/** What a TURN relay that answered and refused the credential means. */
export const TURN_RELAY_CREDENTIAL_REFUSED_MEANING =
  "the relay answered and refused the credential derived from the " +
  "exchange's shared secret.";

/**
 * What a TURN relay that gave both of the check's connections a relay
 * address, and passed no message between them, means.
 */
export const TURN_RELAY_NO_RELAYED_PATH_MEANING =
  "the relay gave each of the check's two connections a relay address, but " +
  "no message passed between them through it.";

/**
 * What a WebSocket relay that admitted both of the check's sockets, and
 * passed no message between them, means.
 */
export const WEBSOCKET_RELAY_NO_RELAYED_PATH_MEANING =
  "the relay admitted this exchange's proof on both of the check's " +
  "connections and paired them, but no message passed between them through " +
  "it.";

const WEBSOCKET_RELAY_RETRY = "then run this check again.";

/** What a WebSocket relay that was not reached means. */
export const WEBSOCKET_RELAY_NOT_REACHED_MEANING =
  "nothing on this host reached this url as an Alcove WebSocket relay: the " +
  "network blocked it, nothing answered at that address and path, or the " +
  "connection closed before the relay answered the proof.";

/** What to do about a WebSocket relay that was not reached. */
export const WEBSOCKET_RELAY_NOT_REACHED_ACTION =
  "Check that this host can reach the relay and that the url names its " +
  `address and path, ${WEBSOCKET_RELAY_RETRY}`;

/** A WebSocket relay that answered the proof with a message it does not send. */
export const WEBSOCKET_RELAY_UNEXPECTED_MESSAGE_WORDS: RelayCheckWords = {
  meaning:
    "the relay answered the proof with a message an Alcove WebSocket " +
    "relay does not send at that point, so the url may not name an " +
    "Alcove WebSocket relay.",
  action:
    "Check that the url names an Alcove WebSocket relay, " +
    WEBSOCKET_RELAY_RETRY,
};

/** What a WebSocket relay's refusal of the proof is read against. */
export interface WebSocketRelayRefusalContext {
  /** A run enrolls at the invitation's registrar on this relay's account. */
  enrollsAtInvitationRegistrar: boolean;
  /** The relay is the invitation's, dialed under the exchange id it names. */
  partnersUnderInvitationExchangeId: boolean;
  /** The enrollment made before the check failed, and a run enrolls there on
   * this relay's account. */
  enrollmentFailed: boolean;
  /** A 4005 came after a proof made again on the relay's own clock. */
  proofRemadeOnRelayClock?: boolean;
}

/**
 * What a WebSocket relay's refusal of the hello with `closeCode` means, and
 * what to do (docs/spec/CLI_DOCTOR.md, The relay check, the WebSocket relay
 * outcomes).
 */
export function webSocketRelayRefusalWords(
  closeCode: number,
  context: WebSocketRelayRefusalContext,
): RelayCheckWords {
  switch (closeCode) {
    case 4003:
      return {
        meaning:
          "the relay holds no key for this exchange, so it refuses the " +
          "proof a run presents until the exchange's relay key is enrolled " +
          "there." +
          (context.enrollmentFailed
            ? " The likely cause is the failed enrollment above."
            : ""),
        action: context.enrollsAtInvitationRegistrar
          ? "Run this check again. If the relay still holds no key, ask " +
            "your partner whether the relay registrar their invitation " +
            "names is up, since either of you enrolling the exchange there " +
            "lets the relay admit it."
          : context.partnersUnderInvitationExchangeId
            ? "Ask your partner to enroll this exchange's relay key at " +
              "their relay's registrar by running alcove enroll-relay with " +
              "their relay-owner token, which this side does not hold, " +
              WEBSOCKET_RELAY_RETRY
            : "Enroll this exchange's relay key at the relay's registrar " +
              `with alcove enroll-relay, ${WEBSOCKET_RELAY_RETRY}`,
      };
    case 4004:
      return {
        meaning:
          "the relay holds a key for this exchange other than the one this " +
          "side's shared secret derives, so it refuses the proof a run " +
          "presents.",
        action:
          "Register the current key with alcove enroll-relay " +
          `--replace-relay-key, ${WEBSOCKET_RELAY_RETRY}`,
      };
    case 4005:
      return context.proofRemadeOnRelayClock === true
        ? {
            meaning:
              "the relay refused the proof a run presents as expired twice, " +
              "the second time a proof made on the relay's own clock, so " +
              "this computer's clock is not the cause.",
            action:
              "Run this check again. If the relay refuses the proof the " +
              "same way, check the relay and the exchange's enrollment at " +
              "its registrar.",
          }
        : {
            meaning:
              "the relay refused the proof a run presents as expired " +
              "without stating its own clock, so the proof could not be " +
              "made again on that clock, and this computer's clock and the " +
              "relay's may differ by more than five minutes.",
            action:
              `Correct this computer's clock, ${WEBSOCKET_RELAY_RETRY} If ` +
              "the relay refuses the proof the same way, ask the relay's " +
              "operator to check its clock.",
          };
    case 4007:
      return {
        meaning:
          "the relay received no proof from this side within 10 seconds of " +
          "the connection opening, so something on the path may be slow or " +
          "holding messages back.",
        action:
          "Check the network path to the relay, including any proxy, " +
          WEBSOCKET_RELAY_RETRY,
      };
    case 4008:
      return {
        meaning:
          "the relay is serving as many exchanges as it allows, so it " +
          "refuses a run that arrives now.",
        action: "Run this check again later.",
      };
    case 1011:
      return {
        meaning: "the relay could not check the proof a run presents.",
        action:
          "Ask the relay's operator to check its key table, " +
          WEBSOCKET_RELAY_RETRY,
      };
    case 1001:
      return {
        meaning: "the relay is shutting down.",
        action: "Run this check again once the relay is back.",
      };
    default:
      return {
        meaning:
          "the relay refused a message this side sent before it admitted " +
          "the proof, so it may not be an Alcove WebSocket relay.",
        action:
          "Check that the url names an Alcove WebSocket relay, " +
          WEBSOCKET_RELAY_RETRY,
      };
  }
}
