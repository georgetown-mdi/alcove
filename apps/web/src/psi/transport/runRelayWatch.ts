/**
 * What an inviter's run shows of its own relay connections while it waits for
 * the partner: the default relay's enrollment and each WebSocket relay
 * socket it holds. The share screen's relay check reads it, and opens no
 * connection of its own (docs/spec/PROTOCOL.md, The web application's relay
 * check).
 */

import type { ConnectionError } from "@alcove/core";

import type {
  ParkedWebSocketRelayConnection,
  WebSocketRelayConnectionOptions,
} from "./websocketRelayConnection";
import type { DefaultRelayRefusal } from "./defaultRelayRefusal";
import type { RunRelayHosts } from "./runRelayPlan";

/** The run's enrollment at the default relay's registrar. */
export type WatchedEnrollment =
  | { kind: "pending" }
  | { kind: "confirmed" }
  | { kind: "refused"; refusal: DefaultRelayRefusal };

/** What one WebSocket relay the run dials has shown so far. */
export interface WatchedWebSocketRelay {
  /** The code of each close before the exchange began, in order. */
  closes: ReadonlyArray<number>;
  /** When the socket the run holds sent its hello; unset once it closes. */
  helloSentAt?: number;
  paired: boolean;
  failure?: ConnectionError;
}

/** The run's relay connections as last seen. */
export interface RunRelayWatchSnapshot {
  enrollment: WatchedEnrollment;
  /** By url, each WebSocket relay the run has dialed. */
  websocket: ReadonlyMap<string, WatchedWebSocketRelay>;
}

/** What the run's relay race reports to a {@link RunRelayWatch}. */
export interface WebSocketRelayWatch {
  relayOptions: (
    url: string,
  ) => Pick<WebSocketRelayConnectionOptions, "onHelloSent" | "onSetupClose">;
  parked: (url: string, relay: ParkedWebSocketRelayConnection) => void;
}

interface Followed {
  closes: Array<number>;
  helloSentAt?: number;
  relay?: ParkedWebSocketRelayConnection;
}

/** One run attempt's relay connections, as the run reports them. */
export class RunRelayWatch implements WebSocketRelayWatch {
  private enrollment: WatchedEnrollment = { kind: "pending" };
  private readonly followed = new Map<string, Followed>();

  /**
   * @param hosts The relay hosts the run lists, `runRelayHosts` for its
   *   arguments.
   */
  constructor(
    readonly hosts: RunRelayHosts,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** The run's `onDefaultRelayEnrollment`. */
  readonly onDefaultRelayEnrollment = (
    refusal: DefaultRelayRefusal | undefined,
  ): void => {
    this.enrollment =
      refusal === undefined
        ? { kind: "confirmed" }
        : { kind: "refused", refusal };
  };

  readonly relayOptions = (
    url: string,
  ): Pick<WebSocketRelayConnectionOptions, "onHelloSent" | "onSetupClose"> => {
    const followed = this.follow(url);
    return {
      onHelloSent: () => {
        followed.helloSentAt = this.now();
      },
      onSetupClose: (code) => {
        followed.closes.push(code);
        delete followed.helloSentAt;
      },
    };
  };

  readonly parked = (
    url: string,
    relay: ParkedWebSocketRelayConnection,
  ): void => {
    this.follow(url).relay = relay;
  };

  /** What the run has shown so far. */
  snapshot(): RunRelayWatchSnapshot {
    const websocket = new Map<string, WatchedWebSocketRelay>();
    for (const [url, followed] of this.followed) {
      const failure = followed.relay?.failure;
      websocket.set(url, {
        closes: [...followed.closes],
        ...(followed.helloSentAt !== undefined && {
          helloSentAt: followed.helloSentAt,
        }),
        paired: followed.relay?.paired === true,
        ...(failure !== undefined && { failure }),
      });
    }
    return { enrollment: this.enrollment, websocket };
  }

  private follow(url: string): Followed {
    let followed = this.followed.get(url);
    if (followed === undefined) {
      followed = { closes: [] };
      this.followed.set(url, followed);
    }
    return followed;
  }
}
