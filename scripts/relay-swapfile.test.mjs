import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// infra/relay/install.sh's swapfile step, run alone against stubbed df,
// fallocate, dd, mkswap and swapon, with /swapfile and /etc/fstab moved into a
// temporary directory. What swapon does with a real file on a real filesystem
// is the host run's to measure (infra/relay/README.md, OS updates).

const here = dirname(fileURLToPath(import.meta.url));
const INSTALL = readFileSync(
  resolve(here, "..", "infra/relay/install.sh"),
  "utf8",
);
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

const STEP_START = "# --- the swapfile ---";
const STEP_END = "# --- the container runtime ---";

const tmpDirs = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    rmSync(tmpDirs.pop(), { recursive: true, force: true });
  }
});

const step = () => {
  const start = INSTALL.indexOf(STEP_START);
  const end = INSTALL.indexOf(STEP_END);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return INSTALL.slice(start, end);
};

const STUBS = {
  df: `printf 'Avail\\n%sM\\n' "$FREE_MB"`,
  fallocate: `printf 'fallocate %s\\n' "$*" >> "$STATE/calls"; : > "$3"`,
  dd: [
    `printf 'dd %s\\n' "$*" >> "$STATE/calls"`,
    `for a in "$@"; do case "$a" in of=*) : > "\${a#of=}" ;; esac; done`,
  ].join("\n"),
  mkswap: `printf 'mkswap %s\\n' "$*" >> "$STATE/calls"`,
  swapon: [
    `case "$1" in --show*) cat "$STATE/active" 2>/dev/null; exit 0 ;; esac`,
    `printf 'swapon %s\\n' "$*" >> "$STATE/calls"`,
    `n="$(cat "$STATE/refusals")"`,
    `if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$STATE/refusals"; echo "swapon: $3: swapfile has holes" >&2; exit 255; fi`,
    `printf '%s file 1024M 0B %s\\n' "$3" "$2" >> "$STATE/active"`,
  ].join("\n"),
};

/** Runs the step once in a fixture directory; returns its output and state. */
const run = ({
  freeMb,
  refusals = 0,
  fstab = "",
  swapfile = false,
  active = false,
  root,
}) => {
  const dir = root ?? mkdtempSync(join(tmpdir(), "relay-swapfile-"));
  if (!root) tmpDirs.push(dir);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  for (const [name, body] of Object.entries(STUBS)) {
    writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  writeFileSync(join(state, "refusals"), `${refusals}\n`);
  const swapPath = join(dir, "swapfile");
  const fstabPath = join(dir, "fstab");
  if (!root) {
    writeFileSync(
      fstabPath,
      typeof fstab === "function" ? fstab(swapPath) : fstab,
    );
    if (swapfile) writeFileSync(swapPath, "");
    if (active) {
      writeFileSync(join(state, "active"), `${swapPath} file 1024M 0B 10\n`);
    }
  }
  const script = [
    "set -euo pipefail",
    `log() { printf '%s\\n' "$*" >&2; }`,
    step()
      .replaceAll("/etc/fstab", fstabPath)
      .replaceAll("/swapfile", swapPath),
  ].join("\n");
  const result = spawnSync(BASH, ["-c", script], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      STATE: state,
      FREE_MB: String(freeMb),
    },
  });
  const calls = existsSync(join(state, "calls"))
    ? readFileSync(join(state, "calls"), "utf8").trim().split("\n")
    : [];
  return {
    dir,
    status: result.status,
    log: result.stderr,
    calls,
    swapPath,
    fstab: readFileSync(fstabPath, "utf8"),
    swapfileExists: existsSync(swapPath),
  };
};

