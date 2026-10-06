import { Readable } from "node:stream";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { MAX_TRANSFORM_PATTERN_LENGTH } from "@alcove/core";

import { MAX_COVERAGE_BODY_BYTES } from "@jobs/workInputs";

import { route as CoverageRoute } from "../../../server/console/routes/inputs/coverage";
import { route as InputsRoute } from "../../../server/console/routes/inputs/index";
import { route as ProfileRoute } from "../../../server/console/routes/inputs/profile";
import { route as SamplesRoute } from "../../../server/console/routes/inputs/samples";

import { STUB_CLI_PATH, trackScratchDirs } from "../../utils/jobFixtures";

import type { Standardization } from "@alcove/core";

const { scratchDir, cleanup: removeScratchDirs } = trackScratchDirs();

const FIXTURE_CSV =
  "ssn,last_name,date_of_birth\n111223333,Public,1990-01-02\n222,Cole,1985-11-30\n";

const TAB_FIXTURE_CSV = FIXTURE_CSV.replaceAll(",", "\t");

function inputDirWithTabFixture(name = "tabbed.csv"): {
  dir: string;
  name: string;
} {
  const dir = scratchDir("inputs");
  fs.writeFileSync(path.join(dir, name), TAB_FIXTURE_CSV);
  return { dir, name };
}

function inputDirWithFixture(name = "input.csv"): {
  dir: string;
  name: string;
} {
  const dir = scratchDir("inputs");
  fs.writeFileSync(path.join(dir, name), FIXTURE_CSV);
  return { dir, name };
}

const STANDARDIZATION: Standardization = [
  {
    output: "last_name",
    input: "last_name",
    steps: [{ function: "to_upper_case" }],
  },
];

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  removeScratchDirs();
  (globalThis as { jobInputDirConfig?: unknown }).jobInputDirConfig = undefined;
});

type Handlers = Record<
  string,
  (ctx: { request: Request; params: Record<string, string> }) => unknown
>;

function handlersOf(route: { handlers: unknown }): Handlers {
  const handlers = route.handlers;
  if (typeof handlers !== "object" || handlers === null)
    throw new Error("route exposes no plain handlers object");
  return handlers as Handlers;
}

/** Enable the job API (a real data root) and, optionally, a distinct input
 * directory. Returns the data root so a test can exercise the flat single-folder
 * layout by placing inputs directly under it. */
function enable(options: { inputDir?: string } = {}): string {
  const dataRoot = scratchDir("data");
  // The job API is enabled only in a console build, so the input routes gate on
  // the console profile alongside the data root.
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
  vi.stubEnv("JOB_DATA_ROOT", dataRoot);
  vi.stubEnv("JOB_CLI_BINARY", STUB_CLI_PATH);
  if (options.inputDir !== undefined)
    vi.stubEnv("JOB_INPUT_DIR", options.inputDir);
  return dataRoot;
}

function profileRequest(name: string, delimiter?: string): Request {
  const query =
    `name=${encodeURIComponent(name)}` +
    (delimiter === undefined
      ? ""
      : `&delimiter=${encodeURIComponent(delimiter)}`);
  return new Request(
    `http://localhost/api/jobs/inputs/profile?${query}`,
    // A synthetic Request sets no Host; the gate's loopback allowlist needs one.
    { headers: { host: "localhost" } },
  );
}

function coverageRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/jobs/inputs/coverage", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "localhost",
      ...headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function coverageBody(
  name: string,
  standardization = STANDARDIZATION,
  csvDelimiter?: string,
) {
  return {
    name,
    standardization,
    ...(csvDelimiter !== undefined ? { csvDelimiter } : {}),
  };
}

async function listing(): Promise<Response> {
  return (await handlersOf(InputsRoute).GET({
    request: new Request("http://localhost/api/jobs/inputs", {
      headers: { host: "localhost" },
    }),
    params: {},
  })) as Response;
}

async function profile(name: string, delimiter?: string): Promise<Response> {
  return (await handlersOf(ProfileRoute).GET({
    request: profileRequest(name, delimiter),
    params: {},
  })) as Response;
}

async function coverage(body: unknown): Promise<Response> {
  return (await handlersOf(CoverageRoute).POST({
    request: coverageRequest(body),
    params: {},
  })) as Response;
}

describe("gating parity: every route is dark when disabled", () => {
  test("all three routes are 404 when JOB_DATA_ROOT is unset", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    expect((await listing()).status).toBe(404);
    expect((await profile("input.csv")).status).toBe(404);
    expect((await coverage(coverageBody("input.csv"))).status).toBe(404);
  });
});

