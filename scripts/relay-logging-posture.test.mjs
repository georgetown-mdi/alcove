import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Holds turnserver.conf.tmpl's logging settings to the posture in
// docs/notes/webrtc-relay-deployment.md (What the relay host keeps). It reads
// the template, not a running coturn.

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(here, "..", "infra/relay/turnserver.conf.tmpl");

const LOGGING =
  /^(log-|syslog|[Vv]erbose$|[Vv]$|prometheus|redis-statsdb|no-stdout-log|new-log-timestamp|simple-log)/;
const ALLOWED = ["log-file", "simple-log"];

const directives = () =>
  readFileSync(TEMPLATE, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const [name, ...value] = line.split("=");
      return { name: name.trim(), value: value.join("=").trim() };
    });

describe("turnserver.conf.tmpl logging", () => {
  it("logs to stdout in simple-log form", () => {
    const names = directives().map(({ name }) => name);
    expect(names).toContain("simple-log");
    expect(directives()).toContainEqual({ name: "log-file", value: "stdout" });
  });

  it("sets no logging directive beyond the documented ones", () => {
    // Verbose logging writes per-session lines and a metrics endpoint's labels
    // are unmeasured; either is a decision the note records first.
    const logging = directives()
      .map(({ name }) => name)
      .filter((name) => LOGGING.test(name));
    expect(logging.sort()).toEqual([...ALLOWED].sort());
  });
});

describe("journal retention", () => {
  const root = resolve(here, "..");
  const read = (path) => readFileSync(resolve(root, path), "utf8");
  const DROPIN = "infra/relay/journald-alcove-relay.conf";
  const DAYS = /^(\d+)day$/;

  const setting = (name) => {
    const match = read(DROPIN).match(new RegExp(`^${name}=(.*)$`, "m"));
    expect(match, name).not.toBeNull();
    return match[1].trim();
  };
  const days = (name) => {
    const match = setting(name).match(DAYS);
    expect(match, `${name} is a whole number of days`).not.toBeNull();
    return Number(match[1]);
  };

  it("keeps a persistent journal", () => {
    expect(setting("Storage")).toBe("persistent");
  });

  it("is installed by install.sh into journald's drop-in directory", () => {
    const install = read("infra/relay/install.sh");
    expect(install).toContain('"$HERE/journald-alcove-relay.conf"');
    expect(install).toContain(
      "JOURNALD_DROPIN=/etc/systemd/journald.conf.d/alcove-relay.conf",
    );
  });

  it("is stated where the docs name it as the retention after the newest entry in a file", () => {
    const retention = days("MaxRetentionSec");
    for (const doc of ["docs/notes/webrtc-relay-deployment.md", "PRIVACY.md"]) {
      expect(read(doc), doc).toContain(
        `about ${retention} days after the newest entry in its file`,
      );
    }
  });
});
