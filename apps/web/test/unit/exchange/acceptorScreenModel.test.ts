import { describe, expect, test } from "vitest";

import { setColumnDisclosure } from "@psi/metadataEditing";

import {
  ACCEPTOR_SCREEN_INITIAL,
  acceptOffersAllowedRelays,
  acceptorSampleInUse,
  acceptorScreenReducer,
} from "@exchange/acceptorScreenModel";
import {
  acceptorColumnsEditorState,
  acceptorDisclosedColumns,
  acceptorLaunchPayload,
} from "@exchange/acceptorColumnsModel";
import { acceptorServerJobConfig } from "@exchange/useAcceptorExchange";
import { restorablePosition } from "@exchange/stepRestore";
import { samplePartnerFile } from "@exchange/sampleData";

import type {
  AcceptorScreenAction,
  AcceptorScreenState,
} from "@exchange/acceptorScreenModel";
import type { LinkageTerms, RelayLocator } from "@alcove/core";
import type { AcceptableInvitation } from "@psi/acceptInvitation";
import type { AcceptorAcquiredCsv } from "@exchange/acceptorColumnsModel";
import type { AlertContent } from "@components/csvIntake";
import type { ProfiledJobInput } from "@psi/jobClient/workInputClient";

// Headers chosen from inferMetadata's exact-match alias table, as the acceptor
// columns model's own fixture is: three linkage types and one unrecognized
// column, which the seed lists as not sent.
const csv: AcceptorAcquiredCsv = {
  fileName: "members.csv",
  sizeBytes: 2048,
  columns: ["first_name", "last_name", "dob", "program_code"],
  rawRows: [
    {
      first_name: "Ann",
      last_name: "Lee",
      dob: "01/02/1990",
      program_code: "A",
    },
  ],
  rowCount: 1,
};

const PROFILE: ProfiledJobInput = {
  name: csv.fileName,
  sizeBytes: csv.sizeBytes,
  modifiedAt: 1_700_000_000_000,
  rowCount: csv.rowCount,
  columns: csv.columns,
  sanitizedColumnPositions: [],
  columnSamples: new Map(),
  dateInputFormats: new Map(),
};

/** The partner's terms, asking for the two name keys the fixture's file
 * supports. Only the columns model reads them, to derive the standardization the
 * disclosure tests edit. */
const linkageTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "Dana Okafor",
  date: "2026-01-15",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "first_name", type: "first_name" },
    { name: "last_name", type: "last_name" },
  ],
  linkageKeys: [
    {
      name: "first name + last name",
      elements: [{ field: "first_name" }, { field: "last_name" }],
    },
  ],
  payload: { send: [{ name: "program_code" }], receive: [] },
};

/** A decoded invitation over those terms. No secret-shaped value: the reducer
 * holds the decode's result without reading into it. */
const invitation: AcceptableInvitation = {
  token: {
    version: "1",
    linkageTerms,
    sharedSecret: "not-a-real-secret",
    expires: "2026-07-08T19:32:00.000Z",
    connectionEndpoint: {
      channel: "webrtc",
      host: "127.0.0.1",
      port: 3000,
      path: "/api/",
    },
  },
  endpoint: { channel: "webrtc", host: "127.0.0.1", port: 3000, path: "/api/" },
};

const ALERT: AlertContent = { title: "Refused", message: "Pick another file." };

/** The state the consent gate has admitted a browser-parsed file into: the
 * committed name and cardinality, the acquired CSV, and the seeded columns --
 * the state every launch transition starts on. */
function accepted(
  ...actions: Array<AcceptorScreenAction>
): AcceptorScreenState {
  const start = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
    type: "file-accepted",
    name: "Sam Rivera",
    deduplicate: false,
    csvDelimiter: undefined,
    positions: [],
    file: new File(["first_name\nAnn\n"], csv.fileName, { type: "text/csv" }),
    acquired: csv,
  });
  return actions.reduce(acceptorScreenReducer, start);
}

/** What the acceptor's current column edits would send to the partner: the same
 * derivation the columns step's verdict and the launch payload both read. */
function disclosedBy(state: AcceptorScreenState): Array<string> {
  if (state.columnsState === undefined || state.acquired === undefined)
    throw new Error("the fixture acquired no file");
  return acceptorDisclosedColumns(
    acceptorColumnsEditorState(
      state.columnsState,
      linkageTerms,
      state.acquired.rawRows,
    ).metadata,
  );
}

