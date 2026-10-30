import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  BUILD_OUTPUT,
  SITE_DEPLOY_WORKFLOW,
} from "./check-deploy-trigger-graph.mjs";
import {
  SECURITY_TXT_PATH,
  securityTxtUrl,
  servedProblems,
} from "./check-served-security-txt.mjs";
import {
  GITHUB_REPORTING,
  contacts,
  fields,
  securityPolicyContacts,
} from "./lib/securityTxt.mjs";
import { WORKFLOW_DIR, workflowDocument } from "./lib/workflows.mjs";

// The security.txt files (RFC 9116) the web app's build and the project site's
// serve. A hand-set Expires lapses with nothing to report it, so this fails
// RENEW_DAYS ahead of the date; it runs only when CI does, so a stretch with no
// pull request or push can still pass a lapse. Renewing is a new date in both
// files and a deploy of each site.

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const SECURITY_TXT_FILES = [
  "apps/web/public/.well-known/security.txt",
  "docs/.vitepress/public/.well-known/security.txt",
];

/**
 * The artifact uploads that carry each site's build to its deploy job. The
 * web app and the demo site upload the same build output, rebuilt between the
 * two. `excluded` names the hidden entries of the build left out.
 */
const SITE_UPLOADS = [
  {
    workflow: `${WORKFLOW_DIR}/web_build_and_test.yaml`,
    output: BUILD_OUTPUT,
    uploads: 2,
    excluded: [".vite"],
  },
  {
    workflow: SITE_DEPLOY_WORKFLOW,
    output: "docs/.vitepress/dist",
    uploads: 1,
    excluded: [],
  },
];

/** Days ahead of Expires at which the check fails, to leave time to deploy. */
const RENEW_DAYS = 45;

/** RFC 9116, 2.5.5: an Expires less than a year ahead. */
const MAX_DAYS_AHEAD = 366;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why an Expires value is not acceptable at `now`, or null when it is.
 * @param {string} value
 * @param {Date} now
 */
function expiresProblem(value, now) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(value)) {
    return `Expires ${value} is not an RFC 3339 UTC timestamp`;
  }
  const daysLeft = (Date.parse(value) - now.getTime()) / DAY_MS;
  if (Number.isNaN(daysLeft)) {
    return `Expires ${value} is not a real date`;
  }
  if (daysLeft < RENEW_DAYS) {
    return `Expires ${value} is ${Math.floor(daysLeft)} days away, under the ${RENEW_DAYS} the check allows: set a date under a year ahead in both files and deploy each site`;
  }
  if (daysLeft > MAX_DAYS_AHEAD) {
    return `Expires ${value} is more than a year away, which RFC 9116 advises against`;
  }
  return null;
}

describe("expiresProblem", () => {
  const now = new Date("2026-10-26T00:00:00Z");

  it("accepts a date between the renewal window and a year ahead", () => {
    expect(expiresProblem("2027-06-01T00:00:00.000Z", now)).toBeNull();
  });

  it("fails inside the renewal window, before the date lapses", () => {
    expect(expiresProblem("2026-11-30T00:00:00Z", now)).toMatch(
      /days away, under the 45/,
    );
  });

  it("fails a date already past", () => {
    expect(expiresProblem("2026-10-01T00:00:00Z", now)).toMatch(/days away/);
  });

  it("fails a date more than a year ahead", () => {
    expect(expiresProblem("2027-12-01T00:00:00Z", now)).toMatch(
      /more than a year/,
    );
  });

  it("fails a value that is not a UTC timestamp", () => {
    expect(expiresProblem("2027-06-01", now)).toMatch(/not an RFC 3339/);
  });

  it("fails a timestamp with an out-of-range field", () => {
    expect(expiresProblem("2027-13-01T00:00:00Z", now)).toMatch(
      /not a real date/,
    );
    expect(expiresProblem("2027-06-01T25:00:00Z", now)).toMatch(
      /not a real date/,
    );
  });
});

describe("the served security.txt files", () => {
  const texts = SECURITY_TXT_FILES.map((path) =>
    readFileSync(resolve(repoRoot, path), "utf8"),
  );

  it("are the same file on every site", () => {
    for (const text of texts.slice(1)) expect(text).toBe(texts[0]);
  });

  it("name the contacts SECURITY.md names, GitHub's private reporting first", () => {
    const expected = securityPolicyContacts(repoRoot);
    expect(expected[0]).toBe(GITHUB_REPORTING);
    expect(expected[1]).toMatch(/^mailto:[^@\s]+@[^@\s]+$/);
    expect(contacts(texts[0])).toEqual(expected);
  });

  it("have one Expires, not yet inside the renewal window", () => {
    const expires = fields(texts[0]).filter(([name]) => name === "expires");
    expect(expires).toHaveLength(1);
    expect(expiresProblem(expires[0][1], new Date())).toBeNull();
  });
});

