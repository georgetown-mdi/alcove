import type { RelaySocket } from "@psi/transport/browserSsh/sshRelayStream";

type Listener = EventListenerOrEventListenerObject;

function deliver(listener: Listener, event: Event): void {
  if (typeof listener === "function") listener(event);
  else listener.handleEvent(event);
}

/**
 * A stand-in for the browser `WebSocket` the SSH relay stream drives: it
 * records each message sent, lets a test set `bufferedAmount`, and delivers
 * open, message and close events on demand.
 */
export class FakeRelaySocket implements RelaySocket {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState: WebSocket["readyState"] = 0;
  readonly sent: Array<Uint8Array> = [];
  closedWith: number | undefined;
  readonly #listeners = new Map<string, Set<Listener>>();
  /** Called with each message as it is sent. */
  onSend: ((data: Uint8Array) => void) | undefined;

  send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
    const bytes = new Uint8Array(
      (data as ArrayBufferView).buffer,
      (data as ArrayBufferView).byteOffset,
      (data as ArrayBufferView).byteLength,
    ).slice();
    this.sent.push(bytes);
    this.onSend?.(bytes);
  }

  close(code?: number): void {
    this.closedWith = code;
    this.readyState = 3;
  }

  addEventListener(
    type: string,
    listener: Listener,
    options?: boolean | AddEventListenerOptions,
  ): void {
    const once = typeof options === "object" && options.once === true;
    const wrapped: Listener = once
      ? (event) => {
          this.removeEventListener(type, wrapped);
          deliver(listener, event);
        }
      : listener;
    if (once) this.#onceOriginals.set(listener, wrapped);
    let set = this.#listeners.get(type);
    if (set === undefined) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(wrapped);
  }

  readonly #onceOriginals = new Map<Listener, Listener>();

  removeEventListener(type: string, listener: Listener): void {
    const set = this.#listeners.get(type);
    set?.delete(listener);
    const wrapped = this.#onceOriginals.get(listener);
    if (wrapped !== undefined) {
      set?.delete(wrapped);
      this.#onceOriginals.delete(listener);
    }
  }

  #dispatch(type: string, event: object): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])])
      deliver(listener, event as Event);
  }

  open(): void {
    this.readyState = 1;
    this.#dispatch("open", {});
  }

  receive(data: Uint8Array | string): void {
    this.#dispatch("message", {
      // A copy into its own ArrayBuffer: a Buffer's `slice` is a view.
      data: typeof data === "string" ? data : new Uint8Array(data).buffer,
    });
  }

  remoteClose(code: number, reason = ""): void {
    this.readyState = 3;
    this.#dispatch("close", { code, reason });
  }
}
