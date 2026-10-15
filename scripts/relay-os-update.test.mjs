import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Holds the relay host's OS update unit to infra/relay/README.md, OS updates:
// the release the upgrade reads. Its slot in the daily schedule is
// scripts/relay-host-schedule.test.mjs's. It reads the unit file, not a host.

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

const setting = (text, name) => {
  const matches = [...text.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
  expect(matches, name).toHaveLength(1);
  return matches[0][1].trim();
};

describe("alcove-relay-os-update.service", () => {
  const unit = read("infra/relay/alcove-relay-os-update.service");

  it("upgrades every package to the newest release, not the locked one", () => {
    const argv = setting(unit, "ExecStart").split(/\s+/);
    const dnf = argv.indexOf("/usr/bin/dnf");
    expect(dnf).toBeGreaterThan(0);
    const command = argv.slice(dnf);
    expect(command).toContain("--releasever=latest");
    expect(command).toContain("upgrade");
    expect(command).not.toContain("--security");
    expect(command).toContain("-y");
  });

  it("does not catch up at boot, outside the schedule", () => {
    expect(
      setting(read("infra/relay/alcove-relay-os-update.timer"), "Persistent"),
    ).toBe("false");
  });
});
