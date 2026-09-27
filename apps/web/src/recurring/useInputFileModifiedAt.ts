import { useEffect, useState } from "react";

import { readInputFileModifiedAt } from "@psi/managed/managedInputHandle";
import { storedWorkingDirectoryUsable } from "@psi/managed/managedWorkingDirectory";

/**
 * When the input file in this exchange's working folder was last changed, in
 * epoch milliseconds, or `undefined` while the read is outstanding and wherever
 * it found nothing to report (no usable folder, no standing read grant, a missing
 * or unreadable entry). The schedule section reads it to say whether the input has
 * been refreshed since the last successful run.
 *
 * The read happens once per mounted handle rather than on a poll: what it feeds is
 * a note the operator reads on this visit, and a file replaced while they sit on
 * the page is the next visit's reading. It prompts for nothing -- the underlying
 * read queries the grant and never asks for it -- so opening an exchange's page
 * raises no permission dialog.
 */
export function useInputFileModifiedAt(
  directory: FileSystemDirectoryHandle | undefined,
): number | undefined {
  const [modifiedAtMs, setModifiedAtMs] = useState<number | undefined>(
    undefined,
  );

  useEffect(() => {
    let live = true;
    if (directory !== undefined && storedWorkingDirectoryUsable(directory))
      void readInputFileModifiedAt(directory).then((at) => {
        if (live) setModifiedAtMs(at);
      });
    else setModifiedAtMs(undefined);
    return () => {
      live = false;
    };
  }, [directory]);

  return modifiedAtMs;
}
