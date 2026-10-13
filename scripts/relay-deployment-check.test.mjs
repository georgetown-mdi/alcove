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
  historyFindings,
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

describe("historyFindings", () => {
  const TIP = "f".repeat(40);
  const OLD = "a".repeat(40);
  const NEW = "b".repeat(40);
  const GONE = "c".repeat(40);
  const now = new Date("2026-10-13T00:00:00Z");

  function sources({ tip = TIP, known = [COMMIT, OLD, NEW], ...rest } = {}) {
    return {
      git: (args) => {
        if (args[0] === "rev-parse") return { status: 0, stdout: `${tip}\n` };
        const sha = args[2].replace("^{commit}", "");
        return { status: known.includes(sha) ? 0 : 1, stdout: "" };
      },
      readActivities: () => [],
      isAncestor: () => true,
      ...rest,
    };
  }

  it("finds nothing when the deployed commit is main's tip", () => {
    const readActivities = () => {
      throw new Error("read");
    };
    expect(
      historyFindings(TIP, now, sources({ tip: TIP, readActivities })),
    ).toEqual([]);
  });

  it("reports a deployed commit missing from the history", () => {
    expect(historyFindings(GONE, now, sources())).toEqual([
      expect.objectContaining({ kind: "not-on-main" }),
    ]);
  });

  it("reports a deployed commit that is not an ancestor of main", () => {
    const findings = historyFindings(
      COMMIT,
      now,
      sources({ isAncestor: () => false }),
    );
    expect(findings).toEqual([
      {
        kind: "not-on-main",
        message: `the deployed commit ${COMMIT} is not on main`,
      },
    ]);
  });

  it("dates the lag from updates still in main's history", () => {
    const readActivities = () => [
      { timestamp: "2026-10-01T00:00:00Z", after: GONE },
      { timestamp: "2026-10-10T00:00:00Z", after: NEW },
    ];
    const findings = historyFindings(
      COMMIT,
      now,
      sources({
        readActivities,
        isAncestor: (a, d) => !(a === NEW && d === COMMIT),
      }),
    );
    expect(findings).toEqual([
      expect.objectContaining({
        kind: "lag",
        message: expect.stringContaining("since 2026-10-10T00:00:00Z"),
      }),
    ]);
  });

  it("reports unread when no update says since when main moved on", () => {
    expect(historyFindings(COMMIT, now, sources())).toEqual([
      expect.objectContaining({ kind: "unread" }),
    ]);
  });

  it("passes a failed ancestry test up for the caller to report as unread", () => {
    const failing = sources({
      isAncestor: () => {
        throw new Error("git merge-base failed");
      },
    });
    expect(() => historyFindings(COMMIT, now, failing)).toThrow(
      "git merge-base failed",
    );
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
