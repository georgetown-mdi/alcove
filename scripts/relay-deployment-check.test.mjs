import { describe, expect, it } from "vitest";

import * as broker from "../packages/peerjs-broker/src/deploymentStatus.ts";
import {
  DEPLOYED_COMMIT_HEADER,
  FAILED_OUTCOMES,
  LAST_PULL_OUTCOME_HEADER,
  LAST_PULL_TIME_HEADER,
  MAX_LAG_HOURS,
  SUCCEEDED_OUTCOMES,
  UNKNOWN,
  deploymentFields,
  fieldFindings,
  lagFinding,
  laggingSince,
  relayHealthUrl,
} from "./relay-deployment-check.mjs";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function fields(overrides = {}) {
  return {
    deployedCommit: COMMIT,
    lastPullOutcome: "updated",
    lastPullTime: "2026-10-13T06:04:17Z",
    ...overrides,
  };
}

describe("the broker's published fields", () => {
  it("names the headers the broker writes", () => {
    expect([
      DEPLOYED_COMMIT_HEADER,
      LAST_PULL_OUTCOME_HEADER,
      LAST_PULL_TIME_HEADER,
      UNKNOWN,
    ]).toEqual([
      broker.DEPLOYED_COMMIT_HEADER,
      broker.LAST_PULL_OUTCOME_HEADER,
      broker.LAST_PULL_TIME_HEADER,
      broker.UNKNOWN,
    ]);
  });

  it("sorts every outcome the broker publishes into succeeded or failed", () => {
    expect([...SUCCEEDED_OUTCOMES, ...FAILED_OUTCOMES].sort()).toEqual(
      [...broker.PULL_OUTCOMES].sort(),
    );
  });
});

describe("relayHealthUrl", () => {
  it.each([
    ["wss://signal.example.org/api/", "https://signal.example.org/api/health"],
    ["wss://signal.example.org/api", "https://signal.example.org/api/health"],
    [
      "wss://signal.example.org:8443/api/",
      "https://signal.example.org:8443/api/health",
    ],
  ])("reaches %s's readiness endpoint at %s", (signaling, health) => {
    expect(relayHealthUrl(signaling)).toBe(health);
  });

  it.each([
    [undefined, /not set/],
    ["  ", /not set/],
    ["signal.example.org", /not a URL/],
    ["ws://signal.example.org/api/", /must be a wss: URL/],
  ])("refuses %j", (signaling, message) => {
    expect(() => relayHealthUrl(signaling)).toThrow(message);
  });
});

describe("fieldFindings", () => {
  it("finds nothing in a current host's fields", () => {
    for (const outcome of SUCCEEDED_OUTCOMES)
      expect(fieldFindings(fields({ lastPullOutcome: outcome }))).toEqual([]);
  });

  it.each(FAILED_OUTCOMES)("reports a last run that ended %s", (outcome) => {
    expect(fieldFindings(fields({ lastPullOutcome: outcome }))).toEqual([
      {
        kind: "failed-pull",
        message: `the host's last pull run, at 2026-10-13T06:04:17Z, ended ${outcome}`,
      },
    ]);
  });

  it("reports each header a broker without the fields lacks", () => {
    const headers = new Headers({ "content-type": "text/plain" });
    const findings = fieldFindings(deploymentFields(headers));
    expect(findings.map((finding) => finding.kind)).toEqual([
      "missing",
      "missing",
      "missing",
    ]);
  });

  it("reports each field the broker could not read", () => {
    const findings = fieldFindings({
      deployedCommit: UNKNOWN,
      lastPullOutcome: UNKNOWN,
      lastPullTime: UNKNOWN,
    });
    expect(findings.map((finding) => finding.kind)).toEqual([
      "unknown",
      "unknown",
      "unknown",
    ]);
  });

  it("reports a commit or an outcome out of shape", () => {
    expect(
      fieldFindings(fields({ deployedCommit: "0123456" })).map((f) => f.kind),
    ).toEqual(["unknown"]);
    expect(
      fieldFindings(fields({ lastPullOutcome: "ok" })).map((f) => f.kind),
    ).toEqual(["unknown"]);
  });
});

describe("laggingSince", () => {
  const activities = [
    { timestamp: "2026-10-12T15:13:58Z", after: "c" },
    { timestamp: "2026-10-07T02:49:56Z", after: "a" },
    { timestamp: "2026-10-07T14:58:08Z", after: "b" },
  ];

  it("is the oldest update of main the deployed commit does not contain", () => {
    expect(laggingSince(activities, (after) => after === "a")).toBe(
      "2026-10-07T14:58:08Z",
    );
  });

  it("is null when the deployed commit contains every update", () => {
    expect(laggingSince(activities, () => true)).toBeNull();
  });
});

describe("lagFinding", () => {
  const since = "2026-10-11T07:00:00Z";

  it("admits a lag up to the limit", () => {
    const now = new Date(Date.parse(since) + MAX_LAG_HOURS * 3_600_000);
    expect(lagFinding(since, now)).toBeNull();
    expect(lagFinding(null, now)).toBeNull();
  });

  it("reports a lag past the limit", () => {
    const now = new Date(Date.parse(since) + (MAX_LAG_HOURS + 1) * 3_600_000);
    expect(lagFinding(since, now)).toEqual({
      kind: "lag",
      message: `main has held commits the host has not deployed since ${since}, ${MAX_LAG_HOURS + 1} hours, past the ${MAX_LAG_HOURS}-hour limit`,
    });
  });
});