describe("the step the work column shows", () => {
  test("a step move records the sub-section it lands on", () => {
    const state = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "step-shown",
      step: "columns",
      columnsSection: "cleaning",
    });
    expect(state.step).toBe("columns");
    expect(state.columnsSection).toBe("cleaning");
  });

  test("leaving the columns step returns the sub-section to the confirm surface", () => {
    const cleaning = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "step-shown",
      step: "columns",
      columnsSection: "cleaning",
    });
    const state = acceptorScreenReducer(cleaning, {
      type: "step-shown",
      step: "consent",
      columnsSection: "columns",
    });
    expect(state.step).toBe("consent");
    expect(state.columnsSection).toBe("columns");
  });
});

describe("the invitation the console reviews", () => {
  test("a refused decode names what the operator can do", () => {
    const state = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "decode-refused",
      refusal: { kind: "noToken" },
    });
    expect(state.decode).toEqual({
      status: "error",
      refusal: { kind: "noToken" },
    });
  });

  test("the rendezvous mount arrives with the terms it decides runnability for", () => {
    const state = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "invitation-decoded",
      invitation,
      rendezvous: { configured: true, folderName: "alcove" },
    });
    expect(state.decode.status).toBe("ready");
    expect(state.rendezvous?.configured).toBe(true);
  });
});

/** `state` with `program_code` marked to send, through the columns step's own
 * disclosure edit. */
function withProgramCodeSent(state: AcceptorScreenState): AcceptorScreenState {
  if (state.columnsState === undefined)
    throw new Error("the fixture acquired no file");
  return acceptorScreenReducer(state, {
    type: "metadata-changed",
    metadata: setColumnDisclosure(
      state.columnsState.metadata,
      "program_code",
      "payload",
    ).metadata,
  });
}

describe("what the acceptor discloses", () => {
  test("a settled read seeds an unrecognized column as listed but not sent", () => {
    const state = accepted();
    expect(state.acquired).toBe(csv);
    expect(state.committedName).toBe("Sam Rivera");
    expect(
      state.columnsState?.metadata.find(
        (column) => column.name === "program_code",
      )?.role,
    ).toBe("ignored");
    expect(disclosedBy(state)).not.toContain("program_code");
  });

  test("the seed sends no column, the id column included, whatever the decoded invitation's algorithm", () => {
    const withId: AcceptorAcquiredCsv = {
      ...csv,
      columns: ["id", ...csv.columns],
      rawRows: csv.rawRows.map((row) => ({ id: "1", ...row })),
    };
    const seededUnder = (algorithm: LinkageTerms["algorithm"]) => {
      const decoded = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
        type: "invitation-decoded",
        invitation: {
          ...invitation,
          token: {
            ...invitation.token,
            linkageTerms: { ...linkageTerms, algorithm },
          },
        },
        rendezvous: { configured: false },
      });
      const read = acceptorScreenReducer(decoded, {
        type: "file-accepted",
        name: "Sam Rivera",
        deduplicate: false,
        csvDelimiter: undefined,
        positions: [],
        file: new File(["id\n1\n"], withId.fileName, { type: "text/csv" }),
        acquired: withId,
      });
      const reset = acceptorScreenReducer(read, { type: "columns-reset" });
      return [read, reset].map((state) =>
        acceptorDisclosedColumns(state.columnsState?.metadata ?? []),
      );
    };
    expect(seededUnder("psi")).toEqual([[], []]);
    expect(seededUnder("psi-c")).toEqual([[], []]);
  });

  test("a disclosure edit is written to the metadata the launch reads", () => {
    const state = withProgramCodeSent(accepted());
    expect(disclosedBy(state)).toContain("program_code");
  });

  test("a remap re-roles the column for matching rather than sending it", () => {
    const seeded = withProgramCodeSent(accepted());
    const state = acceptorScreenReducer(seeded, {
      type: "column-remapped",
      semanticType: "last_name",
      column: "program_code",
    });
    expect(disclosedBy(state)).not.toContain("program_code");
  });

  test("an input rebind moves the field's source column", () => {
    const state = accepted({
      type: "field-input-changed",
      output: "first_name",
      column: "last_name",
    });
    expect(state.columnsState?.inputOverrides.get("first_name")).toBe(
      "last_name",
    );
  });

  test("an authored cleaning edit records the column it was authored against", () => {
    const state = accepted({
      type: "field-steps-changed",
      output: "first_name",
      input: "first_name",
      steps: [],
    });
    expect(state.columnsState?.stepOverrides.get("first_name")).toEqual({
      input: "first_name",
      steps: [],
    });
  });

  test("a cleaning settings edit records the field's settings whole", () => {
    const settings = {
      maxPeoplePerValue: 2,
      nullIfLastName: { values: ["MARY"], lastNames: ["ROE"] },
    };
    const state = accepted({
      type: "field-cleaning-settings-changed",
      output: "first_name",
      settings,
    });
    expect(state.columnsState?.settingsOverrides.get("first_name")).toEqual(
      settings,
    );
    const cleared = acceptorScreenReducer(state, {
      type: "field-cleaning-settings-changed",
      output: "first_name",
      settings: {},
    });
    expect(cleared.columnsState?.settingsOverrides.get("first_name")).toEqual(
      {},
    );
  });

  test("a reset drops every override back to the seed", () => {
    const rebound = acceptorScreenReducer(withProgramCodeSent(accepted()), {
      type: "field-input-changed",
      output: "first_name",
      column: "dob",
    });
    const edited = acceptorScreenReducer(rebound, {
      type: "field-cleaning-settings-changed",
      output: "first_name",
      settings: { maxPeoplePerValue: 2 },
    });
    expect(disclosedBy(edited)).toContain("program_code");
    const state = acceptorScreenReducer(edited, { type: "columns-reset" });
    expect(state.columnsState?.inputOverrides.size).toBe(0);
    expect(state.columnsState?.settingsOverrides.size).toBe(0);
    expect(disclosedBy(state)).not.toContain("program_code");
  });

  test("an edit before any file moves nothing", () => {
    const state = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "column-remapped",
      semanticType: "last_name",
      column: "program_code",
    });
    expect(state).toBe(ACCEPTOR_SCREEN_INITIAL);
  });
});

