import type { WebSocketServer, ServerOptions } from "ws";

export interface IConfig {
  readonly expire_timeout: number;
  readonly alive_timeout: number;
  // Shorter reap window for a client that has registered but not yet sent any
  // inbound frame. A real peer heartbeats within seconds of opening and graduates
  // to alive_timeout, so only a socket that registers and then goes silent (an
  // abandoned or junk registration) is cut at this bound, well before the
  // generous alive_timeout.
  readonly unconfirmed_timeout: number;
  readonly key: string;
  readonly path: string;
  readonly concurrent_limit: number;
  readonly cleanup_out_msgs: number;
  readonly createWebSocketServer?: (options: ServerOptions) => WebSocketServer;
}

const defaultConfig: IConfig = {
  expire_timeout: 5000,
  alive_timeout: 90000,
  unconfirmed_timeout: 20000,
  key: "peerjs",
  path: "/",
  concurrent_limit: 5000,
  cleanup_out_msgs: 1000,
};

export default defaultConfig;
