// Diagnoses a dial that failed before the peer identified itself as an SSH
// server. ssh2 discards the peer's bytes and rejects every such cause with one
// message (docs/spec/DEPENDENCY_PINS.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client),
// so this module reads them on a second, bounded, credential-free connection.
// Rules: docs/spec/CHANNEL_SECURITY.md#sftp-host-key-verification, "Diagnosing
// a peer that never identifies itself".

import net from "node:net";

import {
  causeChainSome,
  chainDetailCauses,
  redactPrivateKeyMaterial,
} from "@alcove/core";

/** The port ssh2 dials when connect options hold none. */
const SSH2_DEFAULT_PORT = 22;

/**
 * Ceiling on the whole read, connect included; {@link diagnosePeerAnswer}
 * also clamps it to the failed dial's connect budget.
 */
export const PEER_ANSWER_READ_BUDGET_MS = 2_000;

/**
 * Bytes {@link observePeerAnswer} retains before it stops reading, above
 * {@link PEER_EXCERPT_MAX_BYTES} so an identification string after a preamble
 * line is still found. It bounds what is kept, not what arrives: the socket is
 * never paused, so one delivery may be larger.
 */
export const PEER_ANSWER_READ_MAX_BYTES = 512;

/**
 * Bytes of the peer's answer kept in the diagnostic, sized so the excerpt fits
 * one display link even when every byte escapes to four characters. Applied
 * after the private-key strip (see {@link classifyPeerAnswer}).
 */
export const PEER_EXCERPT_MAX_BYTES = 128;

/** The shapes {@link observePeerAnswer} names in the operator's copy. */
export type PeerAnswerShape = "http" | "tls-alert" | "unrecognized";

/**
 * What a credential-free read of the peer's first bytes established.
 *
 * @internal
 */
export type PeerAnswer =
  /** The peer sent an SSH identification string: it is an SSH server, and the
   * dial failed for some other reason. */
  | { kind: "identified" }
  /** The peer sent bytes that are not an SSH identification string. `excerpt`
   * is its first bytes, redacted and clipped by {@link classifyPeerAnswer}. */
  | { kind: "non-ssh"; shape: PeerAnswerShape; excerpt: string }
  /** The peer accepted the connection and then closed or reset it having sent
   * nothing at all. */
  | { kind: "closed-unanswered" }
  /** Nothing was established: no connection, or one that stayed silent until
   * the budget ran out, which a slow server cannot be told apart from. */
  | { kind: "unobserved" };

/**
 * The rejection fragments the pinned stack raises for a dial that ended
 * before the peer identified itself (see DEPENDENCY_PINS.md). A stack that
 * rewords them only stops the diagnosis: an unmatched rejection is returned
 * as it stands.
 */
const PRE_IDENTIFICATION_FAILURE_FRAGMENTS = [
  "Connection lost before handshake",
  "ECONNRESET",
] as const;

/**
 * Whether `error` is a dial rejection raised before the peer identified
 * itself. Walks the cause chain, so a re-raise that keeps the rejection as
 * its cause still matches.
 *
 * @internal
 */
export function isPreIdentificationDialFailure(error: unknown): boolean {
  return causeChainSome(
    error,
    (link) =>
      link instanceof Error &&
      PRE_IDENTIFICATION_FAILURE_FRAGMENTS.some((fragment) =>
        link.message.includes(fragment),
      ),
  );
}

/**
 * An SSH identification string at a line start (RFC 4253 section 4.2 allows
 * other lines ahead of it), so `SSH-` inside an HTML page does not match.
 */
const SSH_IDENTIFICATION_LINE = /(?:^|\r|\n)SSH-/;

/** A TLS record whose content type is `alert` (21) followed by a 3.x version. */
const isTlsAlertRecord = (bytes: Uint8Array): boolean =>
  bytes.length >= 5 && bytes[0] === 0x15 && bytes[1] === 0x03;

/**
 * Classify what the peer sent, decoded latin1 so every byte maps to one code
 * point the display can escape losslessly. The excerpt is redacted before it
 * is clipped, since a clip could cut a private-key marker in half; the
 * classification reads the unredacted text, so a planted marker cannot hide
 * an identification string.
 */
