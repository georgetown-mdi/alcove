import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The relay host's pull from main (infra/host-pull): pull.sh through each
// outcome against a fixture host with git, curl, cosign, npm, systemctl, chown
// and both install scripts stubbed, its install.sh, and its timer's window.

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PULL_DIR = join(repo, "infra/host-pull");
const BASH = existsSync("/bin/bash") ? "/bin/bash" : "bash";

const TIP = "a".repeat(40);
const DEPLOYED = "b".repeat(40);
const OTHER = "c".repeat(40);
const IDENTITY =
  "https://github.com/georgetown-mdi/alcove/.github/workflows/broker_core_build.yaml@refs/heads/main";
const ISSUER = "https://token.actions.githubusercontent.com";

const created = [];
afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop(), { recursive: true, force: true });
  }
});
const fixtureDir = (prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
};

const writeStub = (path, body) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
};

const GIT_STUB = String.raw`
dir=.
if [ "$1" = -C ]; then dir="$2"; shift 2; fi
printf 'git %s\n' "$*" >> "$F/calls"
case "$1" in
  ls-remote)
    [ ! -e "$F/fail-ls-remote" ] || exit 128
    printf '%s\trefs/heads/main\n' "$(cat "$F/tip")" ;;
  init) mkdir -p "$3" ;;
  fetch)
    [ ! -e "$F/fail-fetch" ] || exit 128
    cp -R "$F/remote/." "$dir/" ;;
  rev-parse) cat "$F/fetched" 2>/dev/null || cat "$F/tip" ;;
  checkout) ;;
  *) exit 99 ;;
esac`;

// Serves $F/served/<name>, <name> being the URL's last segment, or check-runs
// for the API's; a .code file beside it overrides the status, a .exit file
// makes the transfer fail.
const CURL_STUB = String.raw`
printf 'curl %s\n' "$*" >> "$F/calls"
out=; url=
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    -w|-H|--max-time|--max-filesize|--proto|--proto-redir) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
case "$url" in
  */check-runs\?per_page=100) name=check-runs ;;
  *) name="$(basename "$url")" ;;
esac
served="$F/served/$name"
if [ -e "$served.exit" ]; then printf 000; exit "$(cat "$served.exit")"; fi
if [ -e "$served.code" ]; then code="$(cat "$served.code")"
elif [ -e "$served" ]; then code=200
else code=404; fi
if [ -e "$served" ]; then cp "$served" "$out"; else printf 'Not Found' > "$out"; fi
printf '%s' "$code"`;

// Passes only for the README's identity and issuer, and a workflow SHA equal
// to the commit the fixture's build was signed for.
const COSIGN_STUB = String.raw`
printf 'cosign %s\n' "$*" >> "$F/calls"
[ "$1" = verify-blob ] || exit 99
shift
bundle=; identity=; issuer=; sha=; blob=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --bundle) bundle="$2"; shift 2 ;;
    --certificate-identity) identity="$2"; shift 2 ;;
    --certificate-oidc-issuer) issuer="$2"; shift 2 ;;
    --certificate-github-workflow-sha) sha="$2"; shift 2 ;;
    -*) exit 98 ;;
    *) blob="$1"; shift ;;
  esac
done
[ -s "$bundle" ] && [ -s "$blob" ] || exit 1
[ "$identity" = "${IDENTITY}" ] && [ "$issuer" = "${ISSUER}" ] || exit 1
[ "$sha" = "$(cat "$F/signed-for")" ] || { echo "Error: none of the expected identities matched" >&2; exit 1; }`;

const NPM_STUB = String.raw`
printf 'npm %s in %s\n' "$*" "$PWD" >> "$F/calls"
[ ! -e "$F/fail-npm" ] || exit 1
mkdir -p node_modules/.bin && : > node_modules/.bin/tsx`;

// An install script inside the fetched tree: records where the broker's link
// pointed when it ran.
const installStub = (name) => String.raw`
printf '%s %s\n' "${name}" "$(readlink "$F/opt/alcove-broker/src")" >> "$F/calls"
[ ! -e "$F/fail-${name}" ] || exit 1`;

