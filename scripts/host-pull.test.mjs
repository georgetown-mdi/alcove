import { spawn, spawnSync } from "node:child_process";
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
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// The relay host's pull from main (infra/host-pull): pull.sh through each
// outcome against a fixture host with git, curl, cosign, npm, systemctl, chown
// and both install scripts stubbed, its install.sh, and its units.

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

// Serves $F/served/<name>, <name> being the URL's last segment, or runs for the
// API's workflow runs, which API_FAKE answers from $F/runs.json unless a runs
// file overrides the body; a .code file beside it overrides the status, a .exit
// file makes the transfer fail.
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
  */actions/runs\?*) name=runs ;;
  *) name="$(basename "$url")" ;;
esac
served="$F/served/$name"
if [ -e "$served.exit" ]; then printf 000; exit "$(cat "$served.exit")"; fi
if [ "$name" = runs ] && [ ! -e "$served" ]; then
  node "$F/api.mjs" "$url" "$F/runs.json" > "$out"; code=200
elif [ -e "$served" ]; then cp "$served" "$out"; code=200
else printf 'Not Found' > "$out"; code=404; fi
if [ -e "$served.code" ]; then code="$(cat "$served.code")"; fi
printf '%s' "$code"`;

// The list-workflow-runs endpoint over every run of the fixture's repository:
// filtered by head_sha and event, and paged by per_page and page.
const API_FAKE = String.raw`
import { readFileSync } from "node:fs";
const query = new URL(process.argv[2]).searchParams;
const matching = JSON.parse(readFileSync(process.argv[3], "utf8")).filter(
  (run) =>
    run.head_sha === query.get("head_sha") &&
    (!query.has("event") || run.event === query.get("event")),
);
const perPage = Number(query.get("per_page") ?? 30);
const page = Number(query.get("page") ?? 1);
process.stdout.write(
  JSON.stringify({
    total_count: matching.length,
    workflow_runs: matching.slice((page - 1) * perPage, page * perPage),
  }),
);`;

// Passes only for the README's identity and issuer, and a workflow SHA equal
// to the commit the fixture's build was signed for. It never reads the bundle
// or the archive, so whether a signature covers the bytes is untested here.
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

// While $F/script-only-kill exists, a timeout whose signals reach the command
// alone, as the kill-after KILL of uutils timeout (Ubuntu 26.04) does, on a
// host whose /usr/bin/timeout is GNU's and signals the whole process group.
const TIMEOUT_STUB = String.raw`
printf '%s\n' "$*" >> "$F/timeouts"
[ -e "$F/script-only-kill" ] && [ "$1" = -k ] || exec /usr/bin/timeout "$@"
after="$2"; bound="$3"; shift 3
"$@" &
script=$!
{ sleep "$bound"; kill -TERM "$script"; sleep "$after"; kill -KILL "$script"; } >/dev/null 2>&1 &
watch=$!
wait "$script"; status=$?
kill "$watch" 2>/dev/null
exit "$status"`;

const NPM_STUB = String.raw`
printf 'npm %s in %s\n' "$*" "$PWD" >> "$F/calls"
[ ! -e "$F/fail-npm" ] || exit 1
if [ -e "$F/slow-npm" ]; then : > "$F/npm-started"; sleep 30; fi
mkdir -p node_modules/.bin && : > node_modules/.bin/tsx`;

// A script inside a tree: records where the broker's link pointed when it ran,
// and fails while $F/fail-<name>-<that commit> exists. The relay's install
// script ends by running its tree's verify.sh, as infra/relay/install.sh does.
const treeStub = (name, last = "") => String.raw`
linked="$(readlink "$F/opt/alcove-broker/src")"
printf '%s %s\n' "${name}" "$linked" >> "$F/calls"
ls "$F/opt/alcove-broker/trees" | wc -l >> "$F/tree-counts"
[ ! -e "$F/hang-${name}-$(basename "$linked")" ] || exec sleep 30
if [ -e "$F/deaf-${name}-$(basename "$linked")" ]; then trap '' TERM; sleep 30; fi
[ ! -e "$F/fail-${name}-$(basename "$linked")" ] || exit 1
${last}`;
const TREE_STUBS = {
  "infra/broker/install.sh": treeStub("broker-install"),
  "infra/relay/install.sh": treeStub(
    "relay-install",
    '"$(dirname "$0")/verify.sh"',
  ),
  "infra/relay/verify.sh": treeStub("verify"),
};

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

/** One workflow run of TIP, completed as success on a push to main unless overridden. */
const workflowRun = (name, overrides = {}) => ({
  name,
  head_sha: TIP,
  head_branch: "main",
  event: "push",
  status: "completed",
  conclusion: "success",
  ...overrides,
});
const workflowRuns = (runs) =>
  JSON.stringify(runs.map((run, index) => ({ id: 1000 + index, ...run })));
// The promotion's push runs, the same commit's earlier push to staging, and
// runs of other events that do not gate: a failed nightly and Dependabot's.
const GREEN = [
  workflowRun("Static Checks", { head_branch: "staging" }),
  workflowRun("CLI Build and Test", { head_branch: "staging" }),
  workflowRun("CodeQL"),
  workflowRun("Deploy to Cloudflare Pages"),
];
const NOT_GATING = [
  workflowRun("Nightly Platform Tests", {
    event: "schedule",
    conclusion: "failure",
  }),
  workflowRun("Nightly Core Stress Tests", {
    event: "schedule",
    status: "in_progress",
    conclusion: null,
  }),
  workflowRun("npm_and_yarn in /. - Update", {
    event: "dynamic",
    head_branch: "staging",
    conclusion: "failure",
  }),
  workflowRun("CI on another commit", {
    head_sha: OTHER,
    conclusion: "failure",
  }),
];

const ARCHIVE = `alcove-broker-core-${TIP}.tar.gz`;
const BUNDLE = `${ARCHIVE}.sigstore.json`;

/**
 * A host under a fixture root whose main is at TIP, CI green, the build
 * published and signed for TIP, and the broker linked to the tree of DEPLOYED,
 * the commit the deployed marker names.
 */
const DEFAULT_BOUND = 315;

const host = () => {
  const root = fixtureDir("host-pull-");
  const bin = join(root, "bin");
  const served = join(root, "served");
  const broker = join(root, "opt/alcove-broker");
  const state = join(root, "var/lib/alcove-host-pull");
  mkdirSync(served, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(join(broker, "trees", DEPLOYED), { recursive: true });
  symlinkSync(`trees/${DEPLOYED}`, join(broker, "src"));
  writeFileSync(join(state, "deployed"), `${DEPLOYED}\n`);
  writeFileSync(join(root, "api.mjs"), API_FAKE);
  const head = `F='${root}'`;
  writeStub(join(bin, "git"), `${head}\n${GIT_STUB}`);
  writeStub(join(bin, "curl"), `${head}\n${CURL_STUB}`);
  writeStub(join(bin, "cosign"), `${head}\n${COSIGN_STUB}`);
  writeStub(join(bin, "npm"), `${head}\n${NPM_STUB}`);
  writeStub(
    join(bin, "systemctl"),
    `${head}\nprintf 'systemctl %s\\n' "$*" >> "$F/calls"`,
  );
  writeStub(join(bin, "timeout"), `${head}\n${TIMEOUT_STUB}`);
  writeStub(
    join(bin, "chown"),
    `${head}\nprintf 'chown %s\\n' "$*" >> "$F/calls"`,
  );
  writeStub(
    join(bin, "id"),
    `if [ "$1" = -u ]; then cat '${root}/uid' 2>/dev/null || echo 0; else exec /usr/bin/id "$@"; fi`,
  );
  for (const [path, body] of Object.entries(TREE_STUBS)) {
    for (const tree of ["remote", `opt/alcove-broker/trees/${DEPLOYED}`]) {
      writeStub(join(root, tree, path), `${head}\n${body}`);
    }
  }
  writeFileSync(join(root, "remote/package.json"), "{}\n");
  writeFileSync(join(root, "tip"), TIP);
  writeFileSync(join(root, "signed-for"), TIP);
  const runs = (list) =>
    writeFileSync(join(root, "runs.json"), workflowRuns(list));
  runs([...GREEN, ...NOT_GATING]);
  buildArchive(root, join(served, ARCHIVE));
  writeFileSync(join(served, BUNDLE), '{"fixture":"bundle"}\n');

  const set = (name, value = "") => writeFileSync(join(root, name), value);
  const unset = (name) => rmSync(join(root, name));
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    ALCOVE_HOST_PULL_INSTALL_ROOT: root,
  };
  const record = () => {
    const statusPath = join(state, "status");
    return existsSync(statusPath)
      ? Object.fromEntries(
          readFileSync(statusPath, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => line.split(/=(.*)/s).slice(0, 2)),
        )
      : undefined;
  };
  const marker = () => {
    const path = join(state, "deployed");
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };
  const createdPath = join(state, "created-trees");
  const createdTrees = () =>
    existsSync(createdPath)
      ? readFileSync(createdPath, "utf8").split("\n").filter(Boolean).sort()
      : [];
  // main moves to the commit, with its push runs green and its build published
  // and signed for it.
  const publish = (commit) => {
    writeFileSync(join(root, "tip"), commit);
    writeFileSync(join(root, "signed-for"), commit);
    runs(GREEN.map((run) => ({ ...run, head_sha: commit })));
    const archive = `alcove-broker-core-${commit}.tar.gz`;
    buildArchive(root, join(served, archive));
    writeFileSync(join(served, `${archive}.sigstore.json`), "{}\n");
  };
  const run = (script = join(PULL_DIR, "pull.sh")) => {
    writeFileSync(join(root, "calls"), "");
    const result = spawnSync(BASH, [script], { encoding: "utf8", env });
    const calls = readFileSync(join(root, "calls"), "utf8")
      .split("\n")
      .filter(Boolean);
    return { ...result, calls, record: record() };
  };
  return {
    root,
    broker,
    env,
    set,
    unset,
    runs,
    record,
    marker,
    created: createdTrees,
    listCreated: (lines) => writeFileSync(createdPath, lines.join("\n")),
    publish,
    serve: (name, text) => writeFileSync(join(served, name), text),
    unserve: (name) => rmSync(join(served, name)),
    archive: (options) => buildArchive(root, join(served, ARCHIVE), options),
    peakTrees: () =>
      existsSync(join(root, "tree-counts"))
        ? Math.max(
            ...readFileSync(join(root, "tree-counts"), "utf8")
              .split("\n")
              .filter(Boolean)
              .map(Number),
          )
        : 0,
    link: () => readlinkSync(join(broker, "src")),
    trees: () => readdirSync(join(broker, "trees")).sort(),
    run,
  };
};

const REPOSITORY_URL = "https://github.com/georgetown-mdi/alcove.git";
const runsUrl = (page) =>
  `https://api.github.com/repos/georgetown-mdi/alcove/actions/runs?head_sha=${TIP}&event=push&per_page=100&page=${page}`;
