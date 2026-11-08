// Loaded into the standalone runner under test with `--import`: once the
// runner's HTTP server listens, writes to stderr the request bounds that server
// holds and how many `clientError` listeners it has, and for each connection
// it accepts the idle bound on that socket.
import { Server } from "node:http";

const listen = Server.prototype.listen;

Server.prototype.listen = function (...args) {
  this.once("listening", () => {
    process.stderr.write(
      `probe server ${JSON.stringify({
        headersTimeout: this.headersTimeout,
        requestTimeout: this.requestTimeout,
        clientErrorListeners: this.listenerCount("clientError"),
      })}\n`,
    );
    // Read after every listener the runner registered has run.
    this.on("connection", (socket) =>
      setImmediate(() =>
        process.stderr.write(
          `probe connection ${JSON.stringify({ timeout: socket.timeout ?? null })}\n`,
        ),
      ),
    );
  });
  return listen.apply(this, args);
};
