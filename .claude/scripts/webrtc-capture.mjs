#!/usr/bin/env node
// Capture a browser's WebRTC connections for a host hand-off, so a brief runs
// one checked-in tool rather than describing a browser's internals pages:
// chrome://webrtc-internals keeps no closed connection, and the pages' controls
// differ by browser version. Commands and the owner's steps: USAGE.
//
// The snippet wraps the page's RTCPeerConnection, so it sees only connections
// the page creates after it is pasted. It polls getStats() while a connection
// lives, takes a last reading when the page closes it, and downloads one JSON
// file per batch of ended connections, containing every connection so far. It
// stores the page's origin and path but not its fragment, which contains an
// invitation's secret, and no TURN credential. The readers print no IP
// address, credential, TURN username or invitation fragment.
//
// Exit 0 done; 1 a file could not be read as asked; 2 a usage error.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The format marker in a capture file, checked by read-capture. */
export const CAPTURE_FORMAT = "alcove-webrtc-capture/1";

/** Milliseconds between two getStats() readings of a live connection. */
export const POLL_MS = 200;

/** Milliseconds after the last connection ends before the page downloads. */
export const SAVE_DELAY_MS = 1500;

const ABOUT_WEBRTC_LINE_LIMIT = 400;
const USAGE_EXIT = 2;

/** The usage text, with the steps a brief gives the owner. */
export const USAGE = `Usage: node .claude/scripts/webrtc-capture.mjs <command>

Captures a browser's WebRTC connections for a host hand-off.

  snippet [--relay-only]     print the capture code. The owner opens the page,
                             opens its developer console, pastes the code there
                             and starts the exchange in that tab. When the tab's
                             connections end it downloads
                             alcove-webrtc-capture-<time>-<n>.json; the highest
                             <n> has every connection. A connection that never
                             closes or fails downloads nothing until the owner
                             runs alcoveWebrtcCapture.save() in the same
                             console. --relay-only also makes
                             the tab's connections gather relay candidates only
  read-capture <file>        summarize a capture file: the ICE servers, a
                             timeline of states, first candidates, candidate
                             errors and data channels, the candidate counts and
                             the selected candidate pair
  read-about-webrtc <file>   filter a Firefox about:webrtc page, saved with its
                             sections expanded, to its ICE, candidate and error
                             lines
  -h, --help                 print this help

On macOS, copy the snippet with:
  node .claude/scripts/webrtc-capture.mjs snippet | pbcopy
Move each download into the run's artifacts directory before reading it: the
capture contains candidate addresses, which the readers do not print.
`;

