import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The relay's logging settings in turnserver.conf.tmpl, held to the posture
// docs/notes/webrtc-relay-deployment.md states (What the relay host keeps).
//
// What it holds: the template, not a running coturn. That this setting writes
// no per-session line is a measurement of coturn 4.18.0 recorded in that note;
// this check does not see a coturn release change what the setting writes.

const here = dirname(fileURLToPath(import.meta.url));
const TEMPLATE = resolve(here, "..", "infra/relay/turnserver.conf.tmpl");

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

  it("turns on no verbose logging and no metrics endpoint", () => {
    // Verbose logging writes per-session lines; a metrics endpoint's labels are
    // unmeasured. Either is an incident-response or counters decision the note
    // records first.
    const refused = directives().filter(({ name }) =>
      /^(v|V|verbose|Verbose|prometheus.*|redis-statsdb)$/.test(name),
    );
    expect(refused).toEqual([]);
  });
});
