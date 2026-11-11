import path from "node:path";

import { CheckBrokenConnections } from "./services/checkBrokenConnections/index.ts";
import { MessageHandler } from "./messageHandler/index.ts";
import { MessagesExpire } from "./services/messagesExpire/index.ts";
import { Realm } from "./models/realm.ts";
import { WebSocketServer } from "./services/webSocketServer/index.ts";

import { attachSignalingDiagnostics } from "../diagnostics.ts";

import type { SignalingDiagnosticSink } from "../diagnostics.ts";

import type { IMessagesExpire } from "./services/messagesExpire/index.ts";
import type { IRealm } from "./models/realm.ts";
import type { IWebSocketServer } from "./services/webSocketServer/index.ts";

import type { Http2SecureServer as Http2Server } from "node:http2";
import type { Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";

import type { IClient } from "./models/client.ts";
import type { IConfig } from "./config/index.ts";
import type { IMessage } from "./models/message.ts";

export interface PeerServerInstance {
  config: IConfig;
  realm: IRealm;
}

export function CreateInstanceWSOnly({
  server,
  diagnosticSink,
  options: config,
}: {
  server: HttpServer | Http2Server;
  diagnosticSink: SignalingDiagnosticSink;
  options: IConfig;
}): PeerServerInstance {
  const realm: IRealm = new Realm();
  const messageHandler = new MessageHandler(realm);

  const messagesExpire: IMessagesExpire = new MessagesExpire({
    realm,
    config,
    messageHandler,
  });
  const checkBrokenConnections = new CheckBrokenConnections({
    realm,
    config,
  });

  const customConfig = {
    ...config,
    path: path.posix.join(config.path, "/"),
  };

  const wss: IWebSocketServer = new WebSocketServer({
    server: server as HttpServer | HttpsServer,
    realm: realm,
    config: customConfig,
  });

  wss.on("connection", (client: IClient) => {
    const messageQueue = realm.getMessageQueueById(client.getId());

    if (messageQueue) {
      // Reading a held frame reconstitutes its payload, which parses text this
      // server serialized itself -- and this handler runs from inside the
      // socket's own connection event with nothing between it and `ws`, so a
      // throw from that read would be an uncaught exception on an
      // internet-facing server. The try below guards only the read; the
      // dispatch call beside it is unguarded, with no reachable throw today.
      // A frame that cannot be reconstituted is therefore dropped down the same
      // `frame-dispatch` route the enqueue seam's refusal takes, and the rest of
      // the hold is still handed to the peer that came back for it. The loop is
      // bounded by the frames held when the drain began, since a read that
      // throws has already removed its frame.
      for (let held = messageQueue.size(); held > 0; held -= 1) {
        let message: IMessage | undefined;

        try {
          message = messageQueue.readMessage();
        } catch (e) {
          wss.emit("error", e, "frame-dispatch");
          continue;
        }

        if (message === undefined) break;
        messageHandler.handle(client, message);
      }
      realm.clearMessageQueue(client.getId());
    }
  });

  wss.on("message", (client: IClient, message: IMessage) => {
    messageHandler.handle(client, message);
  });

  // Attached rather than left off: an `error` emitted with no listener is thrown
  // rather than dropped, and the broker raises one over a peer hang-up it is
  // built to survive. Behind that the sink writes each report to the caller's
  // diagnostic sink, attributed, rate limited, and with the peer's own bytes
  // escaped. The sink is a required argument rather than an option, so no
  // wiring reaches this line without one. See
  // docs/spec/SIGNALING_SERVER_BOUNDS.md.
  attachSignalingDiagnostics(wss, diagnosticSink);

  messagesExpire.startMessagesExpiration();
  checkBrokenConnections.start();

  return { config, realm };
}