function classifyPeerAnswer(bytes: Uint8Array): PeerAnswer {
  if (bytes.length === 0) return { kind: "closed-unanswered" };
  const text = Buffer.from(bytes).toString("latin1");
  if (SSH_IDENTIFICATION_LINE.test(text)) return { kind: "identified" };
  const shape: PeerAnswerShape = isTlsAlertRecord(bytes)
    ? "tls-alert"
    : text.startsWith("HTTP/")
      ? "http"
      : "unrecognized";
  return {
    kind: "non-ssh",
    shape,
    excerpt: redactPrivateKeyMaterial(text).slice(0, PEER_EXCERPT_MAX_BYTES),
  };
}

/**
 * Open one TCP connection to `host:port` and classify what the peer sends
 * within `budgetMs`. Writes nothing, since the host-key probe presents
 * nothing to an unverified server. Best-effort: a second connection may reach
 * a different peer behind a load balancer.
 *
 * @internal
 */
export function observePeerAnswer(
  target: { host: string; port: number },
  budgetMs: number,
): Promise<PeerAnswer> {
  return new Promise<PeerAnswer>((resolve) => {
    let observed = Buffer.alloc(0);
    let settled = false;
    const socket = net.connect({ host: target.host, port: target.port });
    const settle = (answer: PeerAnswer): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve(answer);
    };
    const deadline = setTimeout(() => {
      settle(
        observed.length > 0
          ? classifyPeerAnswer(observed)
          : { kind: "unobserved" },
      );
    }, budgetMs);
    socket.on("data", (chunk: Buffer) => {
      observed = Buffer.concat([
        observed,
        chunk.subarray(0, PEER_ANSWER_READ_MAX_BYTES - observed.length),
      ]);
      if (observed.length >= PEER_ANSWER_READ_MAX_BYTES)
        settle(classifyPeerAnswer(observed));
    });
    socket.on("end", () => settle(classifyPeerAnswer(observed)));
    socket.on("close", () => settle(classifyPeerAnswer(observed)));
    socket.on("error", (err: NodeJS.ErrnoException) => {
      // A reset after accepting is the same "sent nothing" case as a clean
      // close; any other errno means no connection, which the rejection
      // already reports.
      if (observed.length > 0) settle(classifyPeerAnswer(observed));
      else
        settle(
          err.code === "ECONNRESET"
            ? { kind: "closed-unanswered" }
            : { kind: "unobserved" },
        );
    });
  });
}

/**
 * The {@link PeerAnswer} arms that compose a diagnostic, held on the raised
 * error for machine consumers. `excerpt` is already redacted.
 */
export type PeerIdentificationDiagnosis =
  | { kind: "non-ssh"; shape: PeerAnswerShape; excerpt: string }
  | { kind: "closed-unanswered" };

/** The diagnostic this module raises, holding the
 * {@link PeerIdentificationDiagnosis} its message was written from. */
class PeerIdentificationError extends Error {
  constructor(
    message: string,
    readonly diagnosis: PeerIdentificationDiagnosis,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PeerIdentificationError";
  }
}

/**
 * The diagnosis anywhere in a failure's cause chain, or undefined.
 *
 * @internal
 */
export function peerIdentificationDiagnosisOf(
  error: unknown,
): PeerIdentificationDiagnosis | undefined {
  let found: PeerIdentificationDiagnosis | undefined;
  causeChainSome(error, (link) => {
    if (!(link instanceof PeerIdentificationError)) return false;
    found = link.diagnosis;
    return true;
  });
  return found;
}

/**
 * What the peer's first bytes held, worded as a likelihood: an SSH server
 * whose preamble outruns either read bound lands here too.
 */
const NON_SSH_SHAPE_DESCRIPTION: Record<PeerAnswerShape, string> = {
  http:
    `an HTTP response, not an SSH identification string -- most likely a web ` +
    `server, or a proxy or gateway intercepting this port`,
  "tls-alert":
    `a TLS alert record, not an SSH identification string -- most likely a ` +
    `service speaking TLS, or a TLS-terminating proxy`,
  unrecognized:
    `not an SSH identification string -- most likely something other than an ` +
    `SSH server answering this port`,
};

