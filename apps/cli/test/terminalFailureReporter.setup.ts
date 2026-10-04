import { afterEach } from "vitest";

import { installTerminalFailureReporter } from "../src/util/exit";

// Opening the event stream installs the exit boundary's reporter for the whole
// process. A test file runs many runs in one process, so without this a later
// test's exit would write an earlier run's terminal event to whatever fd 3 the
// worker holds -- its own IPC channel, under the forks pool.
afterEach(() => {
  installTerminalFailureReporter(undefined);
});
