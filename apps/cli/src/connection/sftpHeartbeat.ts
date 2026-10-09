import { sanitizeErrorForDisplay } from "@alcove/core";

/**
 * Keeps an idle SFTP session alive past a server's idle timeout with a periodic
 * no-op SFTP command:
 * docs/spec/TRANSPORT_LIVENESS.md#sftp-session-heartbeat-and-tcp-keepalive.
 */

/**
 * Milliseconds between beats: the longest an idle session goes without a
 * keepalive command. Half the tightest server idle timeout it must survive.
 */
export const SFTP_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Idle milliseconds before TCP keepalive probes start on the SFTP socket
 * (`setKeepAlive`'s initial delay). It keeps NAT state warm but does not reset
 * the server's SFTP idle timer, so it does not replace {@link SftpHeartbeat}.
 */
export const SFTP_TCP_KEEPALIVE_DELAY_MS = 30_000;

/** Minimal logger surface the heartbeat needs: keepalive traffic is trace-only. */
interface HeartbeatLog {
  trace: (message: string) => void;
}

export interface SftpHeartbeatOptions {
  /**
   * Issues the no-op keepalive command (a bounded `realPath(".")`). Its outcome
   * is logged at trace and never reaches the exchange.
   */
  ping: () => Promise<unknown>;
  log: HeartbeatLog;
}

/**
 * A self-rescheduling keepalive for one SFTP session. The adapter brackets its
 * server-driven operations with {@link opStarted}/{@link opSettled}, and the
 * heartbeat pings only after a full idle interval with nothing in flight, so a
 * beat never takes a session-loss rejection from a real operation.
 */
export class SftpHeartbeat {
  private readonly ping: () => Promise<unknown>;
  private readonly log: HeartbeatLog;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastActivityAt = 0;
  private inFlight = 0;
  private pinging = false;
  private stopped = false;
  // Bumped by every start()/stop(); a ping or operation settling under an older
  // epoch is ignored, so it cannot touch a later session's state.
  private epoch = 0;

  constructor(options: SftpHeartbeatOptions) {
    this.ping = options.ping;
    this.log = options.log;
  }

  /**
   * Arm the heartbeat after a successful connect, with a fresh idle window and
   * the prior session's counters dropped. Idempotent across reconnects.
   */
  start(): void {
    this.stopped = false;
    this.epoch += 1;
    this.pinging = false;
    this.inFlight = 0;
    this.lastActivityAt = Date.now();
    this.schedule(SFTP_HEARTBEAT_INTERVAL_MS);
  }

  /**
   * A server-driven adapter operation began. Returns the epoch token the
   * matching {@link opSettled} must present.
   */
  opStarted(): number {
    this.inFlight += 1;
    this.lastActivityAt = Date.now();
    return this.epoch;
  }

  /**
   * A server-driven adapter operation settled. A `token` from an older epoch is
   * ignored.
   */
  opSettled(token: number): void {
    if (token !== this.epoch) return;
    if (this.inFlight > 0) this.inFlight -= 1;
    this.lastActivityAt = Date.now();
  }

  /**
   * Stop the heartbeat on a terminal path, so no pending tick or ping
   * reschedules. Safe when never started and when repeated.
   */
  stop(): void {
    this.stopped = true;
    this.epoch += 1;
    this.pinging = false;
    this.inFlight = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule(delayMs: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.tick(), Math.max(delayMs, 0));
    // A background keepalive must not hold the process open.
    this.timer.unref();
  }

  private tick(): void {
    if (this.stopped) return;
    if (this.inFlight > 0 || this.pinging) {
      this.schedule(SFTP_HEARTBEAT_INTERVAL_MS);
      return;
    }
    const idleMs = Date.now() - this.lastActivityAt;
    if (idleMs < SFTP_HEARTBEAT_INTERVAL_MS) {
      this.schedule(SFTP_HEARTBEAT_INTERVAL_MS - idleMs);
      return;
    }
    this.sendPing();
  }

  private sendPing(): void {
    this.pinging = true;
    const epoch = this.epoch;
    void this.ping()
      .then(() => this.log.trace("SFTP keepalive sent"))
      .catch((err: unknown) =>
        this.log.trace(
          `SFTP keepalive failed: ${sanitizeErrorForDisplay(err)}`,
        ),
      )
      .finally(() => {
        if (epoch !== this.epoch) return;
        this.pinging = false;
        this.lastActivityAt = Date.now();
        if (!this.stopped) this.schedule(SFTP_HEARTBEAT_INTERVAL_MS);
      });
  }
}
