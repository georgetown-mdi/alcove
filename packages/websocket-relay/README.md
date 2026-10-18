# @alcove/websocket-relay

The WebSocket relay two parties of one exchange use when their network stops WebRTC and TURN but passes a WebSocket on 443.
Each party opens one socket and proves it holds the exchange's relay key;
the relay pairs the two sockets of one exchange and forwards their frames unread.
It opens no connection of its own.

The wire -- the hello, the start, the close codes and the bounds -- is specified in [docs/spec/WEBSOCKET_RELAY.md](../../docs/spec/WEBSOCKET_RELAY.md),
and the design and the rulings behind it are in [docs/notes/web-websocket-transport.md](../../docs/notes/web-websocket-transport.md).

The package ships TypeScript source with no build step of its own.
It reads `@alcove/core` from that workspace's `dist/`, so build core (`npm run build -w packages/core`) before running or testing it,
and it takes its pre-upgrade bounds from the signaling broker's `standaloneUpgradeBounds.ts`.

## Running it standalone

```sh
npm start -w packages/websocket-relay -- --key-table /var/lib/alcove-relay/turndb
```

It listens on `127.0.0.1` on an ephemeral port by default, prints one line, `alcove-websocket-relay <port>`, on stdout once it is listening, and stays up until it is signalled.
Diagnostics go to stderr.

| Setting | Flag | Environment | Default |
| --- | --- | --- | --- |
| Bind address | `--host <address>` | -- | `127.0.0.1` |
| Port | `--port <number>` | -- | `0` (ephemeral) |
| Key table | `--key-table <path>` | `ALCOVE_RELAY_TURNDB` | `/var/lib/alcove-relay/turndb` |

An unknown, repeated, valueless or empty flag, or a port that is not a whole number from 0 to 65535, is refused before the relay starts, and the process exits 64.
A bind the operating system refuses exits 69.

The key table is the SQLite file coturn reads its per-exchange secrets from ([infra/relay/README.md, Per-exchange keys](../../infra/relay/README.md#per-exchange-keys)), read with Node's built-in `node:sqlite`.
The relay opens it read-only for each hello and writes nothing.
A table it cannot read is a warning at start, since coturn creates the file at its own first start, and each hello is then refused until a read succeeds.

The relay terminates no TLS, so a deployment reachable off the host puts it behind a front that does.

## Tests

```sh
npm test -w packages/websocket-relay
```

The suite runs relays on loopback ephemeral ports with real `ws` clients, and spawns the standalone runner against a key table in coturn's SQLite shape.
