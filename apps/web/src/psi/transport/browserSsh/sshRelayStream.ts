import { BaseStream, Buffer } from "./sshLibrary";
import {
  BrowserSshClientClosedError,
  BrowserSshRelayClosedError,
} from "./browserSshErrors";

/**
 * The largest message the SFTP relay takes from a browser
 * (docs/spec/SFTP_RELAY.md, Forwarding); a larger write is split.
 */
export const SSH_RELAY_MAX_MESSAGE_BYTES = 64 * 1024;

/** The send window's marks: a write waits while the socket's
 * `bufferedAmount` is above the high mark, until it drains to the low. */
export const SSH_RELAY_SEND_WINDOW_BYTES = 1024 * 1024;
export const SSH_RELAY_SEND_WINDOW_LOW_BYTES = 256 * 1024;

/** How often a write waiting on the window re-reads `bufferedAmount`; a
 * browser `WebSocket` raises no event as its buffer drains. */
const SEND_WINDOW_POLL_INTERVAL_MS = 20;

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const CLOSE_NORMAL = 1000;
/** The close code a socket that never opened reports in a browser. */
const CLOSE_ABNORMAL = 1006;

/** The part of a browser `WebSocket` the stream uses. */
export type RelaySocket = Pick<
  WebSocket,
  | "binaryType"
  | "bufferedAmount"
  | "readyState"
  | "send"
  | "close"
  | "addEventListener"
  | "removeEventListener"
>;

/**
 * The SSH library's byte stream over a WebSocket to the SFTP relay. Writes are
 * split at the relay's message cap and wait on the socket's send buffer, and a
 * close other than 1000 fails pending reads with
 * {@link BrowserSshRelayClosedError} carrying the relay's code.
 */
export class SshRelayStream extends BaseStream {
  #closeError: BrowserSshRelayClosedError | null = null;
  #relayClosed = false;
  /** Whether this client closed the stream before the relay closed it. */
  #closedLocally = false;

  constructor(private readonly socket: RelaySocket) {
    super();
    socket.binaryType = "arraybuffer";
    socket.addEventListener("message", (event: MessageEvent) => {
      if (event.data instanceof ArrayBuffer)
        this.onData(Buffer.from(event.data));
      else this.onError(new Error("The SFTP relay sent a text message."));
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      this.#relayClosed = true;
      if (event.code === CLOSE_NORMAL) {
        this.onEnd();
        return;
      }
      this.#closeError = new BrowserSshRelayClosedError(
        event.code,
        event.reason,
      );
      this.onError(this.#closeError);
    });
  }

  /**
   * Open a WebSocket to `url` and resolve once it is open. An abort of
   * `signal` before then closes the socket and rejects with its reason; an
   * already-aborted signal rejects without opening one.
   */
  static open(
    url: string,
    createSocket: (url: string) => RelaySocket = (target) =>
      new WebSocket(target),
    signal?: AbortSignal,
  ): Promise<SshRelayStream> {
    if (signal?.aborted) return Promise.reject(signal.reason as Error);
    const socket = createSocket(url);
    const stream = new SshRelayStream(socket);
    return new Promise((resolve, reject) => {
      const settle = () => {
        socket.removeEventListener("open", onOpen);
        socket.removeEventListener("close", onClose);
        signal?.removeEventListener("abort", onAbort);
      };
      const onOpen = () => {
        settle();
        resolve(stream);
      };
      const onClose = (event: CloseEvent) => {
        settle();
        reject(
          new BrowserSshRelayClosedError(
            event.code || CLOSE_ABNORMAL,
            event.reason,
          ),
        );
      };
      const onAbort = () => {
        settle();
        stream.dispose();
        reject(signal!.reason as Error);
      };
      socket.addEventListener("open", onOpen, { once: true });
      socket.addEventListener("close", onClose, { once: true });
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** The relay's close, once the socket has closed with a code other than 1000. */
  get closeError(): BrowserSshRelayClosedError | null {
    return this.#closeError;
  }

  async write(data: Buffer): Promise<void> {
    for (
      let offset = 0;
      offset < data.length;
      offset += SSH_RELAY_MAX_MESSAGE_BYTES
    ) {
      if (this.socket.bufferedAmount > SSH_RELAY_SEND_WINDOW_BYTES)
        await this.#drain();
      this.#requireOpen();
      // `buffer`'s Buffer is backed by an ArrayBuffer, never a shared one.
      this.socket.send(
        data.subarray(
          offset,
          offset + SSH_RELAY_MAX_MESSAGE_BYTES,
        ) as Uint8Array<ArrayBuffer>,
      );
    }
  }

  close(error?: Error): Promise<void> {
    if (!this.disposed) {
      this.disposed = true;
      this.#closedLocally = !this.#relayClosed;
      if (
        this.socket.readyState === SOCKET_OPEN ||
        this.socket.readyState === SOCKET_CONNECTING
      )
        this.socket.close(CLOSE_NORMAL);
      this.onError(error ?? new Error("The SSH stream was closed."));
      this.fireOnClose(error);
    }
    return Promise.resolve();
  }

  override dispose(): void {
    if (!this.disposed) {
      this.#closedLocally = !this.#relayClosed;
      if (
        this.socket.readyState === SOCKET_OPEN ||
        this.socket.readyState === SOCKET_CONNECTING
      )
        this.socket.close(CLOSE_NORMAL);
    }
    super.dispose();
  }

  #requireOpen(): void {
    if (this.socket.readyState === SOCKET_OPEN && !this.disposed) return;
    if (this.#closedLocally) throw new BrowserSshClientClosedError();
    throw (
      this.#closeError ??
      new BrowserSshRelayClosedError(CLOSE_ABNORMAL, "the socket is not open")
    );
  }

  async #drain(): Promise<void> {
    while (this.socket.bufferedAmount > SSH_RELAY_SEND_WINDOW_LOW_BYTES) {
      this.#requireOpen();
      await new Promise((resolve) =>
        setTimeout(resolve, SEND_WINDOW_POLL_INTERVAL_MS),
      );
    }
  }
}