// Runs in the page, serialized by snippetSource: it may use only its argument
// and the page's globals, never this module's scope.
function installCapture(settings) {
  const scope = globalThis;
  const say = (message) => scope.console.log(`alcove capture: ${message}`);
  if (scope.alcoveWebrtcCapture !== undefined) {
    say("already installed in this tab.");
    return;
  }
  const Original = scope.RTCPeerConnection;
  if (typeof Original !== "function") {
    say("this page has no RTCPeerConnection; nothing installed.");
    return;
  }

  const installedAt = Date.now();
  const page = scope.location.origin + scope.location.pathname;
  const connections = [];
  let saves = 0;
  let saveTimer;

  const save = () => {
    saves += 1;
    const body = JSON.stringify(
      {
        format: settings.format,
        page,
        installed: new Date(installedAt).toISOString(),
        saved: new Date().toISOString(),
        relayOnly: settings.relayOnly,
        connections,
      },
      null,
      1,
    );
    const url = scope.URL.createObjectURL(
      new scope.Blob([body], { type: "application/json" }),
    );
    const link = scope.document.createElement("a");
    link.href = url;
    link.download = `alcove-webrtc-capture-${installedAt}-${saves}.json`;
    scope.document.body.append(link);
    link.click();
    link.remove();
    scope.setTimeout(() => scope.URL.revokeObjectURL(url), 60000);
    say(`downloaded ${link.download} (${connections.length} connections).`);
  };
  const saveSoon = () => {
    scope.clearTimeout(saveTimer);
    saveTimer = scope.setTimeout(save, settings.saveDelayMs);
  };

  const readStats = (report) => {
    const all = [];
    report.forEach((stat) => all.push({ ...stat }));
    const byId = new Map(all.map((stat) => [stat.id, stat]));
    const ofType = (type) => all.filter((stat) => stat.type === type);
    const transport =
      ofType("transport").find((stat) => stat.selectedCandidatePairId) ??
      ofType("transport")[0] ??
      null;
    const pairs = ofType("candidate-pair");
    const pair =
      (transport && byId.get(transport.selectedCandidatePairId)) ??
      pairs.find((stat) => stat.selected === true) ??
      pairs.find((stat) => stat.nominated && stat.state === "succeeded") ??
      null;
    return {
      at: new Date().toISOString(),
      transport,
      selectedPair: pair,
      selectedLocal: pair ? (byId.get(pair.localCandidateId) ?? null) : null,
      selectedRemote: pair ? (byId.get(pair.remoteCandidateId) ?? null) : null,
      localCandidates: ofType("local-candidate"),
      remoteCandidates: ofType("remote-candidate"),
      candidatePairs: pairs,
      dataChannels: ofType("data-channel"),
    };
  };

  const withoutCredentials = (servers) =>
    (servers ?? []).map((server) => {
      const kept = { urls: server.urls };
      if (server.username) kept.username = server.username;
      if (server.credential) kept.credential = "REDACTED";
      return kept;
    });

  const candidateType = (candidate) =>
    candidate.type ?? / typ (\w+)/.exec(candidate.candidate ?? "")?.[1] ?? "?";

  const tracked = new WeakMap();

  class CapturedPeerConnection extends Original {
    constructor(configuration, ...rest) {
      super(
        settings.relayOnly
          ? { ...configuration, iceTransportPolicy: "relay" }
          : configuration,
        ...rest,
      );
      const created = Date.now();
      const effective = this.getConfiguration();
      const record = {
        connection: connections.length + 1,
        created: new Date(created).toISOString(),
        iceServers: withoutCredentials(effective.iceServers),
        iceTransportPolicy: effective.iceTransportPolicy,
        ended: null,
        events: [],
        stats: null,
      };
      connections.push(record);
      let timer;
      const note = (event, detail) =>
        record.events.push({ ms: Date.now() - created, event, ...detail });
      // A reading taken as the connection closes can come back without its
      // candidates, so it does not replace one that has them.
      const poll = () =>
        this.getStats().then(
          (report) => {
            if (record.ended !== null) return;
            const reading = readStats(report);
            const kept = record.stats?.candidatePairs.length ?? 0;
            if (reading.candidatePairs.length > 0 || kept === 0) {
              record.stats = reading;
            }
          },
          () => {},
        );
      const finish = (reason) => {
        if (record.ended !== null) return;
        record.ended = { ms: Date.now() - created, reason };
        scope.clearInterval(timer);
        saveSoon();
      };
      const watchChannel = (channel) => {
        const label = channel.label;
        note("datachannel", { label });
        channel.addEventListener("open", () =>
          note("datachannel-open", { label }),
        );
        channel.addEventListener("close", () =>
          note("datachannel-close", { label }),
        );
      };
      this.addEventListener("icegatheringstatechange", () =>
        note("icegatheringstate", { state: this.iceGatheringState }),
      );
      this.addEventListener("iceconnectionstatechange", () => {
        note("iceconnectionstate", { state: this.iceConnectionState });
        poll();
      });
      this.addEventListener("connectionstatechange", () => {
        const state = this.connectionState;
        note("connectionstate", { state });
        const reading = poll();
        if (state === "failed") reading.then(() => finish("failed"));
      });
      this.addEventListener("icecandidate", (event) =>
        note(
          "icecandidate",
          event.candidate
            ? {
                type: candidateType(event.candidate),
                protocol: event.candidate.protocol ?? null,
              }
            : { type: "end-of-candidates" },
        ),
      );
      this.addEventListener("icecandidateerror", (event) =>
        note("icecandidateerror", {
          errorCode: event.errorCode,
          errorText: event.errorText,
          url: event.url,
        }),
      );
      this.addEventListener("datachannel", (event) =>
        watchChannel(event.channel),
      );
      timer = scope.setInterval(poll, settings.pollMs);
      tracked.set(this, { note, poll, finish, watchChannel });
    }

    createDataChannel(...args) {
      const channel = super.createDataChannel(...args);
      tracked.get(this)?.watchChannel(channel);
      return channel;
    }

    close() {
      const state = tracked.get(this);
      if (state !== undefined) {
        state.note("close", {});
        state.poll().then(() => state.finish("closed"));
      }
      super.close();
    }
  }

  scope.RTCPeerConnection = CapturedPeerConnection;
  scope.alcoveWebrtcCapture = { connections, save };
  say(
    `installed${settings.relayOnly ? " (relay candidates only)" : ""}. ` +
      "Start the exchange in this tab; a capture file downloads when its connections end, " +
      "or at any time when you run alcoveWebrtcCapture.save().",
  );
}

