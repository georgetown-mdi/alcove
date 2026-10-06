/**
 * What an attended run's completion surface says about the copy of its results
 * written into the exchange's working folder. The download is offered either
 * way, so a write that did not land states what happened and points at the
 * download rather than standing in for it. No React, no I/O.
 */

import type { ResultsDelivery } from "@psi/managed/managedWorkingDirectory";

/** An attended run's folder write as the completion surface holds it: under
 * way while `delivery` is absent, then how it turned out. `directoryName` is the
 * granted folder's own name, the leaf its handle reports. */
export interface AttendedFolderWrite {
  directoryName: string;
  delivery?: ResultsDelivery;
}

/** The line shown beside the result download, and whether it reports a write
 * that did not land. */
export interface AttendedFolderWriteNote {
  message: string;
  failed: boolean;
}

/** The note for an attended run's folder write, in the words the parked-results
 * history uses for a scheduled run's (see `parkedResultsModel.ts`). */
export function attendedFolderWriteNote(
  write: AttendedFolderWrite,
): AttendedFolderWriteNote {
  const folder = `the folder you chose (${write.directoryName})`;
  const { delivery } = write;
  if (delivery === undefined)
    return { message: `Writing the results to ${folder}.`, failed: false };
  switch (delivery.kind) {
    case "written":
      return {
        message: `The results were also written to ${delivery.fileName} in ${folder}.`,
        failed: false,
      };
    case "ungranted":
      return {
        message:
          `The results were not written to ${folder}: this browser has not ` +
          `allowed this site to write there. Download them above instead. ` +
          `Choosing the folder again on this exchange's page lets later runs ` +
          `write there.`,
        failed: true,
      };
    case "write-failed":
      return {
        message:
          `The results were not written to ${folder}: the write failed. ` +
          `Download them above instead, and check that the folder still ` +
          `exists and has room.`,
        failed: true,
      };
  }
}
