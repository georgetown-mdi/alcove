import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Holds the relay host's OS update units to infra/relay/README.md, OS
// updates: the window it states, apart from the relay's and the
// broker's certificate renewals on the same host, and the release the upgrade
// reads. It reads the unit files, not a host.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const setting = (text, name) => {
  const matches = [...text.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
  expect(matches, name).toHaveLength(1);
  return matches[0][1].trim();
};

const minutes = (span) => {
  const match = span.match(/^(\d+)(m|h)$/);
  expect(match, `${span} is a whole number of minutes or hours`).not.toBeNull();
  return Number(match[1]) * (match[2] === "h" ? 60 : 1);
};

// [start, end) in minutes past midnight UTC: the daily fire time plus the
// randomized delay.
const window = (path) => {
  const text = read(path);
  const match = setting(text, "OnCalendar").match(
    /^\*-\*-\* (\d\d):(\d\d):00 UTC$/,
  );
  expect(match, `${path} fires daily at a fixed UTC time`).not.toBeNull();
  const start = Number(match[1]) * 60 + Number(match[2]);
  return [start, start + minutes(setting(text, "RandomizedDelaySec"))];
};

const clock = (minute) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

describe("alcove-relay-os-update.timer", () => {
  const update = window("infra/relay/alcove-relay-os-update.timer");
  const cert = window("infra/relay/certs/alcove-relay-cert.timer");
  const brokerCert = window("infra/broker/alcove-broker-cert.timer");

  it.each([
    ["the relay's", cert],
    ["the broker's", brokerCert],
  ])(
    "does not overlap %s certificate renewal window within the day",
    (_, renewal) => {
      expect(update[1]).toBeLessThanOrEqual(24 * 60);
      expect(renewal[1]).toBeLessThanOrEqual(24 * 60);
      expect(update[0] >= renewal[1] || renewal[0] >= update[1]).toBe(true);
    },
  );

  it("does not catch up at boot, outside the window", () => {
    expect(
      setting(read("infra/relay/alcove-relay-os-update.timer"), "Persistent"),
    ).toBe("false");
  });

  it("is the window the README states", () => {
    const readme = read("infra/relay/README.md");
    expect(readme).toContain(
      `between ${clock(update[0])} and ${clock(update[1])} UTC`,
    );
    expect(readme).toContain(
      `renewal window, ${clock(cert[0])} to ${clock(cert[1])} UTC`,
    );
    expect(readme).toContain(
      `same host, ${clock(brokerCert[0])} to ${clock(brokerCert[1])} UTC`,
    );
  });
});

describe("alcove-relay-os-update.service", () => {
  const unit = read("infra/relay/alcove-relay-os-update.service");

  it("upgrades every package to the newest release, not the locked one", () => {
    const argv = setting(unit, "ExecStart").split(/\s+/);
    expect(argv[0]).toBe("/usr/bin/dnf");
    expect(argv).toContain("--releasever=latest");
    expect(argv).toContain("upgrade");
    expect(argv).not.toContain("--security");
    expect(argv).toContain("-y");
  });

  it("runs the relay's verification after the upgrade", () => {
    expect(setting(unit, "ExecStartPost")).toBe(
      "/usr/bin/systemctl start alcove-relay-verify.service",
    );
  });
});
