import { enc, hkdfDerive, hmacSha256, sha256, toHex } from "./utils/crypto.js";
import { InternalConsistencyError } from "./errors.js";

/**
 * The `Authorization` scheme of a request to the relay registrar proving it
 * holds the exchange's registered relay key (docs/spec/PROTOCOL.md, "The
 * registrar request proof").
 */
export const RELAY_REGISTRAR_PROOF_SCHEME = "Alcove-Relay-Proof";

const PROOF_KEY_INFO = "alcove-relay-registrar-v2:proof-key";
const PROOF_MESSAGE_LABEL = "alcove-relay-registrar-v2:request";
const PROOF_KEY_BYTES = 32;

const RELAY_KEY_PATTERN = /^[0-9a-f]{64}$/;
// The registrar's exchange-id rule (valid_exchange_id in
// infra/relay/relay_table.py): the EXCHANGE_ID alphabet, which admits no
// newline, the signed message's field separator, and no HEX_RUN of 64 hex
// characters.
const EXCHANGE_ID_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,127}$/;
const EXCHANGE_ID_HEX_RUN = /[0-9A-Fa-f]{64}/;

/**
 * Whether `exchangeId` is an id the registrar takes in a request path and a
 * proof can be made for: 1 to 128 of `[A-Za-z0-9._-]`, not starting with `-`,
 * and holding no run of 64 hex characters.
 */
export function isRelayRegistrarExchangeId(exchangeId: string): boolean {
  return (
    EXCHANGE_ID_PATTERN.test(exchangeId) &&
    !EXCHANGE_ID_HEX_RUN.test(exchangeId)
  );
}

/** The registrar methods a proof authorizes: a rotation and a revocation. */
export type RelayRegistrarProofMethod = "PUT" | "DELETE";

const PROOF_METHODS: readonly RelayRegistrarProofMethod[] = ["PUT", "DELETE"];

/** Arguments to {@link relayRegistrarAuthorization}. */
export interface RelayRegistrarProofOptions {
  /**
   * The relay key the registrar holds for the exchange, as 64 lowercase hex
   * characters: for a rotation, the key being replaced.
   */
  relayKey: string;
  method: RelayRegistrarProofMethod;
  /** The exchange id, exactly as it appears in the request path. */
  exchangeId: string;
  /**
   * The request body exactly as sent; a string is signed as its UTF-8 bytes.
   * Empty for a revocation.
   */
  body: Uint8Array<ArrayBuffer> | string;
  /** The time the proof is made at, which the registrar holds to its clock. */
  now: Date;
}

/**
 * Derive the key a registrar request proof is signed under from the relay
 * key's 32 decoded bytes.
 *
 * @internal
 */
export async function deriveRelayRegistrarProofKey(
  relayKey: string,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!RELAY_KEY_PATTERN.test(relayKey)) {
    throw new InternalConsistencyError(
      "deriveRelayRegistrarProofKey: relayKey must be 64 lowercase hex characters",
    );
  }
  const bytes = new Uint8Array(PROOF_KEY_BYTES);
  for (let i = 0; i < PROOF_KEY_BYTES; i++) {
    bytes[i] = Number.parseInt(relayKey.slice(2 * i, 2 * i + 2), 16);
  }
  return hkdfDerive(bytes, PROOF_KEY_INFO, PROOF_KEY_BYTES);
}

/**
 * The `Authorization` header value proving a request to the relay registrar
 * holds `relayKey`: a rotation (`PUT`) or revocation (`DELETE`) of an enrolled
 * exchange. It holds no relay-owner token. The format: docs/spec/PROTOCOL.md,
 * "The registrar request proof".
 *
 * @throws {Error} if `relayKey` is not 64 lowercase hex characters, `method`
 *   is not `PUT` or `DELETE`, `exchangeId` is an id the registrar refuses, or
 *   `now` is not a valid date at or after the Unix epoch.
 */
export async function relayRegistrarAuthorization({
  relayKey,
  method,
  exchangeId,
  body,
  now,
}: RelayRegistrarProofOptions): Promise<string> {
  if (!PROOF_METHODS.includes(method)) {
    throw new InternalConsistencyError(
      `relayRegistrarAuthorization: method ${JSON.stringify(method)} must be PUT or DELETE`,
    );
  }
  if (!isRelayRegistrarExchangeId(exchangeId)) {
    throw new InternalConsistencyError(
      "relayRegistrarAuthorization: exchangeId must be 1 to 128 of " +
        "[A-Za-z0-9._-], not starting with '-' and not containing a run of " +
        "64 hex characters",
    );
  }
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs) || nowMs < 0) {
    throw new InternalConsistencyError(
      "relayRegistrarAuthorization: now is not a valid date at or after the Unix epoch",
    );
  }
  const timestamp = Math.floor(nowMs / 1000);
  const key = await deriveRelayRegistrarProofKey(relayKey);
  const bodyBytes = typeof body === "string" ? enc.encode(body) : body;
  const message = [
    PROOF_MESSAGE_LABEL,
    method,
    exchangeId,
    toHex(await sha256(bodyBytes)),
    String(timestamp),
  ].join("\n");
  const mac = toHex(await hmacSha256(key, enc.encode(message)));
  return `${RELAY_REGISTRAR_PROOF_SCHEME} ts=${timestamp},mac=${mac}`;
}
