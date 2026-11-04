import { default as EventEmitter } from "eventemitter3";

type Events = {
  data: (data: unknown, receivedBytes?: number) => void;
  error: (err: unknown) => void;
};

// The length an in-memory message is delivered with: a binary message's, and
// nothing for any other.
function messageBytes(data: unknown): number {
  return ArrayBuffer.isView(data) || data instanceof ArrayBuffer
    ? data.byteLength
    : 0;
}

export class PassthroughConnection extends EventEmitter<Events, never> {
  other: PassthroughConnection | undefined;
  private bufferedError: unknown;

  send(data: unknown) {
    setImmediate(() => {
      this.other!.emit("data", data, messageBytes(data));
    });
  }

  constructor(other?: PassthroughConnection) {
    super();
    this.other = other;
  }

  setOther(other: PassthroughConnection) {
    this.other = other;
  }

  close() {}

  // Mirrors FileSyncConnection's emit override so tests exercising the
  // protocol-layer takeBufferedError() path see the same buffering semantics
  // as the production transport.
  emit<E extends keyof Events>(
    event: E,
    ...args: EventEmitter.EventArgs<Events, E>
  ): boolean {
    const hadListeners = super.emit(event, ...args);
    if (event === "error" && !hadListeners) this.bufferedError = args[0];
    return hadListeners;
  }

  takeBufferedError(): unknown {
    const e = this.bufferedError;
    this.bufferedError = undefined;
    return e;
  }
}
