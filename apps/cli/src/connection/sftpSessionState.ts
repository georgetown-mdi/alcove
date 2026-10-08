/**
 * The connection-lifecycle state one SFTP adapter keeps across session
 * generations: teardown progress, the transport-close reading, and one-shot
 * budgets. Transport-blind: it contains no ssh2 type, session, socket or client.
 * Per-session values stay on the adapter, under its transition lock:
 * docs/notes/sftp-adapter-state-machine.md.
 */

/**
 * How far the connection's terminal close has got, from two independent
 * monotonic latches: `beginTeardown()` (a re-dial is still wanted, exempt from
 * the reconnection cap) and `beginClose()` (no re-dial). Either can come
 * first, so all four combinations are reachable.
 */
export type TeardownState =
  "running" | "tearingDown" | "closing" | "closingAfterTeardown";

/**
 * What is known about the ssh2 Client's transport close: `unreadable` when the
 * Client exposes no `on()` to watch, `owed` between its `'end'` and `'close'`
 * (when a dial on that Client is rejected), and `delivered` otherwise:
 * docs/spec/DEPENDENCY_PINS.md#upgrading-the-sftp-stack-ssh2--ssh2-sftp-client.
 */
export type TransportCloseReading = "unreadable" | "owed" | "delivered";

/** The whole of one adapter's connection-lifecycle state. */
export class SftpSessionState {
  #teardown: TeardownState = "running";
  #transportClose: TransportCloseReading = "unreadable";
  #abandonedTeardownClosedTransport = false;
  #peerAnswerDiagnosisSpent = false;
  #unreadableLifecycleWarned = false;
  #keyboardInteractiveAttached = false;

  /** How far the terminal close has got. */
  get teardown(): TeardownState {
    return this.#teardown;
  }

  /**
   * Whether `end()` has latched. Read once per transition inside the transition
   * lock, so no session transition, reopen or recovery re-dial begins after it.
   */
  get isClosing(): boolean {
    return (
      this.#teardown === "closing" || this.#teardown === "closingAfterTeardown"
    );
  }

  /**
   * Whether `beginTeardown()` has latched: a drop under this side's teardown is
   * not the partner's.
   */
  get isTearingDown(): boolean {
    return (
      this.#teardown === "tearingDown" ||
      this.#teardown === "closingAfterTeardown"
    );
  }

  /** Latch the start of the connection's close()/teardown. Idempotent. */
  beginTeardown(): void {
    if (this.#teardown === "running") this.#teardown = "tearingDown";
    else if (this.#teardown === "closing")
      this.#teardown = "closingAfterTeardown";
  }

  /** Latch `end()`. Idempotent. */
  beginClose(): void {
    this.#teardown =
      this.#teardown === "tearingDown" ||
      this.#teardown === "closingAfterTeardown"
        ? "closingAfterTeardown"
        : "closing";
  }

  /**
   * Whether an abandoning teardown closed the transport itself. The dial it cut
   * short rejects with the same error as a peer close (docs/spec/DEPENDENCY_PINS.md),
   * so this, not the error text, tells the two apart. Never cleared: it is only
   * set on a connection already closing.
   */
  get abandonedTeardownClosedTransport(): boolean {
    return this.#abandonedTeardownClosedTransport;
  }

  /** Record that an abandoning teardown drove the transport close itself. */
  recordAbandonedTeardownClose(): void {
    this.#abandonedTeardownClosedTransport = true;
  }

  /** What is known about the transport's close. */
  get transportClose(): TransportCloseReading {
    return this.#transportClose;
  }

  /**
   * Take the one-per-adapter permission to attach the transport-lifecycle
   * listeners; false on every later call, since the Client is reused across
   * reconnects and listeners would stack.
   */
  beginWatchingTransport(): boolean {
    if (this.#transportClose !== "unreadable") return false;
    this.#transportClose = "delivered";
    return true;
  }

  /** The transport emitted its `'end'`, so its `'close'` is owed. */
  recordTransportEnd(): void {
    if (this.#transportClose !== "unreadable") this.#transportClose = "owed";
  }

  /** The transport emitted its `'close'`; nothing is owed. */
  recordTransportClose(): void {
    if (this.#transportClose !== "unreadable")
      this.#transportClose = "delivered";
  }

  /**
   * Whether this connection's single non-SSH-answer diagnosis has been taken.
   * It opens its own TCP connection, so connection-per-poll would otherwise
   * repeat it every cycle.
   */
  get peerAnswerDiagnosisSpent(): boolean {
    return this.#peerAnswerDiagnosisSpent;
  }

  /** Spend that budget when the diagnosis opens its connection. */
  spendPeerAnswerDiagnosis(): void {
    this.#peerAnswerDiagnosisSpent = true;
  }

  /**
   * Take the one warning that the transport lifecycle cannot be read; it
   * depends on the installed version, so one copy suffices.
   */
  spendUnreadableLifecycleWarning(): boolean {
    if (this.#unreadableLifecycleWarned) return false;
    this.#unreadableLifecycleWarned = true;
    return true;
  }

  /**
   * Whether the keyboard-interactive answer handler is attached; once per
   * adapter, like the transport listeners.
   */
  get keyboardInteractiveAttached(): boolean {
    return this.#keyboardInteractiveAttached;
  }

  /** Record that handler as attached; called only after a successful attach. */
  recordKeyboardInteractiveAttached(): void {
    this.#keyboardInteractiveAttached = true;
  }
}
