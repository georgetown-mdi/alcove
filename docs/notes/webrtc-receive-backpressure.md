---
title: "Receive-side backpressure on WebRTC data channels"
---

# Receive-side backpressure on WebRTC data channels

_Status: measured on 2026-11-11 on one host; nothing is decided.
This note records how established projects bound a receiver's memory on a data channel and a probe of whether holding the SCTP receive window pauses a sender, set beside the alternative that changes the wire, a credit window in Alcove's framing.
The research and the probe were done by an agent and are not yet ratified.
See [docs/notes/README.md](README.md)._

## The question

A data channel pushes frames to its receiver.
Alcove queues each delivered frame in `QueuedMessageConnection` until the consumer reads it, and refuses a frame past the queue's bound rather than pausing the sender ([TRANSPORT_BOUNDS.md, WebRTC data-channel inbound bound](../spec/TRANSPORT_BOUNDS.md#webrtc-data-channel-inbound-bound), "The inbound queue": seven frames' bytes on the command-line application, six in the browser).
A reader that falls that far behind in a large round fails the run.
A receiver could make its sender wait at one of two layers:

- **Hold the SCTP receive window** until the application has read what it was sent.
  Nothing changes on Alcove's wire, but both SCTP stacks must cooperate.
- **A credit window above SCTP**: the receiver grants bytes as it reads, and the sender sends only against credit.
  It works over any SCTP stack, but adds a message to Alcove's wire.

Either way the queue's refusal remains: a hostile partner can ignore a window or a grant, so pausing is cooperative and the bound is the enforced limit.

The research read web pages on 2026-11-11 through a fetch tool that summarizes, so quoted wording is that tool's quote, not a byte-checked copy; repository and `node_modules` facts were read directly.

## How established projects bound a receiver's memory

| Project | Mechanism |
| --- | --- |
| Chromium dcSCTP (libwebrtc) | A pull mode that holds the window, off by default and not used by Chrome |
| Pion (`pion/sctp`) | Holds the window until the application reads |
| libdatachannel (usrsctp) | A bounded queue that blocks the receive thread, for polling readers only |
| aiortc and werift | Restore the window as each message is popped, before the application reads |
| libp2p WebRTC | No flow control in the spec |
| QUIC (RFC 9000) | A credit window tied to consumption |

