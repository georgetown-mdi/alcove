import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  CAPTURE_FORMAT,
  aboutWebrtcLines,
  captureSummary,
  redact,
  snippetSource,
} from "./webrtc-capture.mjs";

// The snippet runs in a browser page. Here it runs, as the exact text the
// command prints, in a fresh vm context whose RTCPeerConnection is a fake, so a
// reference to this module's scope fails as it would in the page. The fake's
// getStats() reads its report when the promise settles, so a reading started
// just before close() comes back empty, as Chromium's does.

const SCRIPT = fileURLToPath(new URL("./webrtc-capture.mjs", import.meta.url));

class FakePeerConnection extends EventTarget {
  constructor(configuration = {}) {
    super();
    this.configuration = { iceTransportPolicy: "all", ...configuration };
    this.iceGatheringState = "new";
    this.iceConnectionState = "new";
    this.connectionState = "new";
    this.report = new Map();
    this.closed = false;
  }

  getConfiguration() {
    return this.configuration;
  }

  getStats() {
    return Promise.resolve().then(() =>
      this.closed ? new Map() : this.report,
    );
  }

  createDataChannel(label) {
    const channel = new EventTarget();
    channel.label = label;
    return channel;
  }

  close() {
    this.closed = true;
  }
}

function page({ withPeerConnection = true } = {}) {
  const logs = [];
  const downloads = [];
  const blobs = new Map();
  const context = createContext({
    console: { log: (message) => logs.push(message) },
    location: {
      origin: "https://app.example.test",
      pathname: "/accept",
      href: "https://app.example.test/accept#invitation-secret",
    },
    document: {
      body: { append() {} },
      createElement: () => ({
        click() {
          downloads.push({ name: this.download, blob: blobs.get(this.href) });
        },
        remove() {},
      }),
    },
    URL: {
      createObjectURL(blob) {
        const url = `blob:${blobs.size}`;
        blobs.set(url, blob);
        return url;
      },
      revokeObjectURL() {},
    },
    Blob,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
    ...(withPeerConnection ? { RTCPeerConnection: FakePeerConnection } : {}),
  });
  const install = (options) =>
    runInContext(
      snippetSource({ pollMs: 5, saveDelayMs: 20, ...options }),
      context,
    );
  const savedCaptures = async () =>
    Promise.all(
      downloads.map(async ({ blob }) => JSON.parse(await blob.text())),
    );
  return { context, logs, downloads, install, savedCaptures };
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fire(target, type, fields = {}) {
  target.dispatchEvent(Object.assign(new Event(type), fields));
}

function chromeReport() {
  return new Map(
    [
      {
        id: "T01",
        type: "transport",
        selectedCandidatePairId: "CP1",
        dtlsState: "connected",
      },
      {
        id: "CP1",
        type: "candidate-pair",
        localCandidateId: "L1",
        remoteCandidateId: "R1",
        state: "succeeded",
        nominated: true,
        currentRoundTripTime: 0.012,
        bytesSent: 900,
        bytesReceived: 1200,
      },
      {
        id: "CP2",
        type: "candidate-pair",
        localCandidateId: "L2",
        remoteCandidateId: "R1",
        state: "failed",
      },
      {
        id: "L1",
        type: "local-candidate",
        candidateType: "relay",
        protocol: "udp",
        relayProtocol: "tls",
        url: "turns:turn.example.test:443?transport=tcp",
        address: "203.0.113.7",
      },
      {
        id: "L2",
        type: "local-candidate",
        candidateType: "host",
        protocol: "udp",
        address: "192.0.2.10",
      },
      {
        id: "R1",
        type: "remote-candidate",
        candidateType: "host",
        protocol: "udp",
        address: "198.51.100.4",
      },
    ].map((stat) => [stat.id, stat]),
  );
}

describe("snippet in a page", () => {
  it("records a connection's events and last stats, and downloads them when it closes", async () => {
    const { context, logs, downloads, install, savedCaptures } = page();
    install();
    expect(logs[0]).toMatch(/^alcove capture: installed\./);
    const connection = new context.RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.example.test:3478", username: "", credential: "" },
        {
          urls: ["turns:turn.example.test:443?transport=tcp"],
          username: "1800000000:alcove",
          credential: "turn-credential-value",
        },
      ],
    });
    connection.report = chromeReport();
    const channel = connection.createDataChannel("exchange");
    connection.iceGatheringState = "gathering";
    fire(connection, "icegatheringstatechange");
    fire(connection, "icecandidate", {
      candidate: {
        type: "relay",
        protocol: "udp",
        candidate: "candidate:1 1 udp 1 203.0.113.7 5000 typ relay",
      },
    });
    fire(connection, "icecandidate", {
      candidate: {
        candidate: "candidate:2 1 udp 1 192.0.2.10 5001 typ host",
        protocol: "udp",
      },
    });
    fire(connection, "icecandidateerror", {
      errorCode: 701,
      errorText: "TURN allocate request timed out.",
      url: "turns:turn.example.test:443?transport=tcp",
    });
    connection.connectionState = "connected";
    fire(connection, "connectionstatechange");
    fire(channel, "open");
    await wait(30);
    connection.close();
    await wait(60);

    expect(downloads).toHaveLength(1);
    expect(downloads[0].name).toMatch(/^alcove-webrtc-capture-\d+-1\.json$/);
    const [capture] = await savedCaptures();
    expect(capture.format).toBe(CAPTURE_FORMAT);
    expect(capture.page).toBe("https://app.example.test/accept");
    expect(JSON.stringify(capture)).not.toContain("turn-credential-value");
    expect(JSON.stringify(capture)).not.toContain("invitation-secret");
    const [record] = capture.connections;
    expect(record.iceServers).toEqual([
      { urls: "stun:stun.example.test:3478" },
      {
        urls: ["turns:turn.example.test:443?transport=tcp"],
        username: "1800000000:alcove",
        credential: "REDACTED",
      },
    ]);
    expect(record.ended.reason).toBe("closed");
    expect(record.events.map((entry) => entry.event)).toEqual([
      "datachannel",
      "icegatheringstate",
      "icecandidate",
      "icecandidate",
      "icecandidateerror",
      "connectionstate",
      "datachannel-open",
      "close",
    ]);
    expect(record.events[3].type).toBe("host");
    expect(record.events[4].errorCode).toBe(701);
    expect(record.stats.selectedPair.id).toBe("CP1");
    expect(record.stats.selectedLocal.candidateType).toBe("relay");
    expect(record.stats.candidatePairs).toHaveLength(2);
  });

  it("downloads when a connection fails, and once more with both connections when the next one ends", async () => {
    const { context, downloads, install, savedCaptures } = page();
    install();
    const first = new context.RTCPeerConnection();
    const second = new context.RTCPeerConnection();
    first.connectionState = "failed";
    fire(first, "connectionstatechange");
    await wait(60);
    second.close();
    await wait(60);
    expect(downloads).toHaveLength(2);
    const [early, late] = await savedCaptures();
    expect(
      early.connections.map((record) => record.ended?.reason ?? null),
    ).toEqual(["failed", null]);
    expect(late.connections.map((record) => record.ended.reason)).toEqual([
      "failed",
      "closed",
    ]);
  });

  it("picks Firefox's selected pair when no transport names one", async () => {
    const { context, install, savedCaptures } = page();
    install();
    const connection = new context.RTCPeerConnection();
    connection.report = new Map([
      [
        "P1",
        {
          id: "P1",
          type: "candidate-pair",
          state: "failed",
          localCandidateId: "a",
          remoteCandidateId: "b",
        },
      ],
      [
        "P2",
        {
          id: "P2",
          type: "candidate-pair",
          state: "succeeded",
          selected: true,
          localCandidateId: "a",
          remoteCandidateId: "b",
        },
      ],
    ]);
    await wait(30);
    connection.close();
    await wait(60);
    const [capture] = await savedCaptures();
    expect(capture.connections[0].stats.selectedPair.id).toBe("P2");
  });

  it("forces relay-only gathering with --relay-only", () => {
    const { context, install } = page();
    install({ relayOnly: true });
    const connection = new context.RTCPeerConnection({ iceServers: [] });
    expect(connection.getConfiguration().iceTransportPolicy).toBe("relay");
  });

  it("installs once per tab, and not at all without RTCPeerConnection", () => {
    const twice = page();
    twice.install();
    twice.install();
    expect(twice.logs[1]).toBe(
      "alcove capture: already installed in this tab.",
    );
    const none = page({ withPeerConnection: false });
    none.install();
    expect(none.logs).toEqual([
      "alcove capture: this page has no RTCPeerConnection; nothing installed.",
    ]);
  });
});

