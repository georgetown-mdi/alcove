#!/usr/bin/env node
// Fetches /.well-known/security.txt from a Pages deployment, the URL in
// DEPLOYMENT_URL, and fails unless it answers 200 as text/plain with the
// Contact lines SECURITY.md names. Run by the deploy workflows after each
// upload, on the deployment the upload made rather than a custom domain.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contacts, securityPolicyContacts } from "./lib/securityTxt.mjs";

export const SECURITY_TXT_PATH = "/.well-known/security.txt";

/**
 * Why a fetched security.txt is not the one a site owes, as strings; empty
 * when it is. A redirect fails as a status other than 200.
 * @param {{status: number, contentType: string | null, body: string}} response
 * @param {string[]} expectedContacts
 */
export function servedProblems(response, expectedContacts) {
  const problems = [];
  if (response.status !== 200) {
    problems.push(`answered ${response.status}, not 200`);
  }
  const mediaType = (response.contentType ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (mediaType !== "text/plain") {
    problems.push(
      `has content type ${response.contentType ?? "(none)"}, not text/plain`,
    );
  }
  let served;
  try {
    served = contacts(response.body);
  } catch (error) {
    problems.push(`is not a security.txt: ${error.message}`);
    return problems;
  }
  if (JSON.stringify(served) !== JSON.stringify(expectedContacts)) {
    problems.push(
      `names the contacts ${JSON.stringify(served)}, not ${JSON.stringify(expectedContacts)} as SECURITY.md does`,
    );
  }
  return problems;
}

/** The security.txt URL of a deployment, or throws on a URL that is not https. */
export function securityTxtUrl(deploymentUrl) {
  let base;
  try {
    base = new URL(deploymentUrl ?? "");
  } catch {
    throw new Error(
      `DEPLOYMENT_URL is not a URL: ${JSON.stringify(deploymentUrl ?? "")}`,
    );
  }
  if (base.protocol !== "https:") {
    throw new Error(`DEPLOYMENT_URL is not https: ${base.href}`);
  }
  return new URL(SECURITY_TXT_PATH, base).href;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const url = securityTxtUrl(process.env.DEPLOYMENT_URL);
  const response = await fetch(url, { redirect: "manual" });
  const problems = servedProblems(
    {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text(),
    },
    securityPolicyContacts(repoRoot),
  );
  if (problems.length > 0) {
    for (const problem of problems) console.error(`${url} ${problem}.`);
    process.exit(1);
  }
  console.log(`${url} serves the security.txt SECURITY.md names.`);
}