const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** A core build archive: the entry point, one chunk and the manifest. */
const buildArchive = (root, path, { corrupt = false } = {}) => {
  const dir = join(root, "build");
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir);
  const files = {
    "untrusted-text.esm.js": 'import "./shared2.esm.js";\nexport {};\n',
    "shared2.esm.js": "export const shared = 1;\n",
  };
  for (const [name, text] of Object.entries(files)) {
    writeFileSync(join(dir, name), text);
  }
  writeFileSync(
    join(dir, "SHA256SUMS"),
    Object.entries(files)
      .map(([name, text]) => `${sha256(text)}  ${name}\n`)
      .join(""),
  );
  if (corrupt) writeFileSync(join(dir, "shared2.esm.js"), "tampered\n");
  const tar = spawnSync("tar", [
    "-czf",
    path,
    "-C",
    dir,
    ...Object.keys(files),
    "SHA256SUMS",
  ]);
  expect(tar.status).toBe(0);
};

const checkRuns = (runs) =>
  JSON.stringify({
    total_count: runs.length,
    check_runs: runs.map(([name, status, conclusion]) => ({
      name,
      status,
      conclusion,
    })),
  });
const GREEN = [
  ["Typecheck, Lint, Format", "completed", "success"],
  ["CodeQL", "completed", "neutral"],
  ["Native Alpine", "completed", "skipped"],
];

const ARCHIVE = `alcove-broker-core-${TIP}.tar.gz`;
const BUNDLE = `${ARCHIVE}.sigstore.json`;

/**
 * A host under a fixture root whose main is at TIP, CI green, the build
 * published and signed for TIP, and the broker linked to the tree of DEPLOYED.
 */
const host = () => {
  const root = fixtureDir("host-pull-");
  const bin = join(root, "bin");
  const served = join(root, "served");
  const broker = join(root, "opt/alcove-broker");
  mkdirSync(served, { recursive: true });
  mkdirSync(join(broker, "trees", DEPLOYED), { recursive: true });
  symlinkSync(`trees/${DEPLOYED}`, join(broker, "src"));
  const head = `F='${root}'`;
  writeStub(join(bin, "git"), `${head}\n${GIT_STUB}`);
  writeStub(join(bin, "curl"), `${head}\n${CURL_STUB}`);
  writeStub(join(bin, "cosign"), `${head}\n${COSIGN_STUB}`);
  writeStub(join(bin, "npm"), `${head}\n${NPM_STUB}`);
  writeStub(
    join(bin, "systemctl"),
    `${head}\nprintf 'systemctl %s\\n' "$*" >> "$F/calls"`,
  );
  writeStub(
    join(bin, "chown"),
    `${head}\nprintf 'chown %s\\n' "$*" >> "$F/calls"`,
  );
  writeStub(
    join(bin, "id"),
    `if [ "$1" = -u ]; then cat '${root}/uid' 2>/dev/null || echo 0; else exec /usr/bin/id "$@"; fi`,
  );
  for (const name of ["broker-install", "relay-install"]) {
    const dir = name === "broker-install" ? "broker" : "relay";
    writeStub(
      join(root, "remote/infra", dir, "install.sh"),
      `${head}\n${installStub(name)}`,
    );
  }
  writeFileSync(join(root, "remote/package.json"), "{}\n");
  writeFileSync(join(root, "tip"), TIP);
  writeFileSync(join(root, "signed-for"), TIP);
  writeFileSync(join(served, "check-runs"), checkRuns(GREEN));
  buildArchive(root, join(served, ARCHIVE));
  writeFileSync(join(served, BUNDLE), '{"fixture":"bundle"}\n');

  const set = (name, value = "") => writeFileSync(join(root, name), value);
  const run = (script = join(PULL_DIR, "pull.sh")) => {
    writeFileSync(join(root, "calls"), "");
    const result = spawnSync(BASH, [script], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        ALCOVE_HOST_PULL_INSTALL_ROOT: root,
      },
    });
    const calls = readFileSync(join(root, "calls"), "utf8")
      .split("\n")
      .filter(Boolean);
    const statusPath = join(root, "var/lib/alcove-host-pull/status");
    const record = existsSync(statusPath)
      ? Object.fromEntries(
          readFileSync(statusPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split(/=(.*)/s).slice(0, 2)),
        )
      : undefined;
    return { ...result, calls, record };
  };
  return {
    root,
    broker,
    set,
    serve: (name, text) => writeFileSync(join(served, name), text),
    unserve: (name) => rmSync(join(served, name)),
    archive: (options) => buildArchive(root, join(served, ARCHIVE), options),
    link: () => readlinkSync(join(broker, "src")),
    trees: () => readdirSync(join(broker, "trees")).sort(),
    run,
  };
};