function sampleCapture() {
  return {
    format: CAPTURE_FORMAT,
    page: "https://app.example.test/accept",
    installed: "2026-10-24T14:00:00.000Z",
    saved: "2026-10-24T14:00:09.000Z",
    relayOnly: false,
    connections: [
      {
        connection: 1,
        created: "2026-10-24T14:00:01.000Z",
        iceServers: [
          { urls: "stun:stun.example.test:3478" },
          {
            urls: ["turns:turn.example.test:443?transport=tcp"],
            username: "1800000000:alcove",
            credential: "REDACTED",
          },
        ],
        iceTransportPolicy: "all",
        ended: { ms: 5300, reason: "closed" },
        events: [
          { ms: 10, event: "icegatheringstate", state: "gathering" },
          { ms: 12, event: "icecandidate", type: "host", protocol: "udp" },
          { ms: 15, event: "icecandidate", type: "host", protocol: "udp" },
          { ms: 310, event: "icecandidate", type: "relay", protocol: "udp" },
          {
            ms: 400,
            event: "icecandidateerror",
            errorCode: 701,
            errorText: "STUN binding request timed out.",
            url: "stun:stun.example.test:3478",
          },
          { ms: 1200, event: "iceconnectionstate", state: "connected" },
          { ms: 1500, event: "connectionstate", state: "connected" },
          { ms: 1600, event: "datachannel-open", label: "exchange" },
        ],
        stats: {
          transport: { dtlsState: "connected" },
          selectedPair: {
            id: "CP1",
            state: "succeeded",
            currentRoundTripTime: 0.012,
            bytesSent: 900,
            bytesReceived: 1200,
          },
          selectedLocal: {
            candidateType: "relay",
            protocol: "udp",
            relayProtocol: "tls",
            url: "turns:turn.example.test:443?transport=tcp",
            address: "203.0.113.7",
          },
          selectedRemote: {
            candidateType: "host",
            protocol: "udp",
            address: "198.51.100.4",
          },
          localCandidates: [
            { candidateType: "relay" },
            { candidateType: "host" },
            { candidateType: "host" },
          ],
          remoteCandidates: [{ candidateType: "host" }],
          candidatePairs: [{ state: "succeeded" }, { state: "failed" }],
          dataChannels: [],
        },
      },
    ],
  };
}