**Chromium dcSCTP.**
The commit adding pull mode ([179a620](https://webrtc.googlesource.com/src/+/179a6207008d9d114e525c42c9dcb4c98b0c8735), 2025) explains that with callbacks "the socket will immediately restore the advertised receiver window", so the window "is of little use for implementing back-pressure".
Pull mode keeps unread messages buffered and shrinks the window, while the sender "can always keep one MTU in flight".
`enable_receive_pull_mode` defaults to false (`net/dcsctp/public/dcsctp_options.h`), and Chrome's `DcSctpTransport::OnMessageReceived` hands each message straight to the channel: Chrome stays in push mode.
dcSCTP became the default in a 2022-02-17 reland ([29ff3ef](https://webrtc.googlesource.com/src/+/29ff3efebf8081c518b4bce191c625660f402bd2)).

**Pion.**
`getMyReceiverWindowCredit()` returns the receive buffer, 1 MiB by default, minus the bytes in every reassembly queue, and a message's bytes leave the queue only when the reader copies it out, so a slow `Read` closes the window.
Its sender sends a zero-window probe when nothing is in flight.
Whether a read sends a window-update SACK was not confirmed.
The window counts user data only, which go-libp2p estimated as about 100 times memory amplification ([go-libp2p#2724](https://github.com/libp2p/go-libp2p/pull/2724)).

**libdatachannel.**
`doRecv()` calls the application callback inline, so a callback that blocks leaves data in usrsctp and closes its 1 MiB window (inferred from the code, not run).
A channel with no callback queues up to 1024 messages (`RECV_QUEUE_LIMIT`), then blocks: the limit counts messages, not bytes.

**aiortc** credits each message back as `pop_messages()` yields it, just before the application gets it, and its sender ignores the peer's window.

**libp2p** framing "is not concerned with flow-control" ([WebRTC spec](https://github.com/libp2p/specs/blob/master/webrtc/README.md), Multiplexing).

**QUIC**: "A receiver could determine the flow control offset to be advertised based on the current offset of data consumed" ([RFC 9000](https://www.rfc-editor.org/rfc/rfc9000.html), section 4.1).

**SCTP itself**: "The data receiver SHOULD NOT increment a_rwnd unless it has released bytes from its receive buffer" ([RFC 9260](https://www.rfc-editor.org/rfc/rfc9260.html), section 6.2), and section 6.1 forbids new data into a full peer "except for zero window probes".

**Browsers as receivers.**
In [w3c/webrtc-nv-use-cases#30](https://github.com/w3c/webrtc-nv-use-cases/issues/30) (closed 2019), Lennart Grahl: "There is no mechanism for that (and FWIW the same applies to WebSockets)"; Bernard Aboba: "Today implementations don't limit the message events in the event queue".
A 2014 `setReadEnabled(bool)` proposal ([public-webrtc](https://lists.w3.org/Archives/Public/public-webrtc/2014Mar/0084.html)) was not adopted.
A page cannot hold the window, so only the command-line application, as receiver, could.

Not researched: Syncthing and other file-transfer tools, simple-peer, and PeerJS's receive handling.

## werift and node-datachannel

**werift 0.27.0**, the version `package-lock.json` resolves, `node_modules/werift/lib/sctp/src/sctp.js`, line numbers as of that version:

- `advertisedRwnd` starts at `1024 * 1024` (206-211); each SACK advertises `Math.max(0, this.advertisedRwnd)` (908).
- `receiveDataChunk` debits each DATA chunk (1337) and has no closed-window check: it accepts every new chunk.
- `deliverMessages` credits each message back as it is popped, before the message event fires (1314-1319), and the FORWARD-TSN path does the same (1505).
  The window counts partial messages, not delivered, unread ones.
- The sender stops at `peerRwnd <= 0` (1680), sends one chunk past the window when nothing is in flight (1683), and has no zero-window probe.
- `datachannelReceive` (`lib/webrtc/src/transport/sctp.js`) emits the message without its size, so an application has nothing to release window through.

A keyword search of the [werift-webrtc](https://github.com/shinyoshiaki/werift-webrtc) issues and pull requests found nothing on receive flow control.

**node-datachannel** exposes no receive control ([API.md](https://github.com/murat-dogan/node-datachannel/blob/master/API.md)).
Its wrapper forwards every message through a callback with an unlimited queue, so usrsctp is drained, the window stays open, and unread messages accumulate in the Node event loop.
Holding the window would need libdatachannel's polling API ([DOC.md](https://github.com/paullouisageneau/libdatachannel/blob/master/DOC.md)), which node-datachannel does not bind.

## Browsers as senders, WebSocketStream and WebTransport

- **Chromium (dcSCTP)**, from source: the send budget is the peer's window minus unacknowledged bytes, with one MTU allowed "regardless of the value of rwnd (including if it is 0)" when nothing is in flight; unsent bytes count in `bufferedAmount`.
  Alcove's sender waits while `bufferedAmount` is at or above 1 MiB (`SEND_WINDOW_BYTES`, [webrtcMessageConnection.ts](../../apps/cli/src/connection/webrtc/webrtcMessageConnection.ts)).
  Firefox and Safari were not read at source.
- **WebSocket** has no receive backpressure ([WHATWG](https://websockets.spec.whatwg.org/)).
  **WebSocketStream** can "take advantage of stream backpressure automatically" but is experimental and in no specification ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/WebSocketStream)); Chrome and Edge 124 only.
- **WebTransport** ([Candidate Recommendation Snapshot, 30 July 2026](https://www.w3.org/TR/webtransport/)) creates incoming streams with a high-water mark of 0, and backpressure on reads comes from QUIC's credit.
  Chrome and Edge 97, Firefox 114, Safari 26.4 (mdn/browser-compat-data, 2026-11-11).
  It needs an HTTP/3 server in the data path: a relay, not peer to peer.

## The probe

Measured 2026-11-11 on the maintainer's host: macOS 26.6.2 arm64, Node v26.13.0, werift 0.27.0 (lockfile integrity matched), Playwright 1.64.1 with Chromium 156.0.8078.4 (headless shell) and Firefox 157.0.

**Patch.** The receiver stops crediting at pop and credits through a new `releaseRwnd(bytes)` that sends an immediate SACK, gated on a per-instance `holdRwnd` flag so one install serves the patched receiver and a stock werift sender:

```diff
     deliverMessages(inboundStream) {
         for (const message of inboundStream.popMessages()) {
-            this.advertisedRwnd += message[2].length;
+            if (!this.holdRwnd) this.advertisedRwnd += message[2].length;
             this.receive(...message);
         }
+    }
+    releaseRwnd(bytes) {
+        this.advertisedRwnd += bytes;
+        this.sackNeeded = true;
+        this.sackImmediate = true;
+        return this.sendSack();
     }
@@ receiveForwardTsnChunk
-                this.advertisedRwnd += message[2].length;
+                if (!this.holdRwnd) this.advertisedRwnd += message[2].length;
```

**Run.**
A werift receiver in Node reads nothing for a 4,000 ms hold, then releases every held datagram in one loop and each later one as it arrives.
The sender sends 640 datagrams of 16,300 bytes (10,432,000 bytes, ten times the window) through Alcove's send-window wait: 1 MiB, `bufferedamountlow` at 256 KiB, a 250 ms poll.
A control uses a stock receiver that also reads nothing.
Each case ran three times unless stated.

**Case 1, werift sender, window held.**
The receiver took 1,043,200 bytes plus part of one datagram; its window bottomed at -424, advertised as 0.
The sender stopped 258-302 ms after the start, `bufferedAmount` at 1,059,500, through the whole hold; after release new data arrived in 13-14 ms and every run completed.
In the three controls all bytes arrived during the hold.

**Case 2, werift sender, window update lost.**
Dropping the first SACK after release changed nothing, since the release sends one SACK per held datagram.
Dropping all 64 update SACKs stopped the sender for the whole 60 s wait in all three runs, across a 30 s heartbeat interval on each side, with no zero-window probe.
One fresh SACK restarted it.

**Case 3, Chromium sender.**
It did not pause: it kept sending into the zero window, the receiver accepted about 9.4 MB over the window, and each run finished 1.8-2.4 s before the release, so the lost-update case is moot.
With each receiver SACK delayed 50 ms by a timer over a 10 s hold (7 runs), it sent into the closed window at 116-126 KB/s, and in 3 runs the Chromium channel or connection closed after release, cause not found; the timer may cause it.

**Case 4, Firefox sender.**
The same as Chromium: no pause, about 9.4 MB over the window.

**A receiver that drops data over a closed window**, a variant beyond the briefed patch, dropped new DATA arriving while its window was at or below 0.
Both browsers then paused within 1,116 bytes of the window, probing at doubling intervals, and resumed about 2 s after release whether or not the updates were dropped, which matches a retransmission timer capped near 3 s rather than the update (inferred from timing).
One of nine Chromium runs never finished: the variant dropped the retransmission that would fill a reassembly gap.
A correct rule accepts a gap-filling chunk at zero window; the RFC reference for it was given from memory, unverified.

### Limits of the measurement

- One host, traffic over its own interfaces; the round trip is well under a millisecond except in the delayed-SACK runs, and completion times after release measure werift's loss recovery.
- Browser internals were not observed, only `bufferedAmount`, the send loop and what arrived; Chromium is the headless shell, and Safari was not run.
- The werift sender shares the receiver's Node process.
- No Alcove code is in the loop: no envelope, framing, encryption or queue.
  A reader releasing one datagram at a time against a closed window was not run.
- A stall is bounded at 60 s; SACK loss is simulated at the receiver; DATA loss was not injected; the SACK delay is a timer, not a network emulator.
- The drop variant is unreviewed and has the gap-fill defect above.

**Shown:** a werift sender pauses at the window and resumes on release, but stops for at least 60 s when the release's update is lost whole; Chromium and Firefox pause only when the receiver drops DATA over a closed window.
**Not shown:** a real network, Alcove's framing in the loop, a correct drop rule, the cause of the Chromium closes, a probe added to werift's sender, Safari.

## What a held window would need

1. Credit through a release method that sends a window-update SACK, not at pop (1316, 1505).
2. Drop new DATA over a closed window while accepting a gap-filling chunk, or browser senders do not pause.
3. Repeat the update while the window has been closed, or add a zero-window probe to werift's sender, as dcSCTP did in 2021 ([3f981ee](https://webrtc.googlesource.com/src/+/3f981ee9797a3db969ece21263c07388a05eaa43)).
4. Reach the werift peer's `RTCSctpTransport.sctp` from [weriftPeer.ts](../../apps/cli/src/connection/webrtc/weriftPeer.ts) to release by size.
5. Account per frame without deadlock.
   SCTP messages are 16,300-byte datagrams (`PEERJS_CHUNK_MTU`, [webrtcOutboundBound.ts](../../packages/core/src/connection/webrtcOutboundBound.ts)), but the queue's unit is a frame of up to 256 MiB reassembled above SCTP ([framedTransport.ts](../../apps/cli/src/connection/webrtc/framedTransport.ts)), so a 1 MiB window held until a whole frame is read deadlocks.
   The research proposes releasing per datagram as the reassembler accepts it, debiting a whole frame when it completes, and crediting it when [`QueuedMessageConnection`](../../packages/core/src/connection/messageConnection.ts) dequeues it: the research's own analysis, not a documented technique.

It reaches only the command-line application as receiver.

## The alternative that changes the wire

The panel convened on 2026-11-04 on the shape of the inbound queue's bound offered a credit window: a receiver-granted byte window, credit-based flow control in the WebRTC transport wrap, shared by the werift and PeerJS paths.

- Each queued frame is charged its reassembly wire charge (`webrtcFrameReceiveCharge`) until the consumer reads it.
- The receiver returns the window as each frame is read, in one reserved, bounded credit datagram outside the encryption layer, and the sender waits for credit.
- The window is one or two `MAX_WEBRTC_FRAME_BYTES`; the seats differed.
- A frame past the receiver's own grant is refused as a `protocol` failure; the 1024-frame count cap remains.
- Credits need no authentication: the refusal reads only the receiver's own ledger.

The seats named its costs: a wire datagram with parity fixtures in both wraps, a spec rewrite, a test running every exchange mode at a small frame bound to show no deadlock, and a deadlock if a future step has both parties send more than a window without reading.
Mixed builds stall until a timeout or are refused.

| Property | Held SCTP window | Credit window |
| --- | --- | --- |
| Wire change | None (RFC 9260 section 6.2) | One credit datagram |
| Dependency | A werift patch or upstream change | Alcove code, shared by both apps |
| Browser receiver | Cannot hold the window | Works |
| Browser sender | Pauses only if over-window DATA is dropped (measured) | Waits for credit |
| werift sender | Pauses (measured); stops on a lost update (measured) | Waits for credit |
| Frame accounting | Per-datagram release plus frame debit | Per frame |
| Prior art | Pion; dcSCTP off by default | QUIC (RFC 9000 section 4.1) |

## Re-running the probe

Two Node scripts in a `mktemp -d` directory outside the repository, with werift 0.27.0 and Playwright 1.64.1 installed there:

- `patch.js <path to sctp.js>` asserts each cited line's text, then applies the diff above.
- `run.js <werift|chromium|firefox> <control|hold|drop1|dropburst> <run>` connects receiver and sender with SDP passed in-process (no signaling server), runs the hold and release, and writes a JSON result.
  `HOLD_MS` defaults to 4000 and `POST_TIMEOUT_MS` to 30000 (60000 for `dropburst`).
  Chromium runs with `--disable-features=WebRtcHideLocalIpsWithMdns` and Firefox with `media.peerconnection.ice.obfuscate_host_addresses=false`, so host candidates are plain IPs.
- `drop1` and `dropburst` wrap the receiver's `sctp.sendChunk` to discard the first SACK after release, or all the release loop sends; `dropburst` then sends one `releaseRwnd(0)` if unfinished.
  `SACK_DELAY_MS=50` delays SACKs; `DROP_OVER_WINDOW=1` wraps `receiveDataChunk` to drop new DATA at a closed window.
- Every 50 ms it samples the receiver's `advertisedRwnd`, the sender's `bufferedAmount` and send count, and the werift sender's `peerAdvertisedRwnd` and `flightSize`.
