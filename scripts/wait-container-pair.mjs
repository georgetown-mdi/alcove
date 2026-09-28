#!/usr/bin/env node
// Waits on two containers that each need the other running, and stops the
// survivor as soon as either exits non-zero, so a failed half fails the caller
// at once instead of after its partner's own rendezvous timeout.
//
// Usage: wait-container-pair.mjs <timeout-seconds> <name>=<container> <name>=<container>
//
// Exits 0 only when both containers exit 0. Otherwise it prints each half's
// exit status and why it ended, and exits 1. Printing logs and removing the
// containers stay with the caller: image_smoke.yaml's bind-mount step.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const STOPPED_HALF_GRACE_MS = 30_000;
const TIMED_OUT = Symbol("timed out");

/**
 * Waits for one container through `docker wait`. Resolves with the exit status
 * it prints, or "wait-failed" when `docker wait` itself fails.
 */
function waitForContainer(container) {
  const child = spawn("docker", ["wait", container], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const finished = new Promise((resolve) => {
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => resolve("wait-failed"));
    child.on("close", (code) => {
      const status = stdout.trim();
      resolve(code === 0 && status !== "" ? status : "wait-failed");
    });
  });
  return { child, finished };
}

function withDeadline(promise, milliseconds, onDeadline) {
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(onDeadline()), Math.max(milliseconds, 0));
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Waits on both halves, stopping the other when one exits non-zero, or both
 * when the timeout passes. Resolves with each half's status and why it ended.
 */
export async function waitForPair(halves, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  const waits = halves.map((half) => ({
    ...half,
    ...waitForContainer(half.container),
  }));
  const settledStatus = new Array(waits.length);
  const settled = waits.map((wait, index) =>
    wait.finished.then((status) => {
      settledStatus[index] = status;
      return { index, status };
    }),
  );

  let pending = [0, 1];
  let failedHalf;
  while (pending.length > 0 && failedHalf === undefined) {
    const next = await withDeadline(
      Promise.race(pending.map((index) => settled[index])),
      deadline - Date.now(),
      () => TIMED_OUT,
    );
    if (next === TIMED_OUT) break;
    waits[next.index].status = next.status;
    waits[next.index].reason = "exited";
    pending = pending.filter((index) => index !== next.index);
    if (next.status !== "0") failedHalf = waits[next.index];
  }

  const stopped = [];
  for (const index of pending) {
    const wait = waits[index];
    if (settledStatus[index] !== undefined) {
      wait.status = settledStatus[index];
      wait.reason = "exited";
      wait.child.kill();
      continue;
    }
    wait.reason =
      failedHalf === undefined
        ? `stopped after the ${timeoutSeconds}s timeout`
        : `stopped because ${failedHalf.name} failed`;
    spawnSync("docker", ["kill", wait.container], { stdio: "ignore" });
    stopped.push(wait);
  }
  await Promise.all(
    stopped.map(async (wait) => {
      wait.status = await withDeadline(
        wait.finished,
        STOPPED_HALF_GRACE_MS,
        () => "still-running",
      );
      wait.child.kill();
    }),
  );

  return waits.map(({ name, container, status, reason }) => ({
    name,
    container,
    status,
    reason,
  }));
}

function parseHalf(argument) {
  const separator = argument.indexOf("=");
  if (separator <= 0 || separator === argument.length - 1) return undefined;
  return {
    name: argument.slice(0, separator),
    container: argument.slice(separator + 1),
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [timeoutArgument, ...halfArguments] = process.argv.slice(2);
  const timeoutSeconds = Number(timeoutArgument);
  const halves = halfArguments.map(parseHalf);
  if (
    !Number.isFinite(timeoutSeconds) ||
    timeoutSeconds <= 0 ||
    halves.length !== 2 ||
    halves.includes(undefined)
  ) {
    console.error(
      "usage: wait-container-pair.mjs <timeout-seconds> <name>=<container> <name>=<container>",
    );
    process.exit(2);
  }
  const results = await waitForPair(halves, timeoutSeconds);
  for (const { name, status, reason } of results) {
    console.error(`${name}: ${reason}, status ${status}`);
  }
  if (
    results.some(({ status, reason }) => status !== "0" || reason !== "exited")
  ) {
    console.error("an exchange half did not exit 0");
    process.exit(1);
  }
}
