import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "vitest";
import YAML from "yaml";

import { parseExchangeSpec } from "@alcove/core";
import { loopbackTlsCert } from "@alcove/testkit/loopbackTlsCert";
import {
  ALLOW_MISSING_PREREQUISITES_ENV,
  prerequisitesAreRequired,
} from "@alcove/testkit/prerequisiteGate";

import { describeCliRun, startCli } from "../../cliProcess";
import { loadKeyFile } from "../../../src/keyFile";
import { startBrokerProcess } from "../../signaling/brokerProcess";
import { startTlsBrokerFront } from "../../signaling/tlsBrokerFront";

import type { FinishedCli, RunningCli } from "../../cliProcess";
import type { BrokerProcess } from "../../signaling/brokerProcess";
import type { TlsBrokerFront } from "../../signaling/tlsBrokerFront";

/**
 * A webrtc acceptance that writes its configuration and stops, then runs
 * `alcove exchange`. The inviting CLI mints an invitation requesting a column
 * from a `channel: webrtc` configuration, the accepting CLI stops for that
 * request, and later both run `alcove exchange` from what they wrote; or the
 * inviting CLI waits online while the acceptance stops under `--no-run` and
 * its `alcove exchange` meets it. Every step is a real child process, so this
 * shows the invitation's rendezvous and expiry admit an exchange run after
 * the acceptance rather than inside it, and that the configuration the
 * acceptance writes lists the requested column, so one edit sends it. Under
 * `--event-stream`, an acceptance that stops writes nothing to fd 3, on
 * either form, and one that runs ends the stream with one terminal event.
 *
 * The webrtc endpoint dials `wss://`, so the coordination server sits behind
 * the TLS front `oneCommandAcceptance.test.ts` uses, with the same
 * prerequisite gate.
 */
if (loopbackTlsCert === null && prerequisitesAreRequired(process.env))
  throw new Error(
    "no loopback TLS certificate could be minted here, so the no-run " +
      "webrtc acceptance would silently skip in an environment that is " +
      "supposed to supply one. Install `openssl`, or set " +
      `${ALLOW_MISSING_PREREQUISITES_ENV}=1 to skip the leg.`,
  );
const liveTest = test.skipIf(loopbackTlsCert === null);

const BROKER_HOST = "127.0.0.1";

/** Each exchange party's wait for the other, inside the process deadline. */
const PARTY_PEER_TIMEOUT = "60s";
const PARTY_DEADLINE_MS = 90_000;

// One non-matcher on each side, at different positions, so the result shows
// the PSI filtered rather than echoing every record. Intersection: Bob, Carol.
const INVITE_CSV =
  "first_name,last_name,date_of_birth\n" +
  "Bob,Jones,1990-01-02\n" +
  "Carol,Lee,1985-07-16\n" +
  "Dave,Kim,1978-11-30\n";
// `id` is the acceptor's record identifier, which inference sends, and
// `case_manager` the column the inviting party requests, which inference
// leaves out.
const ACCEPT_CSV =
  "id,first_name,last_name,date_of_birth,case_manager\n" +
  "z9,Zoe,Adams,2001-03-03,Ames\n" +
  "b7,Bob,Jones,1990-01-02,Burke\n" +
  "c5,Carol,Lee,1985-07-16,Cruz\n";
const REQUESTED_COLUMN = "case_manager";

let broker: BrokerProcess;
let front: TlsBrokerFront;
let suiteDir: string;
let certPath: string;
let work: string;
const parties: Array<RunningCli> = [];

beforeAll(async () => {
  if (loopbackTlsCert === null) return;
  suiteDir = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-no-run-suite-"));
  certPath = path.join(suiteDir, "broker-front.pem");
  fs.writeFileSync(certPath, loopbackTlsCert.cert);
  broker = await startBrokerProcess();
  front = await startTlsBrokerFront(loopbackTlsCert, broker.port);
}, 90_000);

beforeEach(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), "alcove-no-run-"));
});