/**
 * How the second connection was made. A cause link of its own, since with the
 * recovery step it would outgrow one link's display budget.
 */
const READ_PROVENANCE =
  `Alcove read this on a second connection to the same endpoint, opened ` +
  `after the dial failed and carrying no credential.`;

/**
 * Compose the operator-facing diagnostic, or return `error` untouched when the
 * read established nothing. The rejection stays the last cause link, and the
 * peer's excerpt and the configured endpoint each take a link of their own so
 * neither can crowd out the recovery step.
 *
 * @internal
 */
export function explainPeerIdentificationFailure(
  error: unknown,
  answer: PeerAnswer,
  endpoint: { host: string; port: number },
): unknown {
  if (answer.kind === "identified" || answer.kind === "unobserved")
    return error;
  const endpointDetail =
    `configured endpoint: ` +
    `${redactPrivateKeyMaterial(endpoint.host)}:${endpoint.port}`;
  if (answer.kind === "closed-unanswered")
    return new PeerIdentificationError(
      `the SFTP server never identified itself: the peer accepted the ` +
        `connection and closed it having sent nothing. An SSH server sends ` +
        `its identification string first, so the connection was most likely ` +
        `stopped in front of the server.`,
      { kind: "closed-unanswered" },
      {
        cause: chainDetailCauses(
          [
            `The usual cause is a firewall or gateway enforcing a source-IP ` +
              `allowlist this host is not on, though a connection throttle ` +
              `reads the same way: ask whoever administers the server ` +
              `whether this host's address may reach the SFTP port.`,
            READ_PROVENANCE,
            endpointDetail,
          ],
          error,
        ),
      },
    );
  return new PeerIdentificationError(
    `the SFTP server did not identify itself: the first bytes the peer ` +
      `answering this endpoint sent were ` +
      `${NON_SSH_SHAPE_DESCRIPTION[answer.shape]}.`,
    { kind: "non-ssh", shape: answer.shape, excerpt: answer.excerpt },
    {
      cause: chainDetailCauses(
        [
          `Check that the configured host and port name the SFTP service, and ` +
            `that no proxy or middlebox stands in front of them. An SSH ` +
            `server whose banner approaches the ` +
            `${PEER_ANSWER_READ_MAX_BYTES}-byte read bound, or that ` +
            `identifies itself late, reads this way too.`,
          READ_PROVENANCE,
          endpointDetail,
          `first bytes the peer sent; PEM private-key blocks replaced: ${answer.excerpt}`,
        ],
        error,
      ),
    },
  );
}

/**
 * The endpoint the failed dial used, read from ssh2's connect options, whose
 * `host` and `port` core assigns after its `providerOptions` filter. A
 * portless config takes {@link SSH2_DEFAULT_PORT}, held equal to the pinned
 * stack's by `apps/cli/test/integration/sftpStackPremises.test.ts`.
 * `undefined` when there is no host or the port is not a number, since the
 * endpoint cannot then be reproduced.
 *
 * @internal
 */
export function peerProbeTargetFromConnectOptions(options: {
  host?: unknown;
  port?: unknown;
}): { host: string; port: number } | undefined {
  const { host, port } = options;
  if (typeof host !== "string" || host === "") return undefined;
  if (port !== undefined && typeof port !== "number") return undefined;
  return { host, port: port ?? SSH2_DEFAULT_PORT };
}

/**
 * Read the peer's first bytes and compose what they say about `error`, which
 * the caller has already passed through {@link isPreIdentificationDialFailure}
 * (the caller owns the once-per-connection gate). Called only from the
 * transport adapter's dial sequence. The read is clamped to
 * `connectBudgetMs`, the failed dial's connect budget.
 *
 * @internal
 */
export async function diagnosePeerAnswer(
  error: unknown,
  endpoint: { host: string; port: number },
  connectBudgetMs: number | undefined,
): Promise<unknown> {
  const budgetMs = Math.min(
    PEER_ANSWER_READ_BUDGET_MS,
    connectBudgetMs ?? PEER_ANSWER_READ_BUDGET_MS,
  );
  return explainPeerIdentificationFailure(
    error,
    await observePeerAnswer(endpoint, budgetMs),
    endpoint,
  );
}
