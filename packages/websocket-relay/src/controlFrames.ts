/**
 * The most answers to relay pings a socket may have left unsent at once, each
 * read without being counted. Two covers an answer delayed behind one ping at
 * the production ping interval.
 */
export const MAX_CARRIED_PING_ANSWERS = 2;

/** The control frames one socket has sent, held to a bound for each interval
 * between two of the relay's pings. */
export interface ControlFrameLimit {
  /** Record a ping the relay sent the socket, which starts a new interval. */
  pinged(): void;
  /**
   * Handle a ping or pong the socket sent, returning whether it is within the
   * bound, so a ping is to be answered. A pong answering a ping the relay sent
   * is not counted for up to {@link MAX_CARRIED_PING_ANSWERS} of the relay's
   * pings left unanswered at a time, so a socket answering one or two pings at
   * once stays within it.
   *
   * The first frame past the bound closes the socket, the next terminates it,
   * and every later one returns false at once with no count and no call.
   */
  admit(frame: "ping" | "pong"): boolean;
}

/** What {@link createControlFrameLimit} does to the socket past the bound. */
export interface ControlFrameLimitActions {
  /** Whether the socket can still be closed with a close frame. */
  closable(): boolean;
  /** Close the socket with the control frame limit's close code. */
  close(): void;
  /** Drop the socket's connection. */
  terminate(): void;
}

/** A {@link ControlFrameLimit} allowing `max` counted frames an interval. */
export function createControlFrameLimit(
  max: number,
  actions: ControlFrameLimitActions,
): ControlFrameLimit {
  let unansweredPings = 0;
  let counted = 0;
  let stage: "within" | "closing" | "terminated" = "within";
  return {
    pinged() {
      unansweredPings = Math.min(unansweredPings + 1, MAX_CARRIED_PING_ANSWERS);
      counted = 0;
    },
    admit(frame) {
      if (stage === "terminated") return false;
      if (stage === "closing") {
        stage = "terminated";
        actions.terminate();
        return false;
      }
      if (frame === "pong" && unansweredPings > 0) {
        unansweredPings -= 1;
        return true;
      }
      counted += 1;
      if (counted <= max) return true;
      if (actions.closable()) {
        stage = "closing";
        actions.close();
      } else {
        stage = "terminated";
        actions.terminate();
      }
      return false;
    },
  };
}
