---
title: "SFTP Relay"
---

# SFTP relay

This document specifies the SFTP relay (`packages/sftp-relay`): its endpoint, its `Origin` check, its fixed target, how it forwards and closes, its close codes, and its bounds.
It is the implementation-level complement to [WebSocket-to-TCP proxy](../DEPLOYMENT.md#websocket-to-tcp-proxy) in DEPLOYMENT.md, which says who runs it and how.
It does not cover the WebSocket relay that pairs two parties of one exchange, a separate service with no TCP target (see [WEBSOCKET_RELAY.md](WEBSOCKET_RELAY.md)).
The design and the rulings behind it are in [browser-sftp-proxy.md](../notes/browser-sftp-proxy.md) and [web-websocket-transport.md](../notes/web-websocket-transport.md#question-2-one-component-or-two).
Intended readers are implementors of a browser SFTP client, whoever deploys the relay, and security auditors.

Every constant below is in `packages/sftp-relay/src/protocol.ts` unless another file is named.
Each is a working value, raised or lowered on request.

## What it is

The relay lets a browser, which cannot open a TCP connection, reach one SFTP server.
It forwards the bytes of each WebSocket to a TCP connection and back, unread.
SSH runs end to end between the browser and the SFTP server, so the relay sees the SSH version strings and algorithm lists sent before encryption and nothing after.
The SFTP server's operator runs it in front of that one server.

## The endpoint

- **The path.** A browser opens a WebSocket at `/sftp` (`SFTP_RELAY_PATH`); a query string is ignored. An upgrade on any other path is answered `404` and closed, and so is a plain HTTP request.
- **No extension.** The relay negotiates no per-message compression.
- **Before the upgrade.** The relay applies the signaling broker's pre-upgrade bounds: a 10-second header timeout, a 15-second request timeout, and a 10-second idle bound on a socket that has not completed its request ([SIGNALING_SERVER_BOUNDS.md](SIGNALING_SERVER_BOUNDS.md#web-signaling-surface-bounds); `packages/peerjs-broker/src/standaloneUpgradeBounds.ts`).
- **No TLS.** The relay terminates none, so a deployment puts it behind a front that does.

## The `Origin` check

The relay upgrades a request only when it holds exactly one `Origin` header whose value is one of the allowed origins, compared as strings.
Any other request is answered `403` and closed before the relay opens a TCP connection: no `Origin`, `null`, another origin, an allowed origin with a suffix, a path or other letter case, and two `Origin` headers.

- **The allowed origins.** The runner takes each from `--allowed-origin`, at least one, and refuses to start on an entry not written as a browser sends it: an `http` or `https` scheme, a lowercase host, a port only where it is not the scheme's default, and no path or trailing slash.
- **What it bounds.** A browser sets `Origin` on every WebSocket upgrade and a page's script cannot change it, so the check stops pages of other origins from using the relay from a visitor's browser. A client that is not a browser can send any value, so the check does not authenticate one; the SFTP server's own authentication does.
- **No token.** The relay checks no credential of its own.

## The target

- **Fixed at start.** The relay connects every accepted WebSocket to the one `host:port` the runner's `--target` names, and to nothing else.
- **Nothing a browser sends selects it.** The path, the query, the headers, the subprotocols and the messages of an upgrade are not read for a target.
- **One connection each.** The relay opens one TCP connection to the target for each WebSocket it accepts, as the upgrade completes.
- **Name resolution.** A target named by host name is resolved by the operating system at each connection.
- **No connection on refusal.** An upgrade refused for its path, its `Origin` or the cap below opens no TCP connection.

## Forwarding

- **Unread.** The relay writes the bytes of each binary message to the target in the order they arrive, and sends each read from the target to the browser as one binary message. Message boundaries carry no meaning.
- **One write at a time.** The relay has at most one write to the target in flight. Messages that arrive meanwhile are copied into one pending buffer, written as one write once the write in flight completes; a close of either side writes the pending bytes before it ends the TCP connection.
- **Binary only.** A text message closes the WebSocket with 1003 and ends the TCP connection.
- **The per-message cap.** 65,536 bytes (`SFTP_RELAY_MAX_MESSAGE_BYTES`): an SSH packet of the 35,000 bytes RFC 4253 requires a peer to take, rounded up. A message above it is refused with 1009 before its payload is read.
- **Before the target accepts.** Messages that arrive while the TCP connection is opening are queued for it and count toward its send buffer.

## Backpressure

Each direction stops reading from its source while its destination's send buffer is above 1 MiB (`SFTP_RELAY_SEND_BUFFER_HIGH_BYTES`), and reads again once that buffer is at or below 256 KiB (`SFTP_RELAY_SEND_BUFFER_LOW_BYTES`), the WebSocket relay's window ([WEBSOCKET_RELAY.md](WEBSOCKET_RELAY.md#forwarding)).

- **A slow target.** Toward the target the send buffer is the write in flight and the pending buffer. While their bytes are above the window, the relay reads nothing from the WebSocket.
- **A slow browser.** While the WebSocket's `bufferedAmount` is above the window, the relay reads nothing from the TCP connection. The forwarding toward the browser is the WebSocket relay's own (`sendWithinWindow` in `packages/websocket-relay/src/forwarding.ts`).
- **The bound.** The relay holds at most 1,441,806 bytes of memory for each direction of each connection, for bytes read from the source and not yet written into the destination's socket (`SFTP_RELAY_BUFFERED_BOUND_BYTES`). Toward the target that is the high mark, a partly read message with its 14-byte frame header, the 64 KiB read that crossed the mark, the unused capacity of the write in flight and of the pending buffer, each under the 64 KiB step the pending buffer grows in (`SFTP_RELAY_PENDING_GROWTH_BYTES`), and what the paused source socket reads ahead: under Node's 64 KiB high-water mark, plus one 64 KiB read. Toward the browser it is at most 1,245,194 bytes: the high mark, the 64 KiB read that crossed it with its 10-byte frame header, and the same read-ahead.
- **Any message size.** Toward the target the bound is in memory, not only in payload bytes, for messages of any size: a message behind the write in flight is copied into the pending buffer and has no write of its own, so a flood of 1-byte messages stops at the high mark like one of 64 KiB messages.
- **No termination.** A source held this way waits on its own TCP window and is not disconnected.
- **A close while held.** A close the browser sends while the relay is holding it is not read until the target drains or a ping to the browser fails, up to about one ping interval plus the close wait, and until then the connection counts toward the connection cap.
## Closing

| Event | What the relay does |
| --- | --- |
| The browser closes, with any code | Ends the TCP connection behind every byte already written to it |
| The browser's socket drops with no close frame | The same |
| A text message | Closes the WebSocket with 1003 and ends the TCP connection |
| The target ends its connection | Closes the WebSocket with 1000 behind every byte already sent to the browser |
| The target's connection fails after it was accepted, a reset among them | Closes the WebSocket with 4000 |
| The target refuses the connection, or does not accept it within 10 seconds (`SFTP_RELAY_CONNECT_TIMEOUT_MS`) | Closes the WebSocket with 4001 |
| The relay stops | Closes every WebSocket with 1001 and drops every TCP connection |

- **The close wait.** A close the relay sends, or a TCP end it writes, waits behind the bytes queued ahead of it for at most 30 seconds (`SFTP_RELAY_CLOSE_WAIT_MS`), and the socket is then dropped.
- **Reading through a close.** A source held by backpressure is read again once its connection is closing, so its close is seen; what it then sends is dropped.

### Close codes

| Code | Name | Meaning |
| --- | --- | --- |
| 1000 | `targetClosed` | The target ended its connection normally. |
| 1001 | `goingAway` | The relay is shutting down. |
| 1003 | `textMessage` | The browser sent a text message. |
| 1009 | `messageTooBig` | A message above the per-message cap, closed by `ws`. |
| 4000 | `targetFailed` | The target's connection failed after it was accepted. |
| 4001 | `targetUnreachable` | The target refused the connection or did not accept it in time. |

## Quotas and keepalive

- **Connections.** The relay holds at most 64 connections at once (`SFTP_RELAY_MAX_CONNECTIONS`), each counted from its upgrade until both its WebSocket and its TCP connection have closed. An upgrade above it is answered `503` and closed before the WebSocket opens.
- **No quota for each address.** Behind a front every connection arrives from the front's address, so a per-address bound is the front's.
- **No idle bound.** The relay closes no connection for silence; the SFTP server's own bounds apply to an idle session.
- **Pings.** The relay pings each WebSocket every 30 seconds (`SFTP_RELAY_PING_INTERVAL_MS`), so a front's idle timeout does not cut a silent SSH session.

## Diagnostics

- **The ready line.** The runner prints `alcove-sftp-relay <port>` on stdout once it is listening, after an `INFO` line on stderr naming its target and allowed origins.
- **An unreachable target.** The relay reports a target it could not connect to on stderr at most once a minute (`SFTP_RELAY_FAULT_REPORT_WINDOW_MS`), the signaling broker's diagnostics window.
- **No request log.** The relay writes nothing for a refused upgrade or an ordinary connection.

## The runner

| Flag | Value | Default |
| --- | --- | --- |
| `--target` | The SFTP server, `host:port`, an IPv6 address in brackets | Required |
| `--allowed-origin` | An allowed origin; given once for each | Required, at least once |
| `--host` | The bind address | `127.0.0.1` |
| `--port` | The port, 0 for an ephemeral one | `0` |

An unknown, repeated, valueless or missing flag, or a value of the wrong form, is refused before the relay starts, and the process exits 64.
A bind the operating system refuses exits 69.
The image (`packages/sftp-relay/Dockerfile`) runs the runner with `--host 0.0.0.0 --port 8080`, as the unprivileged `node` account, from one bundled file.

## Tests

- **Against the SFTP test server.** `apps/cli/test/integration/sftpRelay.test.ts` writes and reads a file over SFTP through the relay, and drives each `Origin` case, the fixed target, backpressure each way, each row of the close table but the connect timeout, the 1009 close, the close wait of a TCP end, the connection cap, and the pings. It measures what each direction holds for bytes read and not yet written, after each read and every 5 milliseconds, against the bound above, under messages of 64 KiB and under a flood of 1-byte messages, and checks that a flood leaves one write in flight. It checks that small and large messages reach the target byte for byte and in order ahead of a browser close and of a text message. It runs in the CLI integration suite, on each SFTP backend.
- **The connect timeout.** `packages/sftp-relay/test/relay.test.ts` drives the 4001 close of a target that does not accept in time in process, giving the relay a socket that never connects in place of its connection to the target: no loopback target leaves a TCP handshake incomplete reliably.
- **The runner.** `packages/sftp-relay/test/standaloneOptions.test.ts` and `standalone.test.ts` hold the flag parsing and the runner as a process.
- **The image.** `.github/workflows/image_smoke.yaml` builds the image and forwards a message through it.
