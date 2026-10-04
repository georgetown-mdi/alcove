import { hideBin } from "yargs/helpers";

import { buildCli } from "./cliParser";
import { allowPsiHeapRestart } from "./psiHeapRestart";
import { exitOnUncaughtError } from "./util/exit";
import { armProcessReturnGate } from "./util/exitGate";

allowPsiHeapRestart();
buildCli(hideBin(process.argv))
  .parseAsync()
  .then(() => {
    // The command has finished everything it owes -- every local write, the
    // drain that hands a stdout result to its reader, the terminal event, the
    // log flush -- so from here the process is only waiting for the event loop
    // to empty. Bound that wait (see armProcessReturnGate); a clean loop exits
    // before it and says nothing.
    armProcessReturnGate();
  })
  .catch((err: unknown) => {
    // Last-resort exit for an error that escaped every command handler. It is
    // rendered through the display-boundary sanitizer rather than
    // console.error(err): a raw transport error can hold partner- or
    // server-controlled bytes in its message or cause chain. The stack frames
    // are dropped as the trade at this catch-all boundary.
    exitOnUncaughtError(err);
  });