/**
 * The code the owner pastes into the page's console. `pollMs` and
 * `saveDelayMs` exist for tests; the command line sets only `relayOnly`.
 */
export function snippetSource({
  relayOnly = false,
  pollMs = POLL_MS,
  saveDelayMs = SAVE_DELAY_MS,
} = {}) {
  const settings = { format: CAPTURE_FORMAT, relayOnly, pollMs, saveDelayMs };
  return `(${installCapture.toString()})(${JSON.stringify(settings)});\n`;
}

/**
 * Remove what a reader must not print: an invitation fragment, IP addresses,
 * mDNS host names, TURN usernames, and credential-like values.
 */
export function redact(text) {
  return String(text)
    .replace(/accept#\S+/gi, "accept#<redacted>")
    .replace(/#[A-Za-z0-9_-]{40,}/g, "#<redacted>")
    .replace(
      /((?:username|credential|password|pwd|ufrag|fingerprint)\W{1,4})[^,\s}\]"']+/gi,
      "$1<redacted>",
    )
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip4>")
    .replace(
      /\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b|(?:[0-9a-f]{0,4}:){1,7}:(?:[0-9a-f]{1,4}:){0,6}[0-9a-f]{0,4}/gi,
      "<ip6>",
    )
    .replace(/[0-9a-f-]{36}\.local\b/gi, "<mdns>")
    .replace(/\b\d{9,}:[^\s,"'}\]]+/g, "<turn-user>");
}

const seconds = (ms) => `${(ms / 1000).toFixed(2)} s`;

function countBy(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts].map(([value, count]) => `${count} ${value}`).join(", ");
}

function describeCandidate(candidate) {
  if (candidate === null || candidate === undefined) return "unknown";
  const parts = [candidate.candidateType ?? "?", candidate.protocol ?? "?"];
  if (candidate.relayProtocol)
    parts.push(`relayed over ${candidate.relayProtocol}`);
  if (candidate.url) parts.push(`via ${candidate.url}`);
  return parts.join(" ");
}

function timelineLine({ ms, event, ...detail }) {
  if (event === "icecandidateerror") {
    return `${seconds(ms)}  candidate error ${detail.errorCode} at ${detail.url ?? "?"}: ${detail.errorText ?? ""}`;
  }
  const value = detail.state ?? detail.type ?? detail.label ?? "";
  const protocol = detail.protocol ? ` (${detail.protocol})` : "";
  return `${seconds(ms)}  ${event} ${value}${protocol}`.trimEnd();
}

// Every event but repeated candidates of one type and protocol, which only the counts keep.
function timeline(events) {
  const seenKinds = new Set();
  return events
    .filter((entry) => {
      if (entry.event !== "icecandidate") return true;
      const kind = `${entry.type}/${entry.protocol ?? ""}`;
      if (seenKinds.has(kind)) return false;
      seenKinds.add(kind);
      return true;
    })
    .map(timelineLine);
}

/** The summary read-capture prints for a parsed capture file, as lines. */
export function captureSummary(capture) {
  if (capture?.format !== CAPTURE_FORMAT) {
    throw new Error(
      `not a capture file: its format is '${capture?.format ?? "missing"}', not ${CAPTURE_FORMAT}.`,
    );
  }
  const lines = [
    `page ${capture.page}, installed ${capture.installed}, saved ${capture.saved}, ` +
      `${capture.connections.length} connections, relay candidates only: ${capture.relayOnly ? "yes" : "no"}`,
  ];
  for (const record of capture.connections) {
    const ended = record.ended
      ? `ended ${record.ended.reason} after ${seconds(record.ended.ms)}`
      : "had not ended when saved";
    lines.push(
      "",
      `connection ${record.connection}: created ${record.created}, ${ended}, ICE transport policy ${record.iceTransportPolicy}`,
    );
    const servers = record.iceServers.flatMap((server) =>
      [server.urls]
        .flat()
        .map((url) =>
          server.credential === undefined ? url : `${url} (authenticated)`,
        ),
    );
    lines.push(`  servers: ${servers.join("; ") || "none"}`);
    lines.push("  timeline:");
    for (const line of timeline(record.events)) lines.push(`    ${line}`);
    const stats = record.stats;
    if (stats === null) {
      lines.push("  stats: none read before it ended");
      continue;
    }
    const types = (list) =>
      countBy(list.map((candidate) => candidate.candidateType ?? "?")) ||
      "none";
    lines.push(`  local candidates: ${types(stats.localCandidates)}`);
    lines.push(`  remote candidates: ${types(stats.remoteCandidates)}`);
    lines.push(
      `  candidate pairs: ${countBy(stats.candidatePairs.map((pair) => pair.state ?? "?")) || "none"}`,
    );
    const pair = stats.selectedPair;
    if (pair === null) {
      lines.push("  selected pair: none");
    } else {
      const roundTrip =
        typeof pair.currentRoundTripTime === "number"
          ? `, round trip ${Math.round(pair.currentRoundTripTime * 1000)} ms`
          : "";
      lines.push(
        `  selected pair: local ${describeCandidate(stats.selectedLocal)} -> remote ${describeCandidate(stats.selectedRemote)}; ` +
          `state ${pair.state ?? "?"}${roundTrip}, bytes sent ${pair.bytesSent ?? "?"}, received ${pair.bytesReceived ?? "?"}`,
      );
    }
    if (stats.transport?.dtlsState) {
      lines.push(`  DTLS: ${stats.transport.dtlsState}`);
    }
  }
  return lines.map(redact);
}

const ABOUT_WEBRTC_KEEP =
  /PeerConnection ID|iceServers|urls|turns?:|stun:|candidate|relay|srflx|prflx|\bhost\b|error|fail|\b(?:701|401|403)\b|ice.?(?:state|connection)|gathering|selected|nominated|connected|checking|allocat|bogus/i;

const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};

/**
 * The lines of a saved about:webrtc page that concern ICE, candidates and
 * errors: tags stripped, redacted, each distinct line once.
 */
export function aboutWebrtcLines(page) {
  const text = page
    .replace(/<(?:\/p|\/tr|\/div|br|\/h\d|\/li|\/table)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, name) => ENTITIES[name]);
  const seen = new Set();
  const kept = [];
  for (const line of text.split("\n")) {
    if (!ABOUT_WEBRTC_KEEP.test(line)) continue;
    const clean = redact(line).replace(/\s+/g, " ").trim().slice(0, 240);
    if (clean === "" || seen.has(clean)) continue;
    seen.add(clean);
    kept.push(clean);
  }
  return kept;
}