describe("GET /api/jobs/inputs", () => {
  test("defaults the listing to JOB_DATA_ROOT when JOB_INPUT_DIR is unset", async () => {
    // The flat single-folder layout: only the data root is mounted, so the input
    // listing reads out of it and reports configured.
    const dataRoot = enable();
    fs.writeFileSync(path.join(dataRoot, "input.csv"), FIXTURE_CSV);
    const response = await listing();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      configured: boolean;
      readable: boolean;
      files: Array<{ name: string }>;
    };
    expect(body.configured).toBe(true);
    expect(body.readable).toBe(true);
    expect(body.files.map((file) => file.name)).toEqual(["input.csv"]);
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  test("reports the unreadable-mount state distinctly from empty", async () => {
    enable({ inputDir: path.join(os.tmpdir(), "alcove-no-such-mount-xyz") });
    const response = await listing();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      readable: false,
      files: [],
    });
  });

  test("lists the mounted input files", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = await listing();
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      configured: boolean;
      files: Array<{ name: string }>;
    };
    expect(body.configured).toBe(true);
    expect(body.files.map((file) => file.name)).toEqual(["input.csv"]);
  });
});

describe("GET /api/jobs/inputs/profile", () => {
  test("404 for a name absent from the data-root default", async () => {
    enable();
    expect((await profile("input.csv")).status).toBe(404);
  });

  test("profiles a mounted file", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = await profile("input.csv");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rowCount: number };
    expect(body.rowCount).toBe(2);
  });

  test("404 for an unknown name", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    expect((await profile("missing.csv")).status).toBe(404);
  });

  test("404 for an inadmissible name", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    expect((await profile("../escape")).status).toBe(404);
  });

  test("reads the file by the delimiter the request names", async () => {
    // The word is one of the spellings a party may write for the character, so
    // the parameter reaches the parse resolved -- a raw "tab" is no delimiter
    // any parser splits on, and the header would come back as one column.
    const { dir, name } = inputDirWithTabFixture();
    enable({ inputDir: dir });
    const response = await profile(name, "tab");
    expect(response.status).toBe(200);
    const body = (await response.json()) as { columns: Array<string> };
    expect(body.columns).toEqual(["ssn", "last_name", "date_of_birth"]);
  });

  test("reads the file with commas when the request names no delimiter", async () => {
    const { dir, name } = inputDirWithTabFixture();
    enable({ inputDir: dir });
    const body = (await (await profile(name)).json()) as {
      columns: Array<string>;
    };
    expect(body.columns).toHaveLength(1);
  });

  test("400 for a delimiter outside the accepted set", async () => {
    // The refusal is a bare 400: this route answers with no body at all, and the
    // field the client corrects is named by the schema itself (jobIntent tests).
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    for (const refused of ['"', "||", ""])
      expect((await profile(name, refused)).status).toBe(400);
  });

  test("400 with the not_a_csv code for a file with no columns", async () => {
    const dir = scratchDir("inputs");
    fs.writeFileSync(path.join(dir, "empty.csv"), "");
    enable({ inputDir: dir });
    const response = await profile("empty.csv");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "not_a_csv" });
  });

  test("400 with the parse_failed code on a read fault, leaking no path or bytes", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    const stream = new Readable({ read() {} });
    vi.spyOn(fs, "createReadStream").mockReturnValue(
      stream as unknown as fs.ReadStream,
    );
    const responsePromise = profile(name);
    // Let the parser attach its stream listeners before the read faults, so the error
    // flows through the parser rather than showing up as an uncaught 'error'.
    await new Promise((resolve) => setImmediate(resolve));
    const leak = `${dir}/${name}: EIO 111223333`;
    stream.destroy(new Error(leak));
    const response = await responsePromise;
    expect(response.status).toBe(400);
    const raw = await response.text();
    expect(JSON.parse(raw)).toEqual({ error: "parse_failed" });
    // The response body contains the code only -- never the mounted path or cell bytes
    // the underlying read error embeds.
    expect(raw).not.toContain(dir);
    expect(raw).not.toContain("111223333");
  });
});