const RELEASE_URL =
  "https://github.com/georgetown-mdi/alcove/releases/download/broker-core-build";

const named = (calls, prefix) => calls.filter((c) => c.startsWith(prefix));
const downloads = (calls) =>
  named(calls, "curl ").filter((c) => c.includes(RELEASE_URL));

/** The run left the broker on DEPLOYED's tree with nothing staged beside it. */
const untouched = (h) => {
  expect(h.link()).toBe(`trees/${DEPLOYED}`);
  expect(h.trees()).toEqual([DEPLOYED]);
  expect(h.marker()).toBe(`${DEPLOYED}\n`);
  expect(named(h.lastCalls, "systemctl")).toEqual([]);
};

/** Every step of a run that stages and installs TIP, in order. */
const fullRun = (h) => {
  const work = join(h.root, "var/lib/alcove-host-pull/work");
  return [
    `git ls-remote --exit-code ${REPOSITORY_URL} refs/heads/main`,
    runsUrl(1),
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
    "npm ci --no-audit --no-fund --ignore-scripts --workspace packages/peerjs-broker in ",
    "chown -R 0:0 ",
    ...installs(TIP),
  ];
};

/** Restarting the broker on a commit's tree, then the tree's three scripts. */
const installs = (commit) => [
  "systemctl try-restart alcove-broker.service",
  `broker-install trees/${commit}`,
  `relay-install trees/${commit}`,
  `verify trees/${commit}`,
];