describe("whether the launch may proceed", () => {
  test("a submit past the disabled gate names the fields it failed on", () => {
    const state = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "consent-refused",
      errors: { name: "Enter your name or agency.", file: true },
    });
    expect(state.fieldErrors).toEqual({
      name: "Enter your name or agency.",
      file: true,
    });
    expect(state.acquired).toBeUndefined();
  });

  test("typing a name clears the refusal the last submit left on it", () => {
    const refused = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "consent-refused",
      errors: { name: "Enter your name or agency." },
    });
    const state = acceptorScreenReducer(refused, {
      type: "name-changed",
      name: "Sam Rivera",
    });
    expect(state.acceptorName).toBe("Sam Rivera");
    expect(state.fieldErrors.name).toBeUndefined();
  });

  test("a parse in flight clears the refusal the last read left", () => {
    const refused = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "parse-failed",
      alert: ALERT,
    });
    expect(refused.parseAlert).toBe(ALERT);
    const parsing = acceptorScreenReducer(refused, { type: "parse-started" });
    expect(parsing.parsing).toBe(true);
    expect(parsing.parseAlert).toBeUndefined();
    expect(
      acceptorScreenReducer(parsing, { type: "parse-finished" }).parsing,
    ).toBe(false);
  });

  test("a read leaving a column unnamed acquires nothing", () => {
    const state = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "unnameable-columns-refused",
      positions: [2],
      alert: ALERT,
    });
    expect(state.acquired).toBeUndefined();
    expect(state.columnsState).toBeUndefined();
    expect(state.parseAlert).toBe(ALERT);
    expect(state.sanitizedColumnPositions).toEqual([2]);
  });

  test("a failed parse keeps every input so the operator can retry", () => {
    const chosen = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "file-selected",
      file: new File(["x\n"], csv.fileName, { type: "text/csv" }),
    });
    const consented = acceptorScreenReducer(chosen, {
      type: "consent-chosen",
      consented: true,
    });
    const state = acceptorScreenReducer(consented, {
      type: "parse-failed",
      alert: ALERT,
    });
    expect(state.file).toBe(chosen.file);
    expect(state.consented).toBe(true);
  });

  test("a fresh file drops the prior read's refusal and stripped positions", () => {
    const refused = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "unnameable-columns-refused",
      positions: [2],
      alert: ALERT,
    });
    const state = acceptorScreenReducer(refused, {
      type: "file-selected",
      file: new File(["x\n"], "other.csv", { type: "text/csv" }),
    });
    expect(state.parseAlert).toBeUndefined();
    expect(state.sanitizedColumnPositions).toEqual([]);
    expect(state.fieldErrors.file).toBe(false);
  });

  test("the gate commits this party's cardinality beside the name", () => {
    const state = accepted();
    expect(state.committedDeduplicate).toBe(false);
    const moved = acceptorScreenReducer(state, {
      type: "deduplicate-chosen",
      deduplicate: true,
    });
    expect(moved.acceptorDeduplicate).toBe(true);
    expect(moved.committedDeduplicate).toBe(false);
  });

  test("the parse commits the cardinality the action states, not the live control", () => {
    const movedBeforeParse = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "deduplicate-chosen",
      deduplicate: true,
    });
    const settledFalse = acceptorScreenReducer(movedBeforeParse, {
      type: "file-accepted",
      name: "Sam Rivera",
      deduplicate: false,
      csvDelimiter: undefined,
      positions: [],
      file: new File(["first_name\nAnn\n"], csv.fileName, {
        type: "text/csv",
      }),
      acquired: csv,
    });
    expect(settledFalse.acceptorDeduplicate).toBe(true);
    expect(settledFalse.committedDeduplicate).toBe(false);

    const settledTrue = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "file-accepted",
      name: "Sam Rivera",
      deduplicate: true,
      csvDelimiter: undefined,
      positions: [],
      file: new File(["first_name\nAnn\n"], csv.fileName, {
        type: "text/csv",
      }),
      acquired: csv,
    });
    expect(settledTrue.acceptorDeduplicate).toBe(false);
    expect(settledTrue.committedDeduplicate).toBe(true);
  });

  test("the gate commits the delimiter the file was read by", () => {
    expect(ACCEPTOR_SCREEN_INITIAL.committedCsvDelimiter).toBeUndefined();
    const hostedCommit = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "file-accepted",
      name: "Sam Rivera",
      deduplicate: false,
      csvDelimiter: ";",
      positions: [],
      file: new File(["first_name\nAnn\n"], csv.fileName, {
        type: "text/csv",
      }),
      acquired: csv,
    });
    expect(hostedCommit.committedCsvDelimiter).toBe(";");

    const consoleCommit = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "console-accept-committed",
      name: "Sam Rivera",
      csvDelimiter: "\t",
      acquired: csv,
    });
    expect(consoleCommit.committedCsvDelimiter).toBe("\t");
  });

  test("a launch presents the cardinality the gate committed, not the control", () => {
    const moved = accepted(
      { type: "deduplicate-chosen", deduplicate: true },
      { type: "manage-offer-failed", refusal: ALERT },
    );
    if (moved.columnsState === undefined || moved.acquired === undefined)
      throw new Error("the fixture acquired no file");
    const state = acceptorScreenReducer(moved, {
      type: "exchange-launched",
      ...acceptorLaunchPayload(
        acceptorColumnsEditorState(
          moved.columnsState,
          linkageTerms,
          moved.acquired.rawRows,
        ),
      ),
    });
    expect(state.launched?.deduplicate).toBe(false);
    expect(state.manageOffer.status).toBe("idle");
  });

  test("a gate re-passed under the moved control commits the new value", () => {
    const state = accepted(
      { type: "deduplicate-chosen", deduplicate: true },
      {
        type: "console-accept-committed",
        name: "Sam Rivera",
        csvDelimiter: undefined,
        acquired: csv,
      },
    );
    expect(state.committedDeduplicate).toBe(true);
    expect(state.fieldErrors).toEqual({});
  });

  test("discarding the launch clears the run and the offer", () => {
    const launched = accepted({
      type: "exchange-launched",
      edits: { metadata: [], standardization: [] },
    });
    const state = acceptorScreenReducer(launched, {
      type: "launch-discarded",
    });
    expect(state.launched).toBeUndefined();
    expect(state.manageOffer.status).toBe("idle");
    expect(state.acquired).toBe(csv);
  });

  test("an accepted SFTP endpoint starts unauthored", () => {
    const state = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "accept-sftp-endpoint-resolved",
    });
    expect(state.sftpInfo).toEqual({ connection: null });
  });

  test("an authored connection re-asks the sweep confirmation", () => {
    const confirmed = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "run-diagnostics-chosen",
      draft: {
        ...ACCEPTOR_SCREEN_INITIAL.runDiagnostics,
        sweepConfirmed: true,
      },
    });
    const state = acceptorScreenReducer(confirmed, {
      type: "sftp-connection-authored",
      connection: { host: "sftp.example.test", path: "/exchange" },
    });
    expect(state.sftpInfo?.connection).toEqual({
      host: "sftp.example.test",
      path: "/exchange",
    });
    expect(state.runDiagnostics.sweepConfirmed).toBe(false);
  });

  test("clearing the connection re-blocks the launch", () => {
    const authored = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "sftp-connection-authored",
      connection: { host: "sftp.example.test", path: "/exchange" },
    });
    const state = acceptorScreenReducer(authored, {
      type: "sftp-connection-cleared",
    });
    expect(state.sftpInfo).toEqual({ connection: null });
  });
});