describe("POST /api/jobs/inputs/coverage", () => {
  test("404 for a name absent from the data-root default", async () => {
    enable();
    expect((await coverage(coverageBody("input.csv"))).status).toBe(404);
  });

  test("computes coverage for a mounted file", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = await coverage(coverageBody("input.csv"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { rates: Array<unknown> };
    expect(Array.isArray(body.rates)).toBe(true);
  });

  test("404 for an unknown name", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    expect((await coverage(coverageBody("missing.csv"))).status).toBe(404);
  });

  test("sweeps by the delimiter the body names", async () => {
    // The sweep advises a run that reads the same file, so the body's delimiter
    // reaches the parse resolved as the profile's does: read with commas, the
    // standardized column is not in the file at all and its coverage collapses.
    const { dir, name } = inputDirWithTabFixture();
    enable({ inputDir: dir });
    const rateFor = async (csvDelimiter?: string) => {
      const response = await coverage(
        coverageBody(name, STANDARDIZATION, csvDelimiter),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        rates: Array<{ output: string; produced: number }>;
      };
      return body.rates.find((rate) => rate.output === "last_name")?.produced;
    };
    expect(await rateFor("tab")).toBe(2);
    expect(await rateFor()).toBe(0);
  });

  test("400 for a csvDelimiter outside the accepted set", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    for (const refused of ['"', "||", ""])
      expect(
        (await coverage(coverageBody(name, STANDARDIZATION, refused))).status,
      ).toBe(400);
  });

  test("400 on a malformed body", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    expect((await coverage("not json")).status).toBe(400);
  });

  test("400 on an unknown field (strict schema)", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    expect(
      (
        await coverage({
          name: "input.csv",
          standardization: STANDARDIZATION,
          sizeBytes: 42,
        })
      ).status,
    ).toBe(400);
  });

  test("400 on an over-length compiled pattern (RE2 compile bound)", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const response = await coverage({
      name: "input.csv",
      standardization: [
        {
          input: "last_name",
          output: "last_name",
          steps: [
            {
              function: "replace_regex",
              params: {
                pattern: "a".repeat(MAX_TRANSFORM_PATTERN_LENGTH + 1),
                replacement: "",
              },
            },
          ],
        },
      ],
    });
    expect(response.status).toBe(400);
  });

  test("413 on an oversized body", async () => {
    const { dir } = inputDirWithFixture();
    enable({ inputDir: dir });
    const huge = "x".repeat(MAX_COVERAGE_BODY_BYTES + 1);
    const response = await coverage({
      name: "input.csv",
      standardization: [{ input: huge, output: "b", steps: [] }],
    });
    expect(response.status).toBe(413);
  });

  test("threads request.signal so an aborted request stops the sweep", async () => {
    const { dir, name } = inputDirWithFixture();
    enable({ inputDir: dir });
    const controller = new AbortController();
    const request = new Request("http://localhost/api/jobs/inputs/coverage", {
      method: "POST",
      headers: { "content-type": "application/json", host: "localhost" },
      body: JSON.stringify(coverageBody(name)),
      signal: controller.signal,
    });
    controller.abort();
    const response = (await handlersOf(CoverageRoute).POST({
      request,
      params: {},
    })) as Response;
    expect(response.status).toBe(499);
  });
});

async function addSamples(): Promise<Response> {
  return (await handlersOf(SamplesRoute).POST({
    request: new Request("http://localhost/api/jobs/inputs/samples", {
      method: "POST",
      headers: { host: "localhost" },
    }),
    params: {},
  })) as Response;
}

describe("POST /api/jobs/inputs/samples", () => {
  test("is 404 when the API is disabled", async () => {
    vi.stubEnv("JOB_DATA_ROOT", "");
    expect((await addSamples()).status).toBe(404);
  });

  test("writes the sample CSVs where the listing reads, and lists them", async () => {
    const dataRoot = enable();
    const response = await addSamples();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      files: [
        { name: "alcove-sample-inviter.csv", written: true },
        { name: "alcove-sample-partner.csv", written: true },
      ],
    });
    expect(fs.readdirSync(dataRoot).sort()).toEqual([
      "alcove-sample-inviter.csv",
      "alcove-sample-partner.csv",
    ]);
    const body = (await (await listing()).json()) as {
      files: Array<{ name: string }>;
    };
    expect(body.files.map((file) => file.name)).toEqual([
      "alcove-sample-inviter.csv",
      "alcove-sample-partner.csv",
    ]);
  });

  test("a cross-site browser request is refused before anything is written", async () => {
    const dataRoot = enable();
    const response = (await handlersOf(SamplesRoute).POST({
      request: new Request("http://localhost/api/jobs/inputs/samples", {
        method: "POST",
        headers: { host: "localhost", "sec-fetch-site": "cross-site" },
      }),
      params: {},
    })) as Response;
    expect(response.status).toBe(403);
    expect(fs.readdirSync(dataRoot)).toEqual([]);
  });

  test.skipIf(process.getuid?.() === 0)(
    "a folder the console cannot write into is a 409 naming no path",
    async () => {
      const inputDir = scratchDir("readonly-inputs");
      fs.chmodSync(inputDir, 0o500);
      enable({ inputDir });
      try {
        const response = await addSamples();
        expect(response.status).toBe(409);
        const text = await response.text();
        expect(JSON.parse(text)).toEqual({ error: "unwritable" });
        expect(text).not.toContain(inputDir);
      } finally {
        fs.chmodSync(inputDir, 0o700);
      }
    },
  );
});
