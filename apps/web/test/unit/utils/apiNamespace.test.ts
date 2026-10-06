import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { HOSTED_API_PREFIXES, withApiGuard } from "@utils/apiNamespace";
import { jobEmptyResponse } from "@jobs/gate";

// withApiGuard is what src/server.ts puts every request through ahead of the
// framework's handler. These cover the refusal in isolation, over the spellings
// of the /api prefix a router resolves to a route; whether this app's router
// still resolves them that way is what the integration matrix drives against
// the built server (apps/web/test/integration/apiNamespace.test.ts).

/** A route that records what reached it and answers the app document, which is
 * what the framework renders for a path no handler serves. */
function countingRoute(): {
  route: (request: Request) => Response;
  reached: Array<string>;
} {
  const reached: Array<string> = [];
  return {
    reached,
    route: (request) => {
      reached.push(new URL(request.url).pathname);
      return new Response("<!DOCTYPE html><html></html>", {
        status: 404,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    },
  };
}

function headerEntries(response: Response): Array<[string, string]> {
  return [...response.headers].sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

/** The observable shape of a response: what a probe comparing two paths reads,
 * down to the whole header set, so a header added to the job gate's refusal and
 * not to this one fails here. */
async function shapeOf(response: Response) {
  return {
    status: response.status,
    headers: headerEntries(response),
    body: await response.text(),
  };
}

async function answer(
  method: string,
  path: string,
): Promise<{ response: Response; reached: Array<string> }> {
  const { route, reached } = countingRoute();
  const response = await withApiGuard(route)(
    new Request(`http://127.0.0.1:3000${path}`, { method }),
  );
  return { response, reached };
}

/** The hosted deployment: no console profile, no data root, so the job API is
 * not enabled and the refusal applies. */
function hostedProfile(): void {
  vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "");
  vi.stubEnv("JOB_DATA_ROOT", "");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

/** Every spelling of the signaling broker's path a client writes, and the ones
 * only the refusal's own decoding reaches. The broker is a service of its own,
 * so none of them is served here on any profile. */
const BROKER_SPELLINGS: ReadonlyArray<[string, string]> = [
  ["GET", "/api/peerjs"],
  ["GET", "/api/peerjs/"],
  ["GET", "/api/peerjs/id"],
  ["GET", "/api/peerjs/id/"],
  ["GET", "/api/peerjs/peerjs/peers"],
  ["GET", "/api/peerjs?key=peerjs&id=probe&token=t"],
  ["GET", "/API/peerjs/id"],
  ["GET", "/%61pi/peerjs/id"],
  ["GET", "/api/PEERJS/id"],
  ["GET", "/api/%70eerjs/id"],
  ["GET", "/api/%2570eerjs/id"],
  ["GET", "/api//peerjs/id"],
  ["POST", "/api/peerjs/id"],
  ["OPTIONS", "/api/peerjs/id"],
];

describe("the /api refusal on a deployment without the job API", () => {
  beforeEach(hostedProfile);

  test("answers the job gate's own 404, header for header", async () => {
    const { response } = await answer("GET", "/api/jobs/slot");
    expect(await shapeOf(response)).toEqual(
      await shapeOf(jobEmptyResponse(404)),
    );
  });

  test("no job route runs for any spelling that reaches one", async () => {
    // The spellings measured to reach the job handler with no refusal ahead of
    // the router: the plain path, its trailing-slash form, and a case-varied
    // prefix. None may reach the route with the refusal in place.
    const reached: Array<string> = [];
    const { route } = countingRoute();
    const guarded = withApiGuard((request) => {
      reached.push(new URL(request.url).pathname);
      return route(request);
    });
    for (const path of [
      "/api/jobs/slot",
      "/api/nothing-here",
      "/api/jobs/slot/",
      "/API/jobs/slot",
    ]) {
      const response = await guarded(
        new Request(`http://127.0.0.1:3000${path}`),
      );
      expect(response.status).toBe(404);
    }
    expect(reached).toEqual([]);
  });

  test.each([
    ["GET", "/api"],
    ["GET", "/api/"],
    ["GET", "/api/nothing-here"],
    ["GET", "/api/nothing-here/"],
    ["GET", "/api//jobs/slot"],
    ["GET", "/api/jobs/inputs/coverage"],
    ["POST", "/api/nothing-here"],
    ["DELETE", "/api/jobs/slot"],
    ["HEAD", "/api/jobs/slot"],
    ["GET", "/API/jobs/slot"],
    ["GET", "/Api/jobs/slot"],
    ["GET", "/%61pi/jobs/slot"],
    ["GET", "/%41PI/jobs/slot"],
    ["GET", "/api/%6aobs/slot"],
    ["GET", "/api%2Fjobs/slot"],
    ["GET", "/api/%zz/%e0%a4%a5"],
    // The URL parser resolves this to /api/jobs/slot before the guard reads it,
    // so this row pins the resolved form. The target as written reaches the
    // entry only over a raw socket, which the integration matrix drives.
    ["GET", "/api/peerjs/%2e%2e/jobs/slot"],
    // Unlike the row above, the URL parser leaves this one alone (`%25`
    // decodes to `%`, not to a dot), so it reaches the guard as written; the
    // guard's own decode-and-resolve rounds reduce it to `..` and refuse it.
    ["GET", "/api/peerjs/%252e%252e/jobs/slot"],
    ["GET", "/api/%2570eerjs/id"],
    ["GET", "/api/PEERJS/id"],
    ["GET", "/api/%70eerjs/id"],
    ...BROKER_SPELLINGS,
  ])("refuses %s %s before the router", async (method, path) => {
    const { response, reached } = await answer(method, path);
    expect(reached).toEqual([]);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("");
  });

  test("refuses a double-encoded dot segment that leads into the namespace, which the guard's own resolution catches", async () => {
    // Neither the URL parser nor a single decode round reduces `%252e%252e` to
    // `..`, so only the guard's own repeated decode-and-resolve places this path
    // under /api.
    const { response, reached } = await answer(
      "GET",
      "/x/%252e%252e/api/jobs/slot",
    );
    expect(reached).toEqual([]);
    expect(response.status).toBe(404);
  });

  test.each([
    ["GET", "/"],
    ["GET", "/nothing-here"],
    ["GET", "/apiary"],
    ["GET", "/ap%69x/jobs"],
    ["GET", "/saved/"],
  ])("routes %s %s, outside the namespace", async (method, path) => {
    const { reached } = await answer(method, path);
    expect(reached).toHaveLength(1);
  });
});

describe("the /api refusal on the console profile with the job API enabled", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
    vi.stubEnv("JOB_DATA_ROOT", "/var/lib/alcove-jobs");
  });

  test.each([
    ["GET", "/api/jobs/slot"],
    ["GET", "/api/nothing-here"],
    ["GET", "/API/jobs/slot"],
  ])(
    "routes %s %s, leaving the per-route gate to answer",
    async (method, path) => {
      const { reached } = await answer(method, path);
      expect(reached).toHaveLength(1);
    },
  );

  test.each(BROKER_SPELLINGS)(
    "routes %s %s, which no job route answers, to the job routes",
    async (method, path) => {
      const { reached } = await answer(method, path);
      expect(reached).toHaveLength(1);
    },
  );

  test.each([
    ["GET", "/"],
    ["GET", "/nothing-here"],
    ["GET", "/peerjs/id"],
  ])("routes %s %s, outside the namespace", async (method, path) => {
    const { reached } = await answer(method, path);
    expect(reached).toHaveLength(1);
  });
});

describe("the /api refusal on the console profile with no data root", () => {
  beforeEach(() => {
    vi.stubEnv("VITE_DEPLOYMENT_PROFILE", "console");
    vi.stubEnv("JOB_DATA_ROOT", "");
  });

  test.each([...BROKER_SPELLINGS, ["GET", "/api/jobs/slot"]])(
    "refuses %s %s before the router",
    async (method, path) => {
      const { response, reached } = await answer(method, path);
      expect(reached).toEqual([]);
      expect(response.status).toBe(404);
    },
  );
});

describe("the hosted-only allowlist", () => {
  test("is empty, so the hosted deployment refuses the whole namespace", () => {
    expect(HOSTED_API_PREFIXES).toEqual([]);
  });
});
