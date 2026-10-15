import { EncryptedMessageConnection } from "@alcove/core";
import { createMessagePipe } from "@alcove/core/testing";

import type { MessageConnection } from "@alcove/core";

/** A session key both ends of {@link aeadWrappedPipe} derive their AEAD keys
 * from. */
const SESSION_KEY = new Uint8Array(32).fill(0x5a);

/** A connection that sends into `sent` and receives from `inbound` in order. */
function scriptedConnection(
  sent: Array<unknown>,
  inbound: Array<unknown>,
): MessageConnection {
  return {
    send: (data) => {
      sent.push(data);
      return Promise.resolve();
    },
    receive: () => {
      const next = inbound.shift();
      return next === undefined
        ? Promise.reject(new Error("no inbound frame scripted"))
        : Promise.resolve(next);
    },
    close: () => Promise.resolve(),
  };
}

/**
 * This party's end of an in-memory pipe wrapped in core's
 * {@link EncryptedMessageConnection} as the initiator -- the connection the
 * web handshake hands its caller -- and the partner's raw end beneath the
 * wrap, where the wire frames are seen and injected. `seal` returns the
 * envelopes the partner's own wrapper sends for `messages`, in sequence;
 * `open` decrypts envelopes this party sent, in sequence.
 */
export async function aeadWrappedPipe(): Promise<{
  secure: EncryptedMessageConnection;
  partnerRaw: MessageConnection;
  seal: (messages: Array<unknown>) => Promise<Array<Uint8Array>>;
  open: (envelope: unknown) => Promise<unknown>;
}> {
  const [ours, partnerRaw] = createMessagePipe();
  const secure = await EncryptedMessageConnection.create(
    ours,
    SESSION_KEY,
    "initiator",
  );

  const sealed: Array<unknown> = [];
  const sealer = await EncryptedMessageConnection.create(
    scriptedConnection(sealed, []),
    SESSION_KEY,
    "responder",
  );
  const toOpen: Array<unknown> = [];
  const opener = await EncryptedMessageConnection.create(
    scriptedConnection([], toOpen),
    SESSION_KEY,
    "responder",
  );

  return {
    secure,
    partnerRaw,
    seal: async (messages) => {
      sealed.length = 0;
      for (const message of messages) await sealer.send(message);
      return sealed.map((frame) => frame as Uint8Array);
    },
    open: (envelope) => {
      toOpen.push(envelope);
      return opener.receive();
    },
  };
}