describe("the console's mounted-file commit", () => {
  test("a re-profile of the same columns keeps the operator's edits", () => {
    const committed = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "console-file-committed",
      source: PROFILE,
    });
    const edited = acceptorScreenReducer(committed, {
      type: "column-remapped",
      semanticType: "last_name",
      column: "program_code",
    });
    const state = acceptorScreenReducer(edited, {
      type: "console-file-committed",
      source: { ...PROFILE, modifiedAt: PROFILE.modifiedAt + 1000 },
    });
    expect(state.columnsState).toBe(edited.columnsState);
  });

  test("a re-profile with different columns reseeds them", () => {
    const committed = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "console-file-committed",
      source: PROFILE,
    });
    const state = acceptorScreenReducer(committed, {
      type: "console-file-committed",
      source: { ...PROFILE, columns: ["first_name", "last_name"] },
    });
    expect(state.columnsState).not.toBe(committed.columnsState);
    expect(state.columnsState?.metadata.map((column) => column.name)).toEqual([
      "first_name",
      "last_name",
    ]);
  });

  test("a delimiter change voids the commit and the columns it seeded", () => {
    const committed = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "console-file-committed",
      source: PROFILE,
    });
    const gatePassed = acceptorScreenReducer(committed, {
      type: "console-accept-committed",
      name: "Ida Mensah",
      csvDelimiter: undefined,
      acquired: csv,
    });
    const voided = acceptorScreenReducer(gatePassed, {
      type: "console-file-voided",
    });
    // "Accept and continue" reads `consoleSource`, so it refuses again until the
    // operator confirms the file the new delimiter reads.
    expect(voided.consoleSource).toBeUndefined();
    expect(voided.columnsState).toBeUndefined();
    expect(voided.acquired).toBeUndefined();
    expect(voided.sanitizedColumnPositions).toEqual([]);
  });

  test("a commit clears the refusal the last one left", () => {
    const refused = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "unnameable-columns-refused",
      positions: [3],
      alert: ALERT,
    });
    const state = acceptorScreenReducer(refused, {
      type: "console-file-committed",
      source: { ...PROFILE, sanitizedColumnPositions: [1] },
    });
    expect(state.parseAlert).toBeUndefined();
    expect(state.sanitizedColumnPositions).toEqual([1]);
    expect(state.fieldErrors.file).toBe(false);
  });
});

