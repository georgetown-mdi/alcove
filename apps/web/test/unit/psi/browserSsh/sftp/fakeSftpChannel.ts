import type { Buffer } from "@psi/transport/browserSsh/sshLibrary";
import type { SftpChannel } from "@psi/transport/browserSsh/sftp/sftpClient";

type Listener<T> = (value: T) => void;

class Listeners<T> {
  private readonly listeners = new Set<Listener<T>>();

  add(listener: Listener<T>): { dispose: () => void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value);
  }

  get size(): number {
    return this.listeners.size;
  }
}

/** An SSH channel with a scripted server on its far side. */
export class FakeSftpChannel implements SftpChannel {
  isClosed = false;
  /** Each `send`, as bytes. */
  readonly sent: Array<Uint8Array> = [];
  /** Each `adjustWindow` amount. */
  readonly adjusted: Array<number> = [];
  closeCalls = 0;
  /** When set, `send` rejects with it. */
  sendFailure: Error | undefined;

  private readonly data = new Listeners<Uint8Array>();
  private readonly eof = new Listeners<undefined>();
  private readonly closed = new Listeners<{ error?: Error }>();

  onDataReceived = (listener: Listener<Uint8Array>) => this.data.add(listener);
  onEof = (listener: () => void) => this.eof.add(() => listener());
  onClosed = (listener: Listener<{ readonly error?: Error }>) =>
    this.closed.add(listener);

  send = (data: Buffer): Promise<void> => {
    if (this.sendFailure) return Promise.reject(this.sendFailure);
    this.sent.push(new Uint8Array(data));
    return Promise.resolve();
  };

  adjustWindow = (messageLength: number): void => {
    this.adjusted.push(messageLength);
  };

  close = (): Promise<void> => {
    this.closeCalls += 1;
    this.closeFromServer();
    return Promise.resolve();
  };

  /** The server sends channel data. */
  deliver(...chunks: Array<Uint8Array>): void {
    for (const chunk of chunks) this.data.fire(chunk);
  }

  /** The server sends EOF. */
  sendEof(): void {
    this.eof.fire(undefined);
  }

  /** The channel closes, as the library reports it. */
  closeFromServer(error?: Error): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closed.fire(error === undefined ? {} : { error });
  }

  /** How many listeners the client still holds. */
  get listenerCount(): number {
    return this.data.size + this.eof.size + this.closed.size;
  }
}
