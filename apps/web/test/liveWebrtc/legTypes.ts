/**
 * The shapes the live CLI-to-browser WebRTC leg passes between its two halves,
 * and the prefix that tells an environment failure from an interop divergence.
 *
 * A module of its own because the browser half runs in Chromium and cannot
 * import the Node half at all: that one spawns processes. Nothing here imports
 * anything.
 */

/**
 * Prefix on every failure the leg's Node side raises about its own
 * ENVIRONMENT -- an unbuilt CLI, a broker that would not start or answer, an
 * invitation the CLI never printed, a party killed on its deadline.
 *
 * The leg's other failure is an interop divergence, which lands as a failed
 * assertion on an association table or a close outcome. Keeping the two
 * distinguishable in the output is what stops a broken environment from being
 * read as a divergence, or a divergence from being muted as flake.
 */
export const LEG_ENVIRONMENT_FAILURE = "live-webrtc leg environment failure:";

/** A matched pair as both halves report it: this party's row, then the
 * partner's. */
export type MatchedPair = [number, number];

/** What the CLI party links on, wherever the program runs: spawned directly as
 * `alcove invite`, or by the console server for a webrtc job. Two rows in
 * common with the browser peer's file, at different offsets on each side, so a
 * party reading its own table back cannot pass by symmetry. */
export const CLI_PARTY_CSV =
  "first_name,last_name,date_of_birth\n" +
  "Bob,Jones,1990-01-02\n" +
  "Carol,Lee,1985-07-16\n" +
  "Dave,Kim,1978-11-30\n";

/** What the Node side has standing once the leg has started: a broker listening
 * on its own origin, and an `alcove invite` waiting at it. */
export interface LiveLegStart {
  /** The invitation the CLI party printed, for the browser peer to accept. */
  invitation: string;
  /**
   * The broker's HTTP origin, which is NOT the page's: the browser peer reaches
   * it only over the signaling WebSocket, and the leg asserts no HTTP request
   * goes to it (see the leg's peer-id check).
   */
  brokerOrigin: string;
  /** What the broker's readiness endpoint answered on the Node side, so the
   * precondition names the vendored broker rather than whatever else might hold
   * the port. */
  readinessBody: string;
  /**
   * What the vendored broker declares that endpoint answers
   * (`READINESS_BODY`), which the body above is held against.
   *
   * It crosses from the Node half rather than being imported by the browser
   * half: the module declaring it reaches `node:path` at module scope, which
   * the browser runner externalizes into a stub that throws on the first
   * access.
   */
  expectedReadinessBody: string;
  /** The identity the CLI party declared, which the browser peer must read back
   * off the agreed terms. */
  cliIdentity: string;
}

/** How the CLI party's run ended, read once it has exited. */
export interface LiveLegCliOutcome {
  /** The process exit code, or null when a signal ended it. */
  exitCode: number | null;
  /** The run outlived the harness deadline and was killed, so nothing below
   * describes a completed exchange. */
  killedOnDeadline: boolean;
  /** The matched pairs the CLI party's result CSV holds, ascending by its own
   * row; null when it wrote no result file. */
  pairs: Array<MatchedPair> | null;
  /**
   * What this party's clean close cost it: the span from its own "closing
   * connection" log line -- written immediately before the transport close that
   * drains to acknowledgement and tears down -- to the process exiting. Null
   * when the run wrote no such line, which means it never reached a close.
   *
   * It is an upper bound on the drain rather than the drain alone: the epilogue
   * after it (the token-expiry re-read, the log flush, process exit) is inside
   * the span.
   */
  closeWaitMs: number | null;
  /** stdout and stderr interleaved in arrival order, which is what an operator
   * reads and what a failure here quotes. */
  output: string;
}

/** What the Node side of the console leg has standing: the broker on its own
 * origin and the console server, with that broker authored as the coordination
 * server the console's webrtc jobs dial. */
export interface ConsoleLegStart {
  /** The coordination server as `PUT /api/jobs/webrtc` reported it. */
  signaling: {
    host: string;
    port?: number;
    path: string;
    secure: boolean;
    warnings: Array<string>;
  };
  /** What the broker's readiness endpoint answered, held against
   * `expectedReadinessBody` as {@link LiveLegStart} holds it. */
  readinessBody: string;
  expectedReadinessBody: string;
}

/** How the console's webrtc job ended, read once it left `running`. */
export interface ConsoleJobOutcome {
  /** The job's `status`, still `running` when the harness deadline came
   * first. */
  status: string;
  /** The CLI's exit code, or null when the console has not reconciled one. */
  exitCode: number | null;
  /** The matched pairs the console's result file holds, ascending by this
   * party's own row; null when the console serves no result. */
  pairs: Array<MatchedPair> | null;
  /** The job's event stream as the console replays it, which is what a failure
   * here quotes. */
  events: string;
}
