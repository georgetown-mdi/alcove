# @alcove/sftp-relay

The SFTP relay a browser party reaches one SFTP server through, since a browser cannot open a TCP connection.
The SFTP server's operator runs it in front of that server.
It upgrades a WebSocket only from an allowed origin, connects each one to the one target fixed at its start, and forwards the bytes both ways unread, with backpressure each way.

The wire -- the endpoint, the `Origin` check, the close codes and the bounds -- is specified in [docs/spec/SFTP_RELAY.md](../../docs/spec/SFTP_RELAY.md),
the reference configuration is in [docs/DEPLOYMENT.md](../../docs/DEPLOYMENT.md#websocket-to-tcp-proxy),
and the design behind it is in [docs/notes/browser-sftp-proxy.md](../../docs/notes/browser-sftp-proxy.md).

The package ships TypeScript source.
It reads `@alcove/core/websocket-relay` from that workspace's `dist/`, so build core (`npm run build -w packages/core`) before running or testing it.
It takes its pre-upgrade bounds from the signaling broker's `standaloneUpgradeBounds.ts`, and its forwarding toward the browser and its fault reports from the WebSocket relay.

## Running it standalone

```sh
npm start -w packages/sftp-relay -- --target sftp.example.org:22 --allowed-origin https://alcove.example.org
```

It listens on `127.0.0.1` on an ephemeral port by default, prints one line, `alcove-sftp-relay <port>`, on stdout once it is listening, and stays up until it is signalled.
Diagnostics go to stderr.
The flags and exit codes: [The runner](../../docs/spec/SFTP_RELAY.md#the-runner).

## The image

```sh
docker build -f packages/sftp-relay/Dockerfile -t alcove-sftp-relay .
```

Built from the repository root.
`npm run build -w packages/sftp-relay` bundles the runner and every module it reaches into `dist/sftp-relay.mjs`, the one file the image runs.

## Tests

```sh
npm test -w packages/sftp-relay
npx vitest run --project integration test/integration/sftpRelay.test.ts   # from apps/cli
```

The package's suite covers the flags and the runner as a process.
The relay's checks against the SFTP test server -- an SFTP round trip, each `Origin` case, backpressure each way, and the close mapping -- are in the CLI integration suite.
