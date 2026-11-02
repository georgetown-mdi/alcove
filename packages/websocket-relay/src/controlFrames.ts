/** The control frames one socket has sent, held to a bound for each interval
 * between two of the relay's pings. */
export interface ControlFrameCount {
  /** Record a ping the relay sent the socket, which starts a new interval. */
  pinged(): void;
  /**
   * Count a ping or pong the socket sent, returning whether the socket is
   * still within the bound. A pong answering a ping the relay sent is not
   * counted, so a socket answering a backlog of the relay's pings at once
   * stays within it.
   */
  admit(frame: "ping" | "pong"): boolean;
}

/** A {@link ControlFrameCount} allowing `max` counted frames an interval. */
export function createControlFrameCount(max: number): ControlFrameCount {
  let unansweredPings = 0;
  let counted = 0;
  return {
    pinged() {
      unansweredPings += 1;
      counted = 0;
    },
    admit(frame) {
      if (frame === "pong" && unansweredPings > 0) {
        unansweredPings -= 1;
        return true;
      }
      counted += 1;
      return counted <= max;
    },
  };
}
