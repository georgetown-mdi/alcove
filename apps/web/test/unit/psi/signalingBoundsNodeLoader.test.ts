import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { expect, test } from "vitest";

// A production server render loads this module through Node's own ESM loader,
// which links peerjs's CommonJS entry and so finds no named exports. Vitest
// resolves peerjs another way, so only a separate Node process sees the
// failure.
test("signalingBounds links under Node's ESM loader", async () => {
  const modulePath = fileURLToPath(
    new URL("../../../src/psi/transport/signalingBounds.ts", import.meta.url),
  );
  const { stdout, stderr } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(modulePath)}); process.stdout.write("linked");`,
    ],
    { cwd: fileURLToPath(new URL("../../..", import.meta.url)) },
  );
  expect(stderr).toBe("");
  expect(stdout).toBe("linked");
});
