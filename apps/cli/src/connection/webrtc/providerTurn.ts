import {
  ConnectionError,
  isTurnProviderEntry,
  markStatesItsOwnNextStep,
  mintProviderTurnCredential,
  mintRunRelayCredential,
  providerTurnEntryToMint,
  TURN_PROVIDER_MINT_HOSTS,
  TURN_PROVIDER_NAMES,
  TURN_PROVIDER_REQUEST_TIMEOUT_MS,
  UsageError,
} from "@alcove/core";

import {
  DEFAULT_CHANNEL_OPEN_TIMEOUT_MS,
  FINAL_ATTEMPT_STRETCH,
  WEBRTC_ATTEMPT_MS,
  iceServersFromConnection,
  newAttemptClause,
} from "./weriftPeer";

import type { AttemptIceServers } from "./weriftPeer";
import type {
  TurnEntry,
  TurnProviderEntry,
  TurnProviderMintOutcome,
  TurnProviderTransport,
  WebRTCConnectionConfig,
} from "@alcove/core";

/**
 * The servers a run minted for the provider `turn` entry it uses
 * (docs/spec/RELAY_CREDENTIALS.md, "Provider-minted credentials").
 */
export interface ProviderTurnRun {
  /**
   * The connection with the minted servers, each with the minted
   * credential, in the minted entry's place, and every other provider entry
   * left out.
   */
  connection: WebRTCConnectionConfig;
  /** The minted entry's provider, for the run's notices. */
  provider: TurnProviderEntry["provider"];
  /** When the minted credential expires. */
  expiresAt: Date;
  /** Mint the same entry again, as for a later connection attempt. */
  mintAgain: () => Promise<ProviderTurnRun>;
}

/**
 * The shortest lifetime a minted credential must have left for a connection
 * attempt to start with it: the longest an attempt runs, the last one
 * stretched and a channel-open budget after it. An attempt that would outlast
 * the credential starts with a newly minted one.
 */
export const PROVIDER_TURN_ATTEMPT_LIFETIME_MS =
  WEBRTC_ATTEMPT_MS * FINAL_ATTEMPT_STRETCH + DEFAULT_CHANNEL_OPEN_TIMEOUT_MS;

/**
 * The failure a mint that did not yield servers becomes: what the provider
 * answered, and what to do. A refusal of the token or key id is a usage
 * error, the operator's configuration to fix; any other outcome is a
 * transport failure. Built from the provider and the outcome alone, so it
 * holds no token.
 *
 * @internal exported for testing
 */
export function providerTurnMintError(
  provider: TurnProviderEntry["provider"],
  outcome: Exclude<TurnProviderMintOutcome, { kind: "minted" }>,
): Error {
  const name = TURN_PROVIDER_NAMES[provider];
  const notMinted = `${name} did not mint a TURN credential for this run`;
  switch (outcome.kind) {
    case "refused": {
      const answered = `${notMinted}: it answered HTTP ${outcome.status}.`;
      if (outcome.status === 401 || outcome.status === 403)
        return markStatesItsOwnNextStep(
          new UsageError(
            `${answered} Check that the file the turn entry's api_token ` +
              "names holds the API token of the TURN key its key_id names, " +
              "and run the exchange again.",
          ),
        );
      if (outcome.status === 404)
        return markStatesItsOwnNextStep(
          new UsageError(
            `${answered} Check that the turn entry's key_id names a TURN ` +
              `key in your ${name} account, and run the exchange again.`,
          ),
        );
      return markStatesItsOwnNextStep(
        new ConnectionError(
          `${answered} Run the exchange again later.`,
          "transport",
        ),
      );
    }
    case "unreachable":
      return markStatesItsOwnNextStep(
        new ConnectionError(
          outcome.reason === "timeout"
            ? `${notMinted}: it did not answer within ` +
                `${TURN_PROVIDER_REQUEST_TIMEOUT_MS / 1000} seconds. Check ` +
                `that this computer can reach ${name} over HTTPS, and run ` +
                "the exchange again."
            : `${notMinted}: it could not be reached. Check that this ` +
                `computer can reach ${name} over HTTPS, and run the ` +
                "exchange again.",
          "transport",
        ),
      );
    case "malformed":
      return markStatesItsOwnNextStep(
        new ConnectionError(
          outcome.problem === "no-kept-url"
            ? `${notMinted}: its answer listed no turns: url on its own ` +
                "host with a credential. Run the exchange again later."
            : `${notMinted}: its answer was not a list of TURN servers. Run ` +
                "the exchange again later.",
          "transport",
        ),
      );
  }
}