const expectSteps = (calls, steps) => {
  expect(calls).toHaveLength(steps.length);
  steps.forEach((step, index) => expect(calls[index]).toContain(step));
};
const expectFullRun = (h, calls) => expectSteps(calls, fullRun(h));

const outcome = (h, name, status) => {
  const r = h.run();
  h.lastCalls = r.calls;
  expect(r.status, r.stderr).toBe(status);
  expect(r.record?.outcome, r.stderr).toBe(name);
  expect(r.stderr).toContain(`${name}: ${r.record.reason}`);
  expect(existsSync(join(h.root, "var/lib/alcove-host-pull/work"))).toBe(false);
  return r;
};

// pull.sh runs on a Linux systemd host: it takes util-linux flock, ionice and
// setsid and GNU sha256sum, and the timeout stub above execs GNU timeout from
// /usr/bin, none of which macOS has.
const describeOnScriptHost = describe.skipIf(process.platform !== "linux");

describeOnScriptHost("pull.sh", () => {
  it("installs a green, signed tip in a new tree, then both installs, and records it", () => {
    const h = host();
    const r = outcome(h, "updated", 0);
    expect(r.record).toMatchObject({
      deployed_commit: TIP,
      linked_commit: TIP,
      main_commit: TIP,
      reason: `deployed ${TIP}`,
    });
    expect(r.record.time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(r.stderr).toContain(`every push run on ${TIP} succeeded (4)`);
    expect(h.marker()).toBe(`${TIP}\n`);
    expect(
      lstatSync(join(h.root, "var/lib/alcove-host-pull/deployed")).mode & 0o777,
    ).toBe(0o644);
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

    expectFullRun(h, r.calls);
    for (const call of named(r.calls, "curl ")) {
      expect(call).toContain("--proto =https --proto-redir =https");
    }
  });

  it("installs the broker workspace without running any package's install scripts", () => {
    const h = host();
    const r = outcome(h, "updated", 0);
    const installs = named(r.calls, "npm ");
    expect(installs).toHaveLength(1);
    expect(installs[0].split(" ")).toContain("--ignore-scripts");
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
      linked_commit: DEPLOYED,
      main_commit: DEPLOYED,
    });
    expect(r.calls).toEqual([
      `git ls-remote --exit-code ${REPOSITORY_URL} refs/heads/main`,
    ]);
    untouched(h);
  });

  it("installs again when the marker names the tip and the link does not", () => {
    const h = host();
    h.set("var/lib/alcove-host-pull/deployed", `${TIP}\n`);
    outcome(h, "updated", 0);
    expect(h.link()).toBe(`trees/${TIP}`);
  });

  it("goes on past a failed scheduled run, a Dependabot run and another commit's run", () => {
    const h = host();
    const r = outcome(h, "updated", 0);
    expect(named(r.calls, "curl ")[0]).toContain("event=push");
    expect(r.stderr).not.toContain("Nightly");
  });

  it.each([
    [
      "a push run has not completed",
      [
        ...GREEN,
        workflowRun("Native Addon (Alpine/musl)", {
          head_branch: "staging",
          status: "in_progress",
          conclusion: null,
        }),
      ],
      "CI has not finished on",
      "Native Addon (Alpine/musl) (staging)",
    ],
    ["no push run has started", NOT_GATING, "no push run has reported", ""],
  ])("skips the day when %s", (_, runs, reason, name) => {
    const h = host();
    h.runs(runs);
    const r = outcome(h, "skipped", 0);
    expect(r.record.reason).toContain(reason);
    expect(r.record.reason).toContain(name);
    expect(r.record.main_commit).toBe(TIP);
    expect(downloads(r.calls)).toEqual([]);
    untouched(h);
  });

  it("refuses a tip with a push run that did not succeed, even beside a pending one", () => {
    const h = host();
    h.runs([
      ...GREEN,
      ...NOT_GATING,
      workflowRun("CLI Build and Test", { conclusion: "failure" }),
      workflowRun("Static Checks", { conclusion: "cancelled" }),
      workflowRun("CodeQL", { head_branch: "staging", conclusion: "neutral" }),
      workflowRun("Image Smoke", { status: "queued", conclusion: null }),
    ]);
    const r = outcome(h, "refused", 1);
    expect(r.record.reason).toContain(
      "CLI Build and Test (main), Static Checks (main), CodeQL (staging)",
    );
    expect(r.record.reason).not.toContain("Image Smoke");
    expect(r.record.reason).not.toContain("Nightly");
    expect(downloads(r.calls)).toEqual([]);
    untouched(h);
  });

  it("reads every page of push runs, and refuses a failure on the last", () => {
    const h = host();
    const many = Array.from({ length: 230 }, (_, index) =>
      workflowRun(`Run ${index}`),
    );
    h.runs(many);
    const green = outcome(h, "updated", 0);
    expect(named(green.calls, "curl ").slice(0, 3)).toEqual(
      [1, 2, 3].map((page) => expect.stringContaining(runsUrl(page))),
    );
    expect(green.stderr).toContain("succeeded (230)");

    const h2 = host();
    many[229] = workflowRun("Run 229", { conclusion: "failure" });
    h2.runs(many);
    const red = outcome(h2, "refused", 1);
    expect(red.record.reason).toContain("Run 229 (main)");
    untouched(h2);
  });

  it("fails on a commit with more push runs than ten pages hold", () => {
    const h = host();
    h.runs(
      Array.from({ length: 1001 }, (_, index) => workflowRun(`Run ${index}`)),
    );
    const r = outcome(h, "failed", 1);
    expect(r.record.reason).toContain(
      "more push runs than 10 pages of 100 hold",
    );
    expect(named(r.calls, "curl ")).toHaveLength(10);
    untouched(h);
  });

  it.each([
    ["an answer that is not JSON", "<html>"],
    [
      "an answer listing a run of another event",
      JSON.stringify({
        total_count: 1,
        workflow_runs: [
          { id: 1, ...workflowRun("Nightly", { event: "schedule" }) },
        ],
      }),
    ],
    [
      "an answer short of its total_count",
      JSON.stringify({ total_count: 3, workflow_runs: [] }),
    ],
  ])("fails on %s", (_, body) => {
    const h = host();
    h.serve("runs", body);
    const r = outcome(h, "failed", 1);
    expect(r.record.reason).toContain("were not read");
    expect(downloads(r.calls)).toEqual([]);
    untouched(h);
  });

  it("fails when GitHub refuses the workflow-runs read", () => {
    const h = host();
    h.serve("runs.code", "403");
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

  describe("when the tip's installs fail", () => {
    // The calls a run makes up to the step that failed at the tip.
    const upTo = (h, failed) => {
      const steps = fullRun(h);
      return steps.slice(
        0,
        steps.findIndex((step) => step === `${failed} trees/${TIP}`) + 1,
      );
    };

    it.each([
      ["broker-install", "infra/broker/install.sh failed"],
      ["relay-install", "infra/relay/install.sh or its verify.sh failed"],
      ["verify", "infra/relay/install.sh or its verify.sh failed"],
    ])(
      "rolls back after a failed %s: the deployed commit's tree, both installs, and the tip's tree removed",
      (failed, reason) => {
        const h = host();
        h.set(`fail-${failed}-${TIP}`);
        const r = outcome(h, "rolled-back", 1);
        expect(r.record).toMatchObject({
          deployed_commit: DEPLOYED,
          linked_commit: DEPLOYED,
          main_commit: TIP,
          reason: `${reason} at ${TIP}; rolled back to ${DEPLOYED}`,
        });
        expectSteps(r.calls, [...upTo(h, failed), ...installs(DEPLOYED)]);
        expect(h.link()).toBe(`trees/${DEPLOYED}`);
        expect(h.marker()).toBe(`${DEPLOYED}\n`);
        expect(h.trees()).toEqual([DEPLOYED]);
        expect(h.created()).toEqual([]);
      },
    );

    it("cuts off an install script that hangs and rolls back", () => {
      const h = host();
      h.env.ALCOVE_HOST_PULL_INSTALL_TIMEOUT = "1";
      h.set(`hang-relay-install-${TIP}`);
      const r = outcome(h, "rolled-back", 1);
      expect(r.record.reason).toBe(
        `infra/relay/install.sh or its verify.sh failed at ${TIP}; rolled back to ${DEPLOYED}`,
      );
      expect(h.link()).toBe(`trees/${DEPLOYED}`);
      expect(h.trees()).toEqual([DEPLOYED]);
    });

    it.each([
      ["the host's timeout", false],
      ["a timeout whose signals reach the script alone", true],
    ])(
      "kills an install script that ignores TERM, and its children, under %s, and rolls back",
      (_label, scriptOnlyKill) => {
        const h = host();
        h.env.ALCOVE_HOST_PULL_INSTALL_TIMEOUT = "1";
        h.env.ALCOVE_HOST_PULL_KILL_AFTER = "1";
        h.set(`deaf-relay-install-${TIP}`);
        if (scriptOnlyKill) h.set("script-only-kill");
        const started = Date.now();
        outcome(h, "rolled-back", 1);
        expect(Date.now() - started).toBeLessThan(20000);
        expect(h.link()).toBe(`trees/${DEPLOYED}`);
      },
    );

    it.each([
      ["unset", undefined, DEFAULT_BOUND],
      ["0", "0", DEFAULT_BOUND],
      ["abc", "abc", DEFAULT_BOUND],
      ["larger than the default", String(DEFAULT_BOUND + 1), DEFAULT_BOUND],
      ["a smaller positive integer", "7", 7],
    ])("reads the install bound override %s", (_label, value, expected) => {
      const h = host();
      if (value !== undefined) h.env.ALCOVE_HOST_PULL_INSTALL_TIMEOUT = value;
      outcome(h, "updated", 0);
      const bounds = readFileSync(join(h.root, "timeouts"), "utf8")
        .split("\n")
        .filter((l) => l.includes("install.sh"));
      expect(bounds).toHaveLength(2);
      for (const line of bounds) {
        expect(line).toMatch(new RegExp(`^-k 30 ${expected} `));
      }
    });

    it("records rollback-failed when the deployed commit's installs fail too, and touches nothing further", () => {
      const h = host();
      h.set(`fail-broker-install-${TIP}`);
      h.set(`fail-relay-install-${DEPLOYED}`);
      const r = outcome(h, "rollback-failed", 1);
      expect(r.record).toMatchObject({
        deployed_commit: DEPLOYED,
        linked_commit: DEPLOYED,
        main_commit: TIP,
        reason:
          `infra/broker/install.sh failed at ${TIP}; rolling back to ${DEPLOYED}` +
          ` failed: infra/relay/install.sh or its verify.sh failed at ${DEPLOYED}`,
      });
      expectSteps(r.calls, [
        ...upTo(h, "broker-install"),
        ...installs(DEPLOYED).slice(0, 3),
      ]);
      expect(h.marker()).toBe(`${DEPLOYED}\n`);
      expect(h.trees()).toEqual([TIP, DEPLOYED]);
      expect(h.created()).toEqual([TIP]);
    });

    it.each([
      [
        "the deployed marker is absent",
        (h) => h.unset("var/lib/alcove-host-pull/deployed"),
        "names no commit other than",
        "",
      ],
      [
        "the deployed marker names the tip",
        (h) => h.set("var/lib/alcove-host-pull/deployed", `${TIP}\n`),
        "names no commit other than",
        TIP,
      ],
      [
        "the marked commit has no tree",
        (h) => h.set("var/lib/alcove-host-pull/deployed", `${OTHER}\n`),
        `${OTHER}, the deployed commit's tree, is missing`,
        OTHER,
      ],
      [
        "the marked commit's tree is a link",
        (h) => {
          h.set("var/lib/alcove-host-pull/deployed", `${OTHER}\n`);
          symlinkSync(DEPLOYED, join(h.broker, "trees", OTHER));
        },
        `${OTHER}, the deployed commit's tree, is missing`,
        OTHER,
      ],
    ])(
      "does not roll back when %s, and leaves the tip linked",
      (_, make, reason, marked) => {
        const h = host();
        make(h);
        h.set(`fail-relay-install-${TIP}`);
        const r = outcome(h, "failed", 1);
        expect(r.record).toMatchObject({
          deployed_commit: marked,
          linked_commit: TIP,
        });
        expect(r.record.reason).toContain(
          `infra/relay/install.sh or its verify.sh failed at ${TIP}; `,
        );
        expect(r.record.reason).toContain(reason);
        expectSteps(r.calls, upTo(h, "verify").slice(0, -1));
        expect(h.link()).toBe(`trees/${TIP}`);
        expect(h.trees()).toContain(TIP);
        expect(h.trees()).toContain(DEPLOYED);
      },
    );

    it("tries the tip again on the next run, and updates once its installs pass", () => {
      const h = host();
      h.set(`fail-verify-${TIP}`);
      outcome(h, "rolled-back", 1);
      const again = outcome(h, "rolled-back", 1);
      expectSteps(again.calls, [...upTo(h, "verify"), ...installs(DEPLOYED)]);

      h.unset(`fail-verify-${TIP}`);
      const passed = outcome(h, "updated", 0);
      expectFullRun(h, passed.calls);
      expect(h.marker()).toBe(`${TIP}\n`);
      expect(h.trees()).toEqual([TIP, DEPLOYED]);
    });
  });

  describe("the trees it keeps", () => {
    const C1 = "1".repeat(40);
    const C2 = "2".repeat(40);
    const C3 = "3".repeat(40);
    const update = (h, commit) => {
      h.publish(commit);
      const r = outcome(h, "updated", 0);
      expect(h.link()).toBe(`trees/${commit}`);
      expect(h.marker()).toBe(`${commit}\n`);
      return r;
    };

    it("keeps exactly the deployed tree and the one before it over three updates", () => {
      const h = host();
      h.listCreated([DEPLOYED]);
      update(h, C1);
      expect(h.trees()).toEqual([C1, DEPLOYED]);
      const r = update(h, C2);
      expect(r.stderr).toContain(
        `removed ${join(h.broker, "trees", DEPLOYED)}`,
      );
      expect(h.trees()).toEqual([C1, C2]);
      update(h, C3);
      expect(h.trees()).toEqual([C2, C3]);
      expect(h.created()).toEqual([C2, C3]);
    });

    it("never removes a tree it did not create", () => {
      const h = host();
      update(h, C1);
      update(h, C2);
      update(h, C3);
      expect(h.trees()).toEqual([C2, C3, DEPLOYED]);
      expect(h.created()).toEqual([C2, C3]);
    });

    it("acts only on whole commits in its record, never on a path or pattern", () => {
      const h = host();
      const beside = join(h.broker, "beside");
      mkdirSync(beside);
      mkdirSync(join(h.broker, "trees", OTHER));
      h.listCreated(["../beside", "*", "", ".", OTHER.slice(1), "/"]);
      update(h, C1);
      update(h, C2);
      update(h, C3);
      expect(existsSync(beside)).toBe(true);
      expect(h.trees()).toEqual([C2, C3, OTHER, DEPLOYED].sort());
    });

    it("keeps the tree a rollback returned to, and removes the one before it", () => {
      const h = host();
      update(h, C1);
      update(h, C2);
      h.publish(C3);
      h.set(`fail-broker-install-${C3}`);
      const r = outcome(h, "rolled-back", 1);
      expect(r.record.linked_commit).toBe(C2);
      expect(h.trees()).toEqual([C2, DEPLOYED]);
      expect(h.created()).toEqual([C2]);
    });

    it("never has more than two pull-created trees on disk, over updates and failed runs", () => {
      const h = host();
      const C4 = "4".repeat(40);
      h.listCreated([DEPLOYED]);
      update(h, C1);
      update(h, C2);
      h.publish(C3);
      h.set(`fail-broker-install-${C3}`);
      h.set(`fail-broker-install-${C2}`);
      outcome(h, "rollback-failed", 1);
      expect(h.trees()).toEqual([C2, C3]);
      h.unset(`fail-broker-install-${C3}`);
      h.unset(`fail-broker-install-${C2}`);
      update(h, C3);
      h.publish(C4);
      h.set(`fail-verify-${C4}`);
      outcome(h, "rolled-back", 1);
      expect(h.trees()).toEqual([C3]);
      expect(h.peakTrees()).toBeLessThanOrEqual(2);
    });
  });

  it("checks, downloads, verifies and stages a fresh tree on the run after a failed install", () => {
    const h = host();
    h.unset("var/lib/alcove-host-pull/deployed");
    h.set(`fail-verify-${TIP}`);
    outcome(h, "failed", 1);
    const leftover = join(h.broker, "trees", TIP, "left-by-the-failed-run");
    writeFileSync(leftover, "");

    const again = outcome(h, "failed", 1);
    expect(again.record).toMatchObject({
      deployed_commit: "",
      linked_commit: TIP,
      main_commit: TIP,
    });
    expect(again.record.reason).toContain("verify.sh failed at");
    expectFullRun(h, again.calls);
    expect(existsSync(leftover)).toBe(false);
    expect(h.trees()).toEqual([TIP, DEPLOYED]);

    h.unset(`fail-verify-${TIP}`);
    const passed = outcome(h, "updated", 0);
    expect(passed.record).toMatchObject({
      deployed_commit: TIP,
      linked_commit: TIP,
    });
    expect(h.marker()).toBe(`${TIP}\n`);
    expectFullRun(h, passed.calls);

    outcome(h, "unchanged", 0);
  });

  describe("a tree placed by hand at the tip's path, its build matching its SHA256SUMS", () => {
    // Linked, with an install script of its own that the pull must never run.
    const handPlaced = () => {
      const h = host();
      const tree = join(h.broker, "trees", TIP);
      const dist = join(tree, "packages/core/dist");
      mkdirSync(dist, { recursive: true });
      const build = "export {};\n";
      writeFileSync(join(dist, "untrusted-text.esm.js"), build);
      writeFileSync(
        join(dist, "SHA256SUMS"),
        `${sha256(build)}  untrusted-text.esm.js\n`,
      );
      for (const dir of ["broker", "relay"]) {
        writeStub(
          join(tree, "infra", dir, "install.sh"),
          `printf 'hand-placed ${dir}\\n' >> '${h.root}/calls'`,
        );
      }
      rmSync(join(h.broker, "src"));
      symlinkSync(`trees/${TIP}`, join(h.broker, "src"));
      return { h, tree };
    };

    it("is replaced by a fresh tree through every step", () => {
      const { h, tree } = handPlaced();
      const r = outcome(h, "updated", 0);
      expectFullRun(h, r.calls);
      expect(named(r.calls, "hand-placed")).toEqual([]);
      expect(
        readFileSync(
          join(tree, "packages/core/dist/untrusted-text.esm.js"),
          "utf8",
        ),
      ).toContain("shared2.esm.js");
      expect(h.trees()).toEqual([TIP, DEPLOYED]);
    });

    it("is not installed when CI did not pass on the tip", () => {
      const { h } = handPlaced();
      h.runs([
        ...GREEN,
        workflowRun("Static Checks", { conclusion: "failure" }),
      ]);
      const r = outcome(h, "refused", 1);
      expect(named(r.calls, "hand-placed")).toEqual([]);
      expect(named(r.calls, "systemctl")).toEqual([]);
      expect(h.marker()).toBe(`${DEPLOYED}\n`);
    });
  });

  it("records failed when a signal stops it during a long step", async () => {
    const h = host();
    h.set("slow-npm");
    const child = spawn(BASH, [join(PULL_DIR, "pull.sh")], {
      env: h.env,
      detached: true,
      stdio: "ignore",
    });
    const exited = new Promise((done) => child.on("exit", done));
    try {
      const deadline = Date.now() + 10_000;
      while (!existsSync(join(h.root, "npm-started"))) {
        expect(Date.now()).toBeLessThan(deadline);
        await new Promise((done) => setTimeout(done, 20));
      }
      // systemd stops a unit by signalling its whole control group.
      process.kill(-child.pid, "SIGTERM");
      expect(await exited).toBe(1);
    } finally {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        // The group has already exited.
      }
    }
    expect(h.record()).toMatchObject({
      outcome: "failed",
      reason: "pull.sh was stopped by a signal",
      deployed_commit: DEPLOYED,
      main_commit: TIP,
    });
    expect(h.link()).toBe(`trees/${DEPLOYED}`);
    expect(existsSync(join(h.root, "var/lib/alcove-host-pull/work"))).toBe(
      false,
    );
  });

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
    expect(r.record).toMatchObject({
      deployed_commit: DEPLOYED,
      linked_commit: "",
    });
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
    for (const source of [
      join(PULL_DIR, "pull.sh"),
      join(PULL_DIR, "workflow-runs.mjs"),
      join(repo, "infra/relay/maintenance-lock.sh"),
    ]) {
      const installed = join(h.root, "opt/alcove-host-pull", basename(source));
      expect(readFileSync(installed, "utf8")).toBe(
        readFileSync(source, "utf8"),
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

  // pull.sh rolls back on a failed verify.sh only through the relay install's
  // exit status: its last command must be verify.sh, with nothing after it.
  it("runs verify.sh as infra/relay/install.sh's last command", () => {
    const lines = readFileSync(join(repo, "infra/relay/install.sh"), "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));
    expect(lines.at(-1)).toMatch(/^(\w+="[^"]*" )*"\$LIBEXEC\/verify\.sh"$/);
  });

  it.each([
    [BASH, "-n", "pull.sh"],
    [BASH, "-n", "install.sh"],
    [process.execPath, "--check", "workflow-runs.mjs"],
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

  it("does not catch up at boot, outside the schedule", () => {
    expect(
      setting(read("infra/host-pull/alcove-host-pull.timer"), "Persistent"),
    ).toBe("false");
  });

  it("runs the installed copy under the maintenance lock, after the OS update", () => {
    const service = read("infra/host-pull/alcove-host-pull.service");
    expect(setting(service, "ExecStart")).toMatch(
      /^\/opt\/alcove-host-pull\/maintenance-lock\.sh \d+ \/opt\/alcove-host-pull\/pull\.sh$/,
    );
    expect(setting(service, "After").split(/\s+/)).toContain(
      "alcove-relay-os-update.service",
    );
  });
});