function readFileOrExit(path) {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    process.stderr.write(
      `webrtc-capture: cannot read ${path}: ${error.code ?? error.message}. Pass the downloaded file's path.\n`,
    );
    process.exit(1);
  }
}

function usageError(message) {
  process.stderr.write(
    `webrtc-capture: ${message} Run with --help for usage.\n`,
  );
  process.exit(USAGE_EXIT);
}

function main(argv) {
  const [command, ...rest] = argv;
  if (command === "-h" || command === "--help") {
    process.stdout.write(USAGE);
    return;
  }
  if (command === "snippet") {
    const unknown = rest.filter((argument) => argument !== "--relay-only");
    if (unknown.length > 0) usageError(`unknown argument '${unknown[0]}'.`);
    process.stdout.write(
      snippetSource({ relayOnly: rest.includes("--relay-only") }),
    );
    return;
  }
  if (command === "read-capture" || command === "read-about-webrtc") {
    if (rest.length !== 1) usageError(`${command} takes one file.`);
    const text = readFileOrExit(rest[0]);
    let lines;
    if (command === "read-capture") {
      try {
        lines = captureSummary(JSON.parse(text));
      } catch (error) {
        process.stderr.write(`webrtc-capture: ${rest[0]}: ${error.message}\n`);
        process.exit(1);
      }
    } else {
      const all = aboutWebrtcLines(text);
      lines = [
        `${all.length} matching lines${all.length > ABOUT_WEBRTC_LINE_LIMIT ? `; the first ${ABOUT_WEBRTC_LINE_LIMIT}` : ""}, redacted:`,
        ...all.slice(0, ABOUT_WEBRTC_LINE_LIMIT),
      ];
    }
    process.stdout.write(`${lines.join("\n")}\n`);
    return;
  }
  usageError(
    command === undefined ? "name a command." : `unknown command '${command}'.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