afterEach(async () => {
  await Promise.all(parties.splice(0).map((running) => running.stop()));
  try {
    if (work) fs.rmSync(work, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}, 30_000);

afterAll(async () => {
  try {
    await front?.stop();
    await broker?.stop();
  } finally {
    try {
      if (suiteDir) fs.rmSync(suiteDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

/** `eventStream` wires fd 3 and passes `--event-stream`. */
function party(args: string[], eventStream = false): RunningCli {
  const running = startCli({
    args: eventStream ? [...args, "--event-stream"] : args,
    cwd: work,
    env: { NODE_EXTRA_CA_CERTS: certPath },
    timeoutMs: PARTY_DEADLINE_MS,
    eventStream,
  });
  parties.push(running);
  return running;
}

async function runToExit(
  label: string,
  args: string[],
  eventStream = false,
): Promise<FinishedCli> {
  const run = await party(args, eventStream).finished;
  expect(run.exitCode, describeCliRun(label, run)).toBe(0);
  return run;
}

/** The events a run wrote to fd 3, one per line. */
function streamEvents(run: FinishedCli): Array<Record<string, unknown>> {
  return (run.fd3 ?? "")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Rewrite a YAML file through `edit`, as an operator's text editor would. */
function editYaml(file: string, edit: (doc: YAML.Document) => void): void {
  const doc = YAML.parseDocument(fs.readFileSync(file, "utf8"));
  edit(doc);
  fs.writeFileSync(file, doc.toString());
}

/** The single results CSV in `folder`, as its header and its rows. */
function resultTable(folder: string): { header: string; rows: string[] } {
  const found = fs
    .readdirSync(folder)
    .filter(
      (name) => name.startsWith("alcove-results-") && name.endsWith(".csv"),
    );
  expect(found).toHaveLength(1);
  const lines = fs
    .readFileSync(path.join(folder, found[0]), "utf8")
    .trim()
    .split("\n");
  return { header: lines[0], rows: lines.slice(1) };
}

liveTest(
  "an acceptance stopped by a request writes a configuration a later alcove exchange runs once the operator sends the requested column",
  async () => {
    const inviteInput = path.join(work, "invite-input.csv");
    fs.writeFileSync(inviteInput, INVITE_CSV);
    const acceptInput = path.join(work, "accept-input.csv");
    fs.writeFileSync(acceptInput, ACCEPT_CSV);
    const inviteConfig = path.join(work, "invite.yaml");
    const inviteKey = path.join(work, "invite.key");
    const acceptConfig = path.join(work, "accept.yaml");
    const acceptKey = path.join(work, "accept.key");
    const inviteOut = path.join(work, "invite-out");
    const acceptOut = path.join(work, "accept-out");

    // The inviting party's configuration, as the invite guide has it written:
    // `alcove init` from its file, then a webrtc connection block naming the
    // coordination server, and a request for the acceptor's `case_manager` column.
    await runToExit("init", [
      "init",
      "--identity",
      "invite",
      "--config-file",
      inviteConfig,
      inviteInput,
    ]);
    editYaml(inviteConfig, (doc) => {
      doc.set("connection", {
        channel: "webrtc",
        server: { host: BROKER_HOST, port: front.port, path: broker.path },
        role: "inviter",
      });
      doc.setIn(["linkage_terms", "payload"], {
        receive: [{ name: REQUESTED_COLUMN }],
      });
    });

    const invite = await runToExit("invite", [
      "invite",
      "--config-file",
      inviteConfig,
      "--key-file",
      inviteKey,
      "--expires-in",
      "1h",
      inviteInput,
    ]);
    const invitation = invite.stdout.trim();
    expect(invitation).toMatch(/^[A-Za-z0-9_-]+$/);
    // The inviting party holds the pending secret with the invitation's expiry,
    // which is what a later exchange's handshake is checked against.
    expect(loadKeyFile(inviteKey)?.expires).toBeDefined();

    // The acceptance has everything a run needs, but the invitation requests
    // a column inference does not send: it writes a configuration listing it,
    // not sent, and stops, writing nothing to the event stream.
    const accept = await runToExit(
      "the acceptance stopped by the request",
      [
        "accept",
        "--consent-to-terms",
        invitation,
        acceptInput,
        "--config-file",
        acceptConfig,
        "--key-file",
        acceptKey,
        "--identity",
        "accept",
        "--log-level",
        "info",
      ],
      true,
    );
    expect(accept.stderr).not.toContain(
      "coordination server this invitation names",
    );
    expect(accept.stderr).toContain(
      "this acceptance did not run the exchange: your partner's run refuses " +
        "an exchange that does not send the columns it requests from you",
    );
    expect(accept.stderr).toContain(`\n  - ${REQUESTED_COLUMN}\n`);
    expect(accept.fd3).toBe("");

    // The URL form stops the same way, and writes nothing to the stream.
    const share = path.join(work, "share");
    fs.mkdirSync(share);
    const urlAccept = await runToExit(
      "the URL acceptance stopped by the request",
      [
        "accept",
        "--consent-to-terms",
        pathToFileURL(share).href,
        invitation,
        acceptInput,
        "--config-file",
        path.join(work, "accept-url.yaml"),
        "--key-file",
        path.join(work, "accept-url.key"),
        "--identity",
        "accept",
        "--log-level",
        "info",
      ],
      true,
    );
    expect(urlAccept.stderr).toContain(
      "this acceptance did not run the exchange",
    );
    expect(urlAccept.fd3).toBe("");
    expect(fs.existsSync(acceptKey)).toBe(true);
    const written = parseExchangeSpec(
      YAML.parse(fs.readFileSync(acceptConfig, "utf8")),
    );
    expect(written.connection).toMatchObject({
      channel: "webrtc",
      role: "acceptor",
      server: { host: BROKER_HOST, port: front.port, path: broker.path },
    });
    expect(written.metadata).toContainEqual(
      expect.objectContaining({ name: REQUESTED_COLUMN, isPayload: false }),
    );
    expect(written.metadata).toContainEqual(
      expect.objectContaining({ name: "id", isPayload: false }),
    );
    expect(written.standardization).toBeDefined();

    // The operator's edit before the agreed time: the requested column is
    // sent, and the ID column stays not sent, so the send set is exactly what
    // the inviting party requested.
    editYaml(acceptConfig, (doc) => {
      const metadata = doc.get("metadata") as YAML.YAMLSeq<YAML.YAMLMap>;
      for (const entry of metadata.items)
        if (entry.get("name") === REQUESTED_COLUMN)
          entry.set("is_payload", true);
    });

    const [inviteRun, acceptRun] = await Promise.all([
      party([
        "exchange",
        "--config-file",
        inviteConfig,
        "--key-file",
        inviteKey,
        "--peer-timeout",
        PARTY_PEER_TIMEOUT,
        "--no-record",
        inviteInput,
        inviteOut,
      ]).finished,
      party([
        "exchange",
        "--config-file",
        acceptConfig,
        "--key-file",
        acceptKey,
        "--peer-timeout",
        PARTY_PEER_TIMEOUT,
        "--no-record",
        acceptInput,
        acceptOut,
      ]).finished,
    ]);
    expect(
      inviteRun.exitCode,
      describeCliRun("the inviting party's exchange", inviteRun),
    ).toBe(0);
    expect(
      acceptRun.exitCode,
      describeCliRun("the accepting party's exchange", acceptRun),
    ).toBe(0);

    // The inviting party received the requested column for the two matched
    // records, and the accepting party's ID column did not cross.
    const inviteTable = resultTable(inviteOut);
    expect(inviteTable.header.split(",")).toContain(REQUESTED_COLUMN);
    expect(inviteTable.header.split(",")).not.toContain("id");
    expect(inviteTable.rows).toHaveLength(2);
    const sent = inviteTable.rows.map((row) => row.split(",").at(-1));
    expect(new Set(sent)).toEqual(new Set(["Burke", "Cruz"]));
    expect(resultTable(acceptOut).rows).toHaveLength(2);

    // The handshake rotated the secret on both sides alike.
    expect(loadKeyFile(acceptKey)?.sharedSecret).toBe(
      loadKeyFile(inviteKey)?.sharedSecret,
    );
  },
  240_000,
);

liveTest(
  "an online inviter still waiting meets the alcove exchange a stopped acceptance runs",
  async () => {
    const inviteInput = path.join(work, "invite-input.csv");
    fs.writeFileSync(inviteInput, INVITE_CSV);
    const acceptInput = path.join(work, "accept-input.csv");
    fs.writeFileSync(acceptInput, ACCEPT_CSV);
    const inviteConfig = path.join(work, "invite.yaml");
    const inviteKey = path.join(work, "invite.key");
    const acceptConfig = path.join(work, "accept.yaml");
    const acceptKey = path.join(work, "accept.key");
    const inviteOut = path.join(work, "invite-out");
    const acceptOut = path.join(work, "accept-out");

    // The online inviter: it prints the invitation and waits at the
    // rendezvous, saving its configuration only once a partner meets it.
    const inviter = party([
      "invite",
      `wss://${BROKER_HOST}:${front.port}${broker.path}`,
      inviteInput,
      inviteOut,
      "--config-file",
      inviteConfig,
      "--key-file",
      inviteKey,
      "--identity",
      "invite",
      "--accept-timeout",
      "80s",
      "--no-record",
    ]);
    const invitation = await inviter.firstStdoutLine(60_000);

    const stopped = await runToExit(
      "the stopped acceptance",
      [
        "accept",
        "--consent-to-terms",
        "--no-run",
        invitation,
        acceptInput,
        "--config-file",
        acceptConfig,
        "--key-file",
        acceptKey,
        "--identity",
        "accept",
      ],
      true,
    );
    expect(stopped.fd3).toBe("");

    const [inviteRun, acceptRun] = await Promise.all([
      inviter.finished,
      party([
        "exchange",
        "--config-file",
        acceptConfig,
        "--key-file",
        acceptKey,
        "--peer-timeout",
        PARTY_PEER_TIMEOUT,
        "--no-record",
        acceptInput,
        acceptOut,
      ]).finished,
    ]);
    expect(
      inviteRun.exitCode,
      describeCliRun("the online inviter", inviteRun),
    ).toBe(0);
    expect(
      acceptRun.exitCode,
      describeCliRun("the accepting party's exchange", acceptRun),
    ).toBe(0);
    expect(resultTable(inviteOut).rows).toHaveLength(2);
    expect(resultTable(acceptOut).rows).toHaveLength(2);
    expect(fs.existsSync(inviteConfig)).toBe(true);
    expect(loadKeyFile(acceptKey)?.sharedSecret).toBe(
      loadKeyFile(inviteKey)?.sharedSecret,
    );
  },
  240_000,
);

liveTest(
  "an acceptance that runs the exchange ends its event stream with one terminal event",
  async () => {
    const inviteInput = path.join(work, "invite-input.csv");
    fs.writeFileSync(inviteInput, INVITE_CSV);
    const acceptInput = path.join(work, "accept-input.csv");
    fs.writeFileSync(acceptInput, ACCEPT_CSV);
    const inviteOut = path.join(work, "invite-out");
    const acceptOut = path.join(work, "accept-out");

    const inviter = party([
      "invite",
      `wss://${BROKER_HOST}:${front.port}${broker.path}`,
      inviteInput,
      inviteOut,
      "--config-file",
      path.join(work, "invite.yaml"),
      "--key-file",
      path.join(work, "invite.key"),
      "--identity",
      "invite",
      "--accept-timeout",
      "80s",
      "--no-record",
    ]);
    const invitation = await inviter.firstStdoutLine(60_000);

    // Nothing is requested, so the acceptance runs the exchange itself.
    const [inviteRun, acceptRun] = await Promise.all([
      inviter.finished,
      party(
        [
          "accept",
          "--consent-to-terms",
          invitation,
          acceptInput,
          acceptOut,
          "--config-file",
          path.join(work, "accept.yaml"),
          "--key-file",
          path.join(work, "accept.key"),
          "--identity",
          "accept",
          "--no-record",
        ],
        true,
      ).finished,
    ]);
    expect(
      inviteRun.exitCode,
      describeCliRun("the online inviter", inviteRun),
    ).toBe(0);
    expect(
      acceptRun.exitCode,
      describeCliRun("the running acceptance", acceptRun),
    ).toBe(0);
    expect(resultTable(acceptOut).rows).toHaveLength(2);
    const events = streamEvents(acceptRun);
    const terminal = events.filter(
      (event) => event.type === "result" || event.type === "error",
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0].type).toBe("result");
    expect(events.at(-1)).toBe(terminal[0]);
  },
  240_000,
);