/**
 * Mint the servers of the provider `turn` entry the run would use
 * (`providerTurnEntryToMint`), or return `undefined` when it uses none. No
 * other provider entry is minted. The token is read from the entry, already
 * resolved, and goes to the provider alone.
 *
 * @throws {UsageError | ConnectionError} {@link providerTurnMintError} when
 *   the mint does not yield servers.
 */
export async function mintProviderTurn(
  connection: WebRTCConnectionConfig,
  transport: TurnProviderTransport = {},
): Promise<ProviderTurnRun | undefined> {
  const entry = providerTurnEntryToMint(connection);
  if (entry === undefined) return undefined;
  return mintProviderEntry(connection, entry, transport);
}

async function mintProviderEntry(
  connection: WebRTCConnectionConfig,
  entry: TurnProviderEntry,
  transport: TurnProviderTransport,
): Promise<ProviderTurnRun> {
  const outcome = await mintProviderTurnCredential(entry, transport);
  if (outcome.kind !== "minted")
    throw providerTurnMintError(entry.provider, outcome);
  const turn = (connection.turn ?? []).flatMap((listed): TurnEntry[] =>
    listed === entry
      ? outcome.servers
      : isTurnProviderEntry(listed)
        ? []
        : [listed],
  );
  return {
    connection: { ...connection, turn },
    provider: entry.provider,
    expiresAt: outcome.expiresAt,
    mintAgain: () => mintProviderEntry(connection, entry, transport),
  };
}

/**
 * The line `doctor relay` states before it mints a provider entry's servers,
 * since the mint contacts the provider before the check's host statement.
 */
export function providerTurnMintStatement(
  provider: TurnProviderEntry["provider"],
): string {
  const name = TURN_PROVIDER_NAMES[provider];
  return (
    `This check first asks ${name} for a TURN credential at ` +
    `${TURN_PROVIDER_MINT_HOSTS[provider]}, as a run of this configuration ` +
    `does. ${name} learns this machine's network address.`
  );
}

/**
 * The line a run prints when it holds minted provider credentials: the
 * provider and the expiry. The credential itself is
 * never printed.
 */
export function providerTurnNotice(run: ProviderTurnRun): string {
  return (
    `the ${TURN_PROVIDER_NAMES[run.provider]} TURN credential was ` +
    `minted for this run and expires at ${run.expiresAt.toISOString()}`
  );
}

/**
 * The ICE servers each connection attempt after the first dials with, for a
 * run whose `turn` lists a provider entry: the servers minted last, minted
 * again first when the attempt would outlast their credential
 * ({@link PROVIDER_TURN_ATTEMPT_LIFETIME_MS}). With `derivedFrom` set, the
 * run's derived credential is also minted as each attempt starts, as
 * `relayCredentialPerAttempt` mints it.
 */
export function providerTurnPerAttempt(
  run: ProviderTurnRun,
  derivedFrom: string | undefined,
  now: () => Date = () => new Date(),
): AttemptIceServers {
  let current = run;
  return async (reason) => {
    const startsAt = now();
    const outlasts =
      current.expiresAt.getTime() - startsAt.getTime() <
      PROVIDER_TURN_ATTEMPT_LIFETIME_MS;
    if (outlasts) current = await current.mintAgain();
    const derived =
      derivedFrom === undefined
        ? undefined
        : await mintRunRelayCredential(derivedFrom, startsAt);
    const name = TURN_PROVIDER_NAMES[current.provider];
    const minted =
      `${outlasts ? "a new" : "the"} ${name} TURN credential that expires ` +
      `at ${current.expiresAt.toISOString()}`;
    return {
      iceServers: iceServersFromConnection(current.connection, derived),
      notice:
        `${newAttemptClause(reason)} with ${minted}` +
        (derived === undefined
          ? ""
          : ` and a new relay credential that expires at ` +
            derived.expiresAt.toISOString()),
    };
  };
}