describe("install.sh's swapfile step", () => {
  it("adds a 1024 MB file at priority 10, in /etc/fstab once, with 2560 MB to 4095 MB free", () => {
    const first = run({ freeMb: 3675, fstab: "UUID=x / xfs defaults 0 0\n" });
    expect(first.status).toBe(0);
    expect(first.calls).toEqual([
      `fallocate -l 1024M ${first.swapPath}`,
      `mkswap ${first.swapPath}`,
      `swapon -p 10 ${first.swapPath}`,
    ]);
    expect(first.fstab).toBe(
      `UUID=x / xfs defaults 0 0\n${first.swapPath} none swap defaults,pri=10 0 0\n`,
    );
    expect(first.log).toContain(`added ${first.swapPath} to`);

    const again = run({ freeMb: 3675, root: first.dir });
    expect(again.status).toBe(0);
    expect(again.calls).toEqual(first.calls);
    expect(again.fstab).toBe(first.fstab);
    expect(again.log).toContain(
      `keeping ${first.swapPath}: ${first.swapPath} file`,
    );
  });

  it("adds a 2048 MB file with at least 4096 MB free", () => {
    const r = run({ freeMb: 4096 });
    expect(r.status).toBe(0);
    expect(r.calls[0]).toBe(`fallocate -l 2048M ${r.swapPath}`);
  });

  it("warns, naming the free space, and adds nothing under 2560 MB free", () => {
    const r = run({ freeMb: 2559, fstab: "UUID=x / xfs defaults 0 0\n" });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.swapfileExists).toBe(false);
    expect(r.fstab).toBe("UUID=x / xfs defaults 0 0\n");
    expect(r.log).toContain("WARNING: / has 2559 MB free, under the 2560 MB");
  });

  it("writes the file with dd only when swapon refuses the fallocated one", () => {
    const r = run({ freeMb: 3675, refusals: 1 });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      `fallocate -l 1024M ${r.swapPath}`,
      `mkswap ${r.swapPath}`,
      `swapon -p 10 ${r.swapPath}`,
      `dd if=/dev/zero of=${r.swapPath} bs=1M count=1024 oflag=direct status=none`,
      `mkswap ${r.swapPath}`,
      `swapon -p 10 ${r.swapPath}`,
    ]);
    expect(r.fstab).toBe(`${r.swapPath} none swap defaults,pri=10 0 0\n`);
  });

  it("removes the file, leaves /etc/fstab alone and warns when swapon refuses both", () => {
    const r = run({
      freeMb: 3675,
      refusals: 2,
      fstab: "UUID=x / xfs defaults 0 0\n",
    });
    expect(r.status).toBe(0);
    expect(r.swapfileExists).toBe(false);
    expect(r.fstab).toBe("UUID=x / xfs defaults 0 0\n");
    expect(r.log).toContain("could not be made swap");
  });

  it("puts the fstab line on its own line after a file with no final newline", () => {
    const r = run({ freeMb: 3675, fstab: "UUID=x / xfs defaults 0 0" });
    expect(r.fstab).toBe(
      `UUID=x / xfs defaults 0 0\n${r.swapPath} none swap defaults,pri=10 0 0\n`,
    );
  });

  it("changes nothing and warns when /etc/fstab names a swapfile that is not in use", () => {
    const fstab = (swapPath) => `${swapPath} none swap defaults,pri=10 0 0\n`;
    const r = run({ freeMb: 3675, fstab });
    expect(r.fstab).toBe(fstab(r.swapPath));
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.swapfileExists).toBe(false);
    expect(r.log).toContain("not in use as swap");
  });

  it("appends the fstab line once when /swapfile is in use and /etc/fstab lacks it", () => {
    const r = run({
      freeMb: 3675,
      fstab: "UUID=x / xfs defaults 0 0\n",
      swapfile: true,
      active: true,
    });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.fstab).toBe(
      `UUID=x / xfs defaults 0 0\n${r.swapPath} none swap defaults,pri=10 0 0\n`,
    );
    expect(r.log).toContain(
      `added ${r.swapPath} to ${r.dir}/fstab: ${r.swapPath} file`,
    );

    const again = run({ freeMb: 3675, root: r.dir });
    expect(again.fstab).toBe(r.fstab);
    expect(again.log).toContain(`keeping ${r.swapPath}`);
  });

  it("appends nothing when /swapfile is in use and /etc/fstab names it", () => {
    const fstab = (swapPath) => `${swapPath} none swap defaults,pri=10 0 0\n`;
    const r = run({ freeMb: 3675, fstab, swapfile: true, active: true });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([]);
    expect(r.fstab).toBe(fstab(r.swapPath));
    expect(r.log).toContain(`keeping ${r.swapPath}: ${r.swapPath} file`);
    expect(r.log).not.toContain("added");
  });

  it("runs before the OS update timer is enabled, and leaves vm.swappiness alone", () => {
    expect(INSTALL.indexOf(STEP_START)).toBeLessThan(
      INSTALL.indexOf("systemctl enable --now alcove-relay-os-update.timer"),
    );
    expect(INSTALL).not.toMatch(/sysctl|\/proc\/sys\/vm/);
  });
});