// actions/upload-artifact leaves out every file under a directory whose name
// starts with "." unless include-hidden-files is set, so without it no site's
// artifact holds .well-known.
describe("each site's artifact upload", () => {
  it.each(SITE_UPLOADS)(
    "in $workflow carries hidden files",
    ({ workflow, output, uploads, excluded }) => {
      const steps = Object.values(
        workflowDocument(repoRoot, workflow).jobs,
      ).flatMap((job) => job.steps ?? []);
      const siteUploads = steps.filter(
        (step) =>
          (step.uses ?? "").startsWith("actions/upload-artifact@") &&
          step.with.path.split("\n")[0] === output,
      );
      expect(siteUploads).toHaveLength(uploads);
      for (const upload of siteUploads) {
        expect(upload.with["include-hidden-files"]).toBe(true);
        expect(upload.with.path.split("\n").filter(Boolean)).toEqual([
          output,
          ...excluded.map((entry) => `!${output}/${entry}`),
        ]);
      }
    },
  );
});

describe("servedProblems", () => {
  const expected = [GITHUB_REPORTING, "mailto:security@example.org"];
  const file = `# comment\nContact: ${expected[0]}\nContact: ${expected[1]}\nExpires: 2027-06-01T00:00:00.000Z\n`;
  const served = {
    status: 200,
    contentType: "text/plain; charset=utf-8",
    body: file,
  };

  it("accepts the file served as text/plain", () => {
    expect(servedProblems(served, expected)).toEqual([]);
  });

  it("fails the index page served by fallback", () => {
    const problems = servedProblems(
      { ...served, contentType: "text/html", body: "<!doctype html>\n" },
      expected,
    );
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/content type text\/html, not text\/plain/);
    expect(problems[1]).toMatch(/is not a security\.txt/);
  });

  it("fails a status other than 200, a redirect among them", () => {
    expect(servedProblems({ ...served, status: 404 }, expected)).toEqual([
      "answered 404, not 200",
    ]);
    expect(servedProblems({ ...served, status: 308 }, expected)).toEqual([
      "answered 308, not 200",
    ]);
  });

  it("fails a response with no content type", () => {
    expect(
      servedProblems({ ...served, contentType: null }, expected)[0],
    ).toMatch(/content type \(none\)/);
  });

  it("fails contacts other than the expected ones, or in another order", () => {
    const reordered = `Contact: ${expected[1]}\nContact: ${expected[0]}\n`;
    expect(servedProblems({ ...served, body: reordered }, expected)[0]).toMatch(
      /names the contacts/,
    );
    const short = `Contact: ${expected[0]}\n`;
    expect(servedProblems({ ...served, body: short }, expected)[0]).toMatch(
      /names the contacts/,
    );
  });
});

describe("securityTxtUrl", () => {
  it("joins the path to a deployment URL", () => {
    expect(securityTxtUrl("https://0123abcd.alcove-app.pages.dev")).toBe(
      `https://0123abcd.alcove-app.pages.dev${SECURITY_TXT_PATH}`,
    );
  });

  it("refuses an empty, missing or non-https URL", () => {
    expect(() => securityTxtUrl("")).toThrow(/not a URL/);
    expect(() => securityTxtUrl(undefined)).toThrow(/not a URL/);
    expect(() => securityTxtUrl("http://example.org")).toThrow(/not https/);
  });
});

// Each Pages upload's own deployment URL, read from the wrangler action's
// deployment-url output, reaches a check of the served file in a job of its
// own: the job that holds the deploy credentials runs no repository code.
describe("each Pages upload", () => {
  const CHECK_COMMAND = "node scripts/check-served-security-txt.mjs";

  it.each([`${WORKFLOW_DIR}/pages_deploy.yaml`, SITE_DEPLOY_WORKFLOW])(
    "in %s is followed by a check of its deployment's security.txt",
    (workflow) => {
      const jobs = Object.entries(workflowDocument(repoRoot, workflow).jobs);
      const [deployId, deploy] = jobs.find(([, job]) =>
        (job.steps ?? []).some((step) =>
          (step.uses ?? "").startsWith("cloudflare/wrangler-action@"),
        ),
      );
      const uploads = deploy.steps.filter((step) =>
        (step.uses ?? "").startsWith("cloudflare/wrangler-action@"),
      );
      const checks = jobs.flatMap(([, job]) =>
        [job.needs ?? []].flat().includes(deployId)
          ? (job.steps ?? []).filter((step) => step.run === CHECK_COMMAND)
          : [],
      );
      expect(checks).toHaveLength(uploads.length);
      uploads.forEach((upload, index) => {
        const output = Object.entries(deploy.outputs ?? {}).find(
          ([, value]) =>
            value === `\${{ steps.${upload.id}.outputs.deployment-url }}`,
        );
        expect(output, `an output of upload ${upload.id}`).toBeDefined();
        expect(checks[index].env.DEPLOYMENT_URL).toBe(
          `\${{ needs.${deployId}.outputs.${output[0]} }}`,
        );
      });
    },
  );
});