describe("captureSummary", () => {
  it("summarizes servers, timeline, candidates and the selected pair without addresses", () => {
    const lines = captureSummary(sampleCapture());
    expect(lines).toEqual([
      "page https://app.example.test/accept, installed 2026-10-24T14:00:00.000Z, saved 2026-10-24T14:00:09.000Z, 1 connections, relay candidates only: no",
      "",
      "connection 1: created 2026-10-24T14:00:01.000Z, ended closed after 5.30 s, ICE transport policy all",
      "  servers: stun:stun.example.test:3478; turns:turn.example.test:443?transport=tcp (authenticated)",
      "  timeline:",
      "    0.01 s  icegatheringstate gathering",
      "    0.01 s  icecandidate host (udp)",
      "    0.31 s  icecandidate relay (udp)",
      "    0.40 s  candidate error 701 at stun:stun.example.test:3478: STUN binding request timed out.",
      "    1.20 s  iceconnectionstate connected",
      "    1.50 s  connectionstate connected",
      "    1.60 s  datachannel-open exchange",
      "  local candidates: 1 relay, 2 host",
      "  remote candidates: 1 host",
      "  candidate pairs: 1 succeeded, 1 failed",
      "  selected pair: local relay udp relayed over tls via turns:turn.example.test:443?transport=tcp -> remote host udp; state succeeded, round trip 12 ms, bytes sent 900, received 1200",
      "  DTLS: connected",
    ]);
  });

  it("says when no stats were read", () => {
    const capture = sampleCapture();
    capture.connections[0].stats = null;
    capture.connections[0].ended = null;
    const lines = captureSummary(capture);
    expect(lines).toContain("  stats: none read before it ended");
    expect(lines[2]).toContain("had not ended when saved");
  });

  it("refuses a file that is not a capture", () => {
    expect(() => captureSummary({ PeerConnections: {} })).toThrow(
      "not a capture file",
    );
  });
});