describe("the review step's allowed relays", () => {
  const typed = (value: string, state = ACCEPTOR_SCREEN_INITIAL) =>
    acceptorScreenReducer(state, { type: "allowed-relays-changed", value });
  const continued = (state: AcceptorScreenState) =>
    acceptorScreenReducer(state, { type: "review-continued" });
  const launch = (state: AcceptorScreenState) =>
    acceptorScreenReducer(state, {
      type: "exchange-launched",
      edits: { metadata: [], standardization: [] },
    });

  test("start empty and uncommitted for every invitation", () => {
    expect(ACCEPTOR_SCREEN_INITIAL.acceptorAllowedRelays).toBe("");
    expect(ACCEPTOR_SCREEN_INITIAL.committedAllowedRelays).toBeUndefined();
    expect(ACCEPTOR_SCREEN_INITIAL.allowedRelaysChangedAtStart).toBe(false);
  });

  test("are offered on the console where the invitation names a WebSocket relay, alone or beside a TURN server", () => {
    const websocket = "wss://ws.relay.example.org/relay";
    const relays: Array<RelayLocator> = [
      { websocket },
      { turn: ["turn:relay.example.org"], websocket },
      { stun: ["stun:stun.example.org"], websocket },
    ];
    for (const relay of relays)
      expect(
        acceptOffersAllowedRelays(
          { channel: "webrtc", host: "127.0.0.1", relay },
          true,
          false,
          () => false,
        ),
      ).toBe(true);
  });

  test("are offered on a WebRTC accept where the run lists a relay: in the browser as the browser's run reads, on the console only where the invitation names a TURN server or WebSocket relay", () => {
    const relayed = {
      ...invitation.endpoint,
      relay: { turn: ["turn:relay.example.org"] },
    };
    const listsRelay = () => true;
    const listsNone = () => false;
    expect(
      acceptOffersAllowedRelays(invitation.endpoint, false, false, listsRelay),
    ).toBe(true);
    expect(
      acceptOffersAllowedRelays(invitation.endpoint, false, false, listsNone),
    ).toBe(false);
    expect(
      acceptOffersAllowedRelays(invitation.endpoint, true, false, listsRelay),
    ).toBe(false);
    expect(acceptOffersAllowedRelays(relayed, true, false, listsNone)).toBe(
      true,
    );
    expect(
      acceptOffersAllowedRelays(
        {
          channel: "webrtc",
          host: "127.0.0.1",
          relay: { stun: ["stun:stun.example.org"] },
        },
        true,
        false,
        listsRelay,
      ),
    ).toBe(false);
    expect(
      acceptOffersAllowedRelays(
        { channel: "filedrop", path: "/drop" },
        false,
        true,
        listsRelay,
      ),
    ).toBe(false);
  });

  test("the browser's run is asked about the invitation's relay", () => {
    const relay = { turn: ["turn:relay.example.org"] };
    const relayed = { ...invitation.endpoint, relay };
    const asked: Array<unknown> = [];
    acceptOffersAllowedRelays(relayed, false, false, (invitationRelay) => {
      asked.push(invitationRelay);
      return false;
    });
    expect(asked).toEqual([relay]);
  });

  test("count as edited from the first change, an emptying one included, and start unedited", () => {
    expect(ACCEPTOR_SCREEN_INITIAL.allowedRelaysEdited).toBe(false);
    const listed = typed("relay.example.org");
    expect(listed.allowedRelaysEdited).toBe(true);
    const emptied = typed("", listed);
    expect(emptied.acceptorAllowedRelays).toBe("");
    expect(emptied.allowedRelaysEdited).toBe(true);
  });

  test("are never hidden while they hold a list or once edited", () => {
    expect(
      acceptOffersAllowedRelays(invitation.endpoint, false, true, () => false),
    ).toBe(true);
    expect(
      acceptOffersAllowedRelays(invitation.endpoint, true, true, () => false),
    ).toBe(true);
  });

  test("typing commits nothing; Continue commits the entries, normalized", () => {
    const state = typed("Relay.Example.org.\n\nbackup.example.org:443\n");
    expect(state.committedAllowedRelays).toBeUndefined();
    expect(continued(state).committedAllowedRelays).toEqual({
      allowedRelays: ["relay.example.org", "backup.example.org:443"],
    });
  });

  test("Continue over an empty field commits no list", () => {
    expect(continued(ACCEPTOR_SCREEN_INITIAL).committedAllowedRelays).toEqual(
      {},
    );
  });

  test("Continue over a refused line changes nothing", () => {
    const state = typed("relay.example.org\nturn:relay.example.org");
    expect(continued(state)).toBe(state);
  });

  test("a Start held for an edit after Continue says so until the next commit", () => {
    const committed = continued(typed("relay.example.org"));
    const edited = typed("other.example.org", committed);
    const held = acceptorScreenReducer(edited, {
      type: "start-held-for-allowed-relays",
    });
    expect(held.allowedRelaysChangedAtStart).toBe(true);
    const refused = typed("turn:other.example.org", held);
    expect(continued(refused).allowedRelaysChangedAtStart).toBe(true);
    const recommitted = continued(typed("other.example.org", refused));
    expect(recommitted.allowedRelaysChangedAtStart).toBe(false);
    expect(recommitted.committedAllowedRelays).toEqual({
      allowedRelays: ["other.example.org"],
    });
  });

  test("an edit after Continue voids the commit until the next one", () => {
    const committed = continued(typed("relay.example.org"));
    const edited = typed("other.example.org", committed);
    expect(edited.committedAllowedRelays).toBeUndefined();
    expect(continued(edited).committedAllowedRelays).toEqual({
      allowedRelays: ["other.example.org"],
    });
  });

  test("a launch takes the committed list, and none where the field was empty", () => {
    const committedList = accepted(
      { type: "allowed-relays-changed", value: "relay.example.org" },
      { type: "review-continued" },
    );
    expect(launch(committedList).launched?.allowedRelays).toEqual([
      "relay.example.org",
    ]);
    const committedEmpty = accepted({ type: "review-continued" });
    expect(launch(committedEmpty).launched?.allowedRelays).toBeUndefined();
  });
});