const REPOSITORY_URL = "https://github.com/georgetown-mdi/alcove.git";
const CHECK_RUNS_URL = `https://api.github.com/repos/georgetown-mdi/alcove/commits/${TIP}/check-runs?per_page=100`;
const RELEASE_URL =
  "https://github.com/georgetown-mdi/alcove/releases/download/broker-core-build";

const named = (calls, prefix) => calls.filter((c) => c.startsWith(prefix));
const downloads = (calls) =>
  named(calls, "curl ").filter((c) => c.includes(RELEASE_URL));

/** The run left the broker on DEPLOYED's tree with nothing staged beside it. */
const untouched = (h) => {
  expect(h.link()).toBe(`trees/${DEPLOYED}`);
  expect(h.trees()).toEqual([DEPLOYED]);
  expect(named(h.lastCalls, "systemctl")).toEqual([]);
};

const outcome = (h, name, status) => {
  const r = h.run();
  h.lastCalls = r.calls;
  expect(r.status, r.stderr).toBe(status);
  expect(r.record?.outcome, r.stderr).toBe(name);
  expect(r.stderr).toContain(`${name}: ${r.record.reason}`);
  expect(existsSync(join(h.root, "var/lib/alcove-host-pull/work"))).toBe(false);
  return r;
};

describe("pull.sh", () => {
  it("installs a green, signed tip in a new tree, then both installs, and records it", () => {
    const h = host();
    const r = outcome(h, "updated", 0);
    expect(r.record).toMatchObject({
      deployed_commit: TIP,
      main_commit: TIP,
      reason: `deployed ${TIP}`,
    });
    expect(r.record.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(h.link()).toBe(`trees/${TIP}`);
    expect(h.trees()).toEqual([TIP, DEPLOYED]);
    const tree = join(h.broker, "trees", TIP);
    expect(
      readFileSync(
        join(tree, "packages/core/dist/untrusted-text.esm.js"),
        "utf8",
      ),
    ).toContain("shared2.esm.js");
    expect(existsSync(join(tree, "node_modules/.bin/tsx"))).toBe(true);
    expect(lstatSync(join(h.broker, "src")).isSymbolicLink()).toBe(true);

    const work = join(h.root, "var/lib/alcove-host-pull/work");
    const steps = [
      `git ls-remote --exit-code ${REPOSITORY_URL} refs/heads/main`,
      CHECK_RUNS_URL,
      `${RELEASE_URL}/${ARCHIVE}`,
      `${RELEASE_URL}/${BUNDLE}`,
      [
        "cosign verify-blob",
        `--bundle ${work}/${BUNDLE}`,
        `--certificate-identity ${IDENTITY}`,
        `--certificate-oidc-issuer ${ISSUER}`,
        `--certificate-github-workflow-sha ${TIP}`,
        `${work}/${ARCHIVE}`,
      ].join(" "),
      "git init -q",
      `git fetch -q --depth 1 ${REPOSITORY_URL} refs/heads/main`,
      "git rev-parse FETCH_HEAD",
      "git checkout -q --detach FETCH_HEAD",
      "npm ci --no-audit --no-fund --workspace packages/peerjs-broker in ",
      "chown -R 0:0 ",
      "systemctl try-restart alcove-broker.service",
      `broker-install trees/${TIP}`,
      `relay-install trees/${TIP}`,
    ];
    expect(r.calls).toHaveLength(steps.length);
    steps.forEach((step, index) => expect(r.calls[index]).toContain(step));
    for (const call of named(r.calls, "curl ")) {
      expect(call).toContain("--proto =https --proto-redir =https");
    }
  });

  it("installs on a host with no broker tree yet", () => {
    const h = host();
    rmSync(join(h.broker, "src"));
    outcome(h, "updated", 0);
    expect(h.link()).toBe(`trees/${TIP}`);
  });

  it("does nothing when the tip is the deployed commit", () => {
    const h = host();
    h.set("tip", DEPLOYED);
    const r = outcome(h, "unchanged", 0);
    expect(r.record).toMatchObject({
      deployed_commit: DEPLOYED,
      main_commit: DEPLOYED,
    });
    expect(r.calls).toEqual([
      `git ls-remote --exit-code ${REPOSITORY_URL} refs/heads/main`,
    ]);
    untouched(h);
  });

  it.each([
    [
      "a check run has not completed",
      [...GREEN, ["CLI Build and Test", "in_progress", null]],
      "CI has not finished on",
      "CLI Build and Test",
    ],
    ["no check run has reported", [], "no check run has reported", ""],
  ])("skips the day when %s", (_, runs, reason, name) => {
    const h = host();
    h.serve("check-runs", checkRuns(runs));
    const r = outcome(h, "skipped", 0);
    expect(r.record.reason).toContain(reason);
    expect(r.record.reason).toContain(name);
    expect(r.record.main_commit).toBe(TIP);
    expect(downloads(r.calls)).toEqual([]);
    untouched(h);
  });

  it("refuses a tip with a check run that did not pass, even beside a pending one", () => {
    const h = host();
    h.serve(
      "check-runs",
      checkRuns([
        ...GREEN,
        ["CLI Build and Test", "completed", "failure"],
        ["Static Checks", "completed", "cancelled"],
        ["Image Smoke", "queued", null],
      ]),
    );
    const r = outcome(h, "refused", 1);
    expect(r.record.reason).toContain("CLI Build and Test, Static Checks");
    expect(r.record.reason).not.toContain("Image Smoke");
    expect(downloads(r.calls)).toEqual([]);
    untouched(h);
  });

  it.each([
    [
      "more check runs than one page holds",
      () => JSON.stringify({ total_count: 120, check_runs: [] }),
    ],
    ["an answer that is not JSON", () => "<html>"],
  ])("fails on %s", (_, body) => {
    const h = host();
    h.serve("check-runs", body());
    const r = outcome(h, "failed", 1);
    expect(r.record.reason).toContain("were not read");
    expect(downloads(r.calls)).toEqual([]);
    untouched(h);
  });

  it("fails when GitHub refuses the check-runs read", () => {
    const h = host();
    h.serve("check-runs.code", "403");
    const r = outcome(h, "failed", 1);
    expect(r.record.reason).toContain("HTTP 403");
    untouched(h);
  });

  it.each([ARCHIVE, BUNDLE])(
    "skips the day when the prerelease has no %s",
    (name) => {
      const h = host();
      h.unserve(name);
      const r = outcome(h, "skipped", 0);
      expect(r.record.reason).toContain(`has no ${name} yet`);
      expect(named(r.calls, "cosign")).toEqual([]);
      untouched(h);
    },
  );

  it.each([
    ["the transfer fails", `${ARCHIVE}.exit`, "28", "could not download"],
    ["the server errs", `${ARCHIVE}.code`, "502", "HTTP 502"],
  ])("fails when %s", (_, file, value, reason) => {
    const h = host();
    h.serve(file, value);
    const r = outcome(h, "failed", 1);
    expect(r.record.reason).toContain(reason);
    expect(named(r.calls, "cosign")).toEqual([]);
    untouched(h);
  });

  it("refuses a correctly signed build of a commit other than the tip", () => {
    const h = host();
    h.set("signed-for", OTHER);
    const r = outcome(h, "refused", 1);
    expect(r.record.reason).toContain("does not verify");
    expect(named(r.calls, "git fetch")).toEqual([]);
    untouched(h);
  });

  it("refuses a build whose files do not match its SHA256SUMS", () => {
    const h = host();
    h.archive({ corrupt: true });
    const r = outcome(h, "refused", 1);
    expect(r.record.reason).toContain("SHA256SUMS");
    expect(named(r.calls, "npm")).toEqual([]);
    untouched(h);
  });

  it("skips the day when main moved between the read and the fetch", () => {
    const h = host();
    h.set("fetched", OTHER);
    const r = outcome(h, "skipped", 0);
    expect(r.record.reason).toContain(`main moved from ${TIP} to ${OTHER}`);
    untouched(h);
  });

  it("fails without switching when the broker workspace does not install", () => {
    const h = host();
    h.set("fail-npm");
    const r = outcome(h, "failed", 1);
    expect(r.record.reason).toContain("npm ci");
    untouched(h);
  });

  it.each([
    ["broker-install", "infra/broker/install.sh failed", false],
    ["relay-install", "infra/relay/install.sh or its verify.sh failed", true],
  ])(
    "records a failed %s and leaves the broker on the new tree",
    (name, reason, brokerRan) => {
      const h = host();
      h.set(`fail-${name}`);
      const r = outcome(h, "failed", 1);
      expect(r.record).toMatchObject({ deployed_commit: TIP });
      expect(r.record.reason).toContain(reason);
      expect(h.link()).toBe(`trees/${TIP}`);
      expect(named(r.calls, "broker-install")).toHaveLength(1);
      expect(named(r.calls, "relay-install")).toHaveLength(brokerRan ? 1 : 0);
    },
  );

  it("fails when main cannot be read", () => {
    const h = host();
    h.set("fail-ls-remote");
    const r = outcome(h, "failed", 1);
    expect(r.record).toMatchObject({
      deployed_commit: DEPLOYED,
      main_commit: "",
    });
    untouched(h);
  });

  it.each([
    [
      "a directory",
      (h) => {
        rmSync(join(h.broker, "src"));
        mkdirSync(join(h.broker, "src"));
      },
    ],
    [
      "a link outside the trees",
      (h) => {
        rmSync(join(h.broker, "src"));
        symlinkSync("/opt/alcove-src", join(h.broker, "src"));
      },
    ],
  ])("fails before reading main when the broker's src is %s", (_, make) => {
    const h = host();
    make(h);
    const r = outcome(h, "failed", 1);
    expect(r.record.deployed_commit).toBe("");
    expect(r.calls).toEqual([]);
  });

  it("refuses to run as anyone but root, writing nothing", () => {
    const h = host();
    h.set("uid", "1000");
    const r = h.run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("run it as root");
    expect(r.record).toBeUndefined();
    expect(r.calls).toEqual([]);
  });
});

describe("install.sh", () => {
  it("installs the pull and its units by rename, and enables nothing", () => {
    const h = host();
    const r = h.run(join(PULL_DIR, "install.sh"));
    expect(r.status, r.stderr).toBe(0);
    for (const file of ["pull.sh", "check-runs.mjs"]) {
      const installed = join(h.root, "opt/alcove-host-pull", file);
      expect(readFileSync(installed, "utf8")).toBe(
        readFileSync(join(PULL_DIR, file), "utf8"),
      );
      expect(lstatSync(installed).mode & 0o777).toBe(0o755);
    }
    for (const unit of ["alcove-host-pull.service", "alcove-host-pull.timer"]) {
      expect(
        readFileSync(join(h.root, "etc/systemd/system", unit), "utf8"),
      ).toBe(readFileSync(join(PULL_DIR, unit), "utf8"));
    }
    expect(r.calls).toEqual([
      "systemctl daemon-reload",
      "systemctl try-restart alcove-host-pull.timer",
    ]);
  });

  it("is installed by neither the relay's nor the broker's install script", () => {
    for (const script of [
      "infra/relay/install.sh",
      "infra/broker/install.sh",
    ]) {
      expect(readFileSync(join(repo, script), "utf8")).not.toContain(
        "host-pull",
      );
    }
  });

  it.each([
    [BASH, "-n", "pull.sh"],
    [BASH, "-n", "install.sh"],
    [process.execPath, "--check", "check-runs.mjs"],
  ])("%s %s %s parses", (command, flag, file) => {
    const result = spawnSync(command, [flag, join(PULL_DIR, file)], {
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
  });
});

describe("alcove-host-pull units", () => {
  const read = (path) => readFileSync(join(repo, path), "utf8");
  const setting = (text, name) => {
    const matches = [...text.matchAll(new RegExp(`^${name}=(.*)$`, "gm"))];
    expect(matches, name).toHaveLength(1);
    return matches[0][1].trim();
  };
  const minutes = (span) => {
    const match = span.match(/^(\d+)(m|h)$/);
    expect(match, span).not.toBeNull();
    return Number(match[1]) * (match[2] === "h" ? 60 : 1);
  };
  const clock = (minute) =>
    `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  // [start, end) in minutes past midnight: the daily fire time plus the
  // randomized delay. A timer without " UTC" runs on the host's zone, UTC on
  // the relay host.
  const window = (path) => {
    const text = read(path);
    const match = setting(text, "OnCalendar").match(
      /^\*-\*-\* (\d\d):(\d\d):00( UTC)?$/,
    );
    expect(match, `${path} fires daily at a fixed time`).not.toBeNull();
    const start = Number(match[1]) * 60 + Number(match[2]);
    return [start, start + minutes(setting(text, "RandomizedDelaySec"))];
  };
  const TIMERS = {
    "alcove-relay-cert.timer": "infra/relay/certs/alcove-relay-cert.timer",
    "alcove-broker-cert.timer": "infra/broker/alcove-broker-cert.timer",
    "alcove-relay-os-update.timer": "infra/relay/alcove-relay-os-update.timer",
  };
  const readme = read("infra/host-pull/README.md");
  const timer = read("infra/host-pull/alcove-host-pull.timer");
  const pull = window("infra/host-pull/alcove-host-pull.timer");
  const stated = [
    ...readme.matchAll(
      /^\| `([\w.-]+\.timer)`, [^|]+\| (\d\d):(\d\d) to (\d\d):(\d\d) \|$/gm,
    ),
  ].map((m) => ({
    name: m[1],
    window: [
      Number(m[2]) * 60 + Number(m[3]),
      Number(m[4]) * 60 + Number(m[5]),
    ],
  }));

  it("fires in UTC, in the window the README states", () => {
    expect(setting(timer, "OnCalendar")).toMatch(/ UTC$/);
    expect(pull[1]).toBeLessThanOrEqual(24 * 60);
    expect(readme).toContain(
      `fires every day at ${clock(pull[0])} UTC, with up to ${pull[1] - pull[0]} minutes`,
    );
  });

  it("states the window of each timer it stays clear of, as the timer has it", () => {
    expect(stated.map((entry) => entry.name).sort()).toEqual(
      Object.keys(TIMERS).sort(),
    );
    for (const { name, window: span } of stated) {
      if (existsSync(join(repo, TIMERS[name]))) {
        expect(window(TIMERS[name]), name).toEqual(span);
      }
    }
  });

  it("starts after every window it states, within the day", () => {
    for (const { name, window: span } of stated) {
      expect(pull[0], name).toBeGreaterThanOrEqual(span[1]);
    }
  });

  it("does not catch up at boot, outside the window", () => {
    expect(setting(timer, "Persistent")).toBe("false");
  });

  it("runs the installed copy, after the OS update", () => {
    const service = read("infra/host-pull/alcove-host-pull.service");
    expect(setting(service, "ExecStart")).toBe("/opt/alcove-host-pull/pull.sh");
    expect(setting(service, "After").split(/\s+/)).toContain(
      "alcove-relay-os-update.service",
    );
  });
});