describe("redact", () => {
  it("removes addresses, invitation fragments, usernames and credentials", () => {
    expect(
      redact(
        "url=https://app.example.test/accept#abc123 from 192.0.2.10:5000 and [2001:db8::1]:443 " +
          "host 0a1b2c3d-0000-1111-2222-333344445555.local user 1800000000:alcove " +
          '"credential": "s3cret", pwd=abc, #' +
          "A".repeat(43),
      ),
    ).toBe(
      "url=https://app.example.test/accept#<redacted> from <ip4>:5000 and [<ip6>]:443 " +
        "host <mdns> user <turn-user> " +
        '"credential": "<redacted>", pwd=<redacted>, #<redacted>',
    );
  });
});

describe("aboutWebrtcLines", () => {
  it("keeps the ICE and error lines of a saved page, tags stripped, redacted, once each", () => {
    const saved = [
      "<html><body><h2>RTCPeerConnection Statistics</h2>",
      "<div>PeerConnection ID: 7 (id=42 url=https://app.example.test/accept#secretfragment)</div>",
      "<table><tr><td>local relay candidate 203.0.113.7:49173 typ relay</td></tr>",
      "<tr><td>local relay candidate 203.0.113.7:49173 typ relay</td></tr>",
      "<tr><td>Bytes sent 12</td></tr></table>",
      "<p>TURN(relay(...TLS|turn.example.test:443/TLS)): XOR-MAPPED-ADDRESS is bogus</p>",
      "<p>iceServers: urls=turns:turn.example.test:443 username=1800000000:alcove &amp; credential=abc</p>",
      "<p>all checks completed success=0 fail=1</p>",
      "</body></html>",
    ].join("\n");
    expect(aboutWebrtcLines(saved)).toEqual([
      "PeerConnection ID: 7 (id=42 url=https://app.example.test/accept#<redacted>",
      "local relay candidate <ip4>:49173 typ relay",
      "TURN(relay(...TLS|turn.example.test:443/TLS)): XOR-MAPPED-ADDRESS is bogus",
      "iceServers: urls=turns:turn.example.test:443 username=<redacted> & credential=<redacted>",
      "all checks completed success=0 fail=1",
    ]);
  });
});

describe("webrtc-capture.mjs command line", () => {
  const directories = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function file(name, content) {
    const directory = mkdtempSync(join(tmpdir(), "webrtc-capture-"));
    directories.push(directory);
    const path = join(directory, name);
    writeFileSync(path, content);
    return path;
  }

  const cli = (...args) =>
    spawnSync("node", [SCRIPT, ...args], { encoding: "utf8" });

  it("prints the snippet, relay-only when asked", () => {
    const plain = cli("snippet");
    expect(plain.status).toBe(0);
    expect(plain.stdout).toMatch(/^\(function installCapture\(settings\)/);
    expect(plain.stdout).toContain(`"relayOnly":false`);
    expect(cli("snippet", "--relay-only").stdout).toContain(`"relayOnly":true`);
  });

  it("summarizes a capture file and filters a saved about:webrtc page", () => {
    const summary = cli(
      "read-capture",
      file("c.json", JSON.stringify(sampleCapture())),
    );
    expect(summary.status).toBe(0);
    expect(summary.stdout).toContain("selected pair: local relay udp");
    const about = cli(
      "read-about-webrtc",
      file("a.txt", "<p>typ relay 192.0.2.1</p>"),
    );
    expect(about.status).toBe(0);
    expect(about.stdout).toBe("1 matching lines, redacted:\ntyp relay <ip4>\n");
  });

  it("exits 1 on a file it cannot read as asked, and 2 on a usage error", () => {
    expect(cli("read-capture", file("x.json", "{}")).status).toBe(1);
    expect(cli("read-capture", "/no/such/file.json").status).toBe(1);
    for (const args of [
      [],
      ["record"],
      ["snippet", "--udp"],
      ["read-capture"],
    ]) {
      const { status, stderr } = cli(...args);
      expect(status, args.join(" ")).toBe(2);
      expect(stderr, args.join(" ")).toContain("Run with --help for usage.");
    }
  });
});