describe("the managed-exchange offer", () => {
  test("a failed deposit holds the refusal beside the error", () => {
    const depositing = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "manage-offer-started",
    });
    expect(depositing.manageOffer.status).toBe("depositing");
    const state = acceptorScreenReducer(depositing, {
      type: "manage-offer-failed",
      refusal: ALERT,
    });
    expect(state.manageOffer).toEqual({ status: "error", refusal: ALERT });
  });

  test("a failure no column explains leaves the generic copy standing", () => {
    const state = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "manage-offer-failed",
    });
    expect(state.manageOffer).toEqual({ status: "error" });
  });

  test("a deposit that arrives is reported", () => {
    const state = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "manage-offer-deposited",
    });
    expect(state.manageOffer).toEqual({ status: "deposited" });
  });
});

describe("the sample partner file", () => {
  const sampleFile = samplePartnerFile();
  const realFile = new File(["first_name\nAnn\n"], "mine.csv", {
    type: "text/csv",
  });

  function acceptedWith(
    state: AcceptorScreenState,
    file: File,
  ): AcceptorScreenState {
    return acceptorScreenReducer(state, {
      type: "file-accepted",
      name: "Sam Rivera",
      deduplicate: false,
      csvDelimiter: undefined,
      positions: [],
      file,
      acquired: csv,
    });
  }

  test("is offered only where the decode says this browser created the invitation from it", () => {
    const decoded = (sampleOffered?: boolean) =>
      acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
        type: "invitation-decoded",
        invitation,
        rendezvous: { configured: false },
        ...(sampleOffered !== undefined ? { sampleOffered } : {}),
      });
    expect(decoded(true).sampleOffered).toBe(true);
    expect(decoded(false).sampleOffered).toBe(false);
    expect(decoded().sampleOffered).toBe(false);
  });

  test("chosen, it is the chosen file the consent gate admits", () => {
    const refused = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "consent-refused",
      errors: { file: true },
    });
    const state = acceptorScreenReducer(refused, {
      type: "file-selected",
      file: sampleFile,
      sample: true,
    });
    expect(state.file).toBe(sampleFile);
    expect(state.chosenSample).toBe(true);
    expect(state.fieldErrors.file).toBe(false);
    expect(acceptorSampleInUse(state)).toBe(true);

    const admitted = acceptedWith(state, sampleFile);
    expect(admitted.acceptedFile).toBe(sampleFile);
    expect(admitted.acceptedSample).toBe(true);
    expect(admitted.columnsState).toBeDefined();
  });

  test("a real file chosen in its place clears the sample state", () => {
    const sample = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "file-selected",
      file: sampleFile,
      sample: true,
    });
    const state = acceptorScreenReducer(sample, {
      type: "file-selected",
      file: realFile,
    });
    expect(state.file).toBe(realFile);
    expect(state.chosenSample).toBe(false);
    expect(acceptorSampleInUse(state)).toBe(false);
    expect(acceptedWith(state, realFile).acceptedSample).toBe(false);
  });

  function backToConsent(state: AcceptorScreenState): AcceptorScreenState {
    return acceptorScreenReducer(state, {
      type: "step-shown",
      step: "consent",
      columnsSection: "columns",
    });
  }

  function columnsRestorable(state: AcceptorScreenState): boolean {
    return (
      restorablePosition("columns", {
        hasLaunch: state.launched !== undefined,
        reviewCommitted: true,
        hasAcquired: state.acquired !== undefined,
      }) === "columns"
    );
  }

  const realCsv: AcceptorAcquiredCsv = {
    fileName: "mine.csv",
    sizeBytes: 16,
    columns: ["first_name"],
    rawRows: [{ first_name: "Ann" }],
    rowCount: 1,
  };

  test("a real file dropped after going back from the admitted sample clears the sample rows", () => {
    const sample = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "file-selected",
      file: sampleFile,
      sample: true,
    });
    const back = backToConsent(acceptedWith(sample, sampleFile));
    expect(acceptorSampleInUse(back)).toBe(true);
    expect(columnsRestorable(back)).toBe(true);

    const swapped = acceptorScreenReducer(back, {
      type: "file-selected",
      file: realFile,
    });
    expect(swapped.acquired).toBeUndefined();
    expect(swapped.columnsState).toBeUndefined();
    expect(swapped.acceptedFile).toBeUndefined();
    expect(swapped.acceptedSample).toBe(false);
    expect(columnsRestorable(swapped)).toBe(false);
    expect(acceptorSampleInUse(swapped)).toBe(false);

    const realAdmitted = acceptorScreenReducer(swapped, {
      type: "file-accepted",
      name: "Sam Rivera",
      deduplicate: false,
      csvDelimiter: undefined,
      positions: [],
      file: realFile,
      acquired: realCsv,
    });
    expect(realAdmitted.acquired).toBe(realCsv);
    expect(realAdmitted.acceptedFile).toBe(realFile);
    expect(acceptorSampleInUse(realAdmitted)).toBe(false);
  });

  test("the sample chosen after going back from an admitted real file clears the real rows", () => {
    const real = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "file-selected",
      file: realFile,
    });
    const back = backToConsent(acceptedWith(real, realFile));
    expect(acceptorSampleInUse(back)).toBe(false);

    const swapped = acceptorScreenReducer(back, {
      type: "file-selected",
      file: sampleFile,
      sample: true,
    });
    expect(swapped.acquired).toBeUndefined();
    expect(swapped.columnsState).toBeUndefined();
    expect(columnsRestorable(swapped)).toBe(false);
    expect(acceptorSampleInUse(swapped)).toBe(true);

    const sampleAdmitted = acceptedWith(swapped, sampleFile);
    expect(sampleAdmitted.acceptedSample).toBe(true);
    expect(acceptorSampleInUse(sampleAdmitted)).toBe(true);
  });

  test("admitted rows, not the chosen file, decide whether the sample is in use", () => {
    const realAdmitted = acceptedWith(
      acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
        type: "file-selected",
        file: realFile,
      }),
      realFile,
    );
    expect(acceptorSampleInUse({ ...realAdmitted, chosenSample: true })).toBe(
      false,
    );
  });

  test("a launched run keeps its rows when another file is chosen", () => {
    const sample = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "file-selected",
      file: sampleFile,
      sample: true,
    });
    const launched = acceptorScreenReducer(acceptedWith(sample, sampleFile), {
      type: "exchange-launched",
      edits: { metadata: [], standardization: [] },
    });
    const swapped = acceptorScreenReducer(backToConsent(launched), {
      type: "file-selected",
      file: realFile,
    });
    expect(swapped.acquired).toBe(launched.acquired);
    expect(acceptorSampleInUse(swapped)).toBe(true);
  });

  test("Clear returns the step to no file chosen", () => {
    const sample = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "file-selected",
      file: sampleFile,
      sample: true,
    });
    const state = acceptorScreenReducer(sample, { type: "sample-cleared" });
    expect(state.file).toBeUndefined();
    expect(state.chosenSample).toBe(false);
    expect(acceptorSampleInUse(state)).toBe(false);
  });

  test("a launched run is a sample run only where the sample rows were admitted", () => {
    const sample = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "file-selected",
      file: sampleFile,
      sample: true,
    });
    const launched = (state: AcceptorScreenState) =>
      acceptorScreenReducer(state, {
        type: "exchange-launched",
        edits: { metadata: [], standardization: [] },
      });
    expect(
      acceptorSampleInUse(launched(acceptedWith(sample, sampleFile))),
    ).toBe(true);
    expect(acceptorSampleInUse(launched(accepted()))).toBe(false);
  });
});

describe("what a voided commit can still compose", () => {
  // The mounted file is tab-separated: the comma read the operator started on
  // yields the whole header as one column, the tab read the columns the run sees.
  const COMMA_PROFILE: ProfiledJobInput = {
    ...PROFILE,
    columns: [csv.columns.join("\t")],
  };

  /** The server-job config the console composes from this state and the operator's
   * current delimiter: the mounted-file reference AcceptorScreen derives from
   * `consoleSource`, over the columns the commit seeded. Undefined where the screen
   * derives no launch source, which is what "Accept and continue" refuses on. */
  function serverJobConfigFor(
    state: AcceptorScreenState,
    csvDelimiter: string,
  ) {
    if (state.consoleSource === undefined || state.columnsState === undefined)
      return undefined;
    return acceptorServerJobConfig({
      token: invitation.token,
      acceptorName: "Sam Rivera",
      // No rows: they only infer the date input format, which this sequence does
      // not measure.
      ...acceptorLaunchPayload(
        acceptorColumnsEditorState(state.columnsState, linkageTerms, []),
      ),
      inputSource: { kind: "workFile", name: state.consoleSource.name },
      transport: { channel: "filedrop" },
      deduplicate: state.committedDeduplicate,
      csvDelimiter,
    });
  }

  test("nothing until a fresh commit, and then the columns it was read by", () => {
    const committed = acceptorScreenReducer(ACCEPTOR_SCREEN_INITIAL, {
      type: "console-file-committed",
      source: COMMA_PROFILE,
    });
    const gatePassed = acceptorScreenReducer(committed, {
      type: "console-accept-committed",
      name: "Sam Rivera",
      csvDelimiter: ",",
      acquired: csv,
    });
    const underComma = serverJobConfigFor(gatePassed, ",");
    expect(underComma?.csvDelimiter).toBe(",");
    expect(underComma?.metadata?.map((column) => column.name)).toEqual(
      COMMA_PROFILE.columns,
    );

    const voided = acceptorScreenReducer(gatePassed, {
      type: "console-file-voided",
    });
    // Cancelling the confirm stage the delimiter change opened leaves the void
    // standing, so the columns the comma read seeded reach no config at all.
    expect(serverJobConfigFor(voided, "\t")).toBeUndefined();

    const reconfirmed = acceptorScreenReducer(voided, {
      type: "console-file-committed",
      source: PROFILE,
    });
    const config = serverJobConfigFor(reconfirmed, "\t");
    expect(config?.csvDelimiter).toBe("\t");
    expect(config?.metadata?.map((column) => column.name)).toEqual(csv.columns);
    expect(config?.inputSource).toEqual({
      kind: "workFile",
      name: csv.fileName,
    });
  });
});
