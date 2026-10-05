import { useEffect, useState } from "react";

import { acquireManagedInput } from "@psi/managed/managedInputHandle";
import { storedWorkingDirectoryUsable } from "@psi/managed/managedWorkingDirectory";

import { delimiterRecheckFrom } from "./localDocumentFieldsModel";

import type { DelimiterRecheck } from "./localDocumentFieldsModel";
import type { ExchangeSpec } from "@alcove/core";

/**
 * Re-read the stored input file under a delimiter the operator has changed to,
 * and grade the columns it reads into against the agreed terms, so the editor
 * states whether the file reads under the new delimiter before the save stores
 * it. `undefined` where there is nothing to re-read: no changed delimiter, or
 * no usable working folder to read it from (a configuration-only record, or a
 * browser without folder handles).
 *
 * The read queries the file's read grant and never asks for it, as a page
 * showing a file's last change does, so choosing a delimiter raises no
 * permission dialog; a grant this browser does not hold reads as `unreadable`.
 * Only the column names are kept: the rows the read parsed are dropped with it.
 */
export function useDelimiterRecheck(
  exchangeFile: ExchangeSpec,
  directory: FileSystemDirectoryHandle | undefined,
  changedDelimiter: string | undefined,
): DelimiterRecheck | undefined {
  // The read is keyed on the folder handle and the delimiter, so a result read
  // from one folder is never shown for another. The grade against the terms is
  // taken at render, so new terms over the same folder regrade without a read.
  const [settled, setSettled] = useState<{
    directory: FileSystemDirectoryHandle;
    delimiter: string;
    columns: ReadonlyArray<string> | undefined;
  }>();
  const rereads =
    changedDelimiter !== undefined &&
    directory !== undefined &&
    storedWorkingDirectoryUsable(directory);

  useEffect(() => {
    if (!rereads) return;
    const delimiter = changedDelimiter;
    const folder = directory;
    let live = true;
    function settle(columns: ReadonlyArray<string> | undefined) {
      if (live) setSettled({ directory: folder, delimiter, columns });
    }
    acquireManagedInput(
      { kind: "folder", directory: folder, attendance: "unattended" },
      undefined,
      delimiter,
    ).then(
      ({ columns }) => settle(columns),
      () => settle(undefined),
    );
    return () => {
      live = false;
    };
  }, [rereads, directory, changedDelimiter]);

  if (!rereads) return undefined;
  if (
    settled?.directory !== directory ||
    settled.delimiter !== changedDelimiter
  )
    return { kind: "reading" };
  return settled.columns === undefined
    ? { kind: "unreadable" }
    : delimiterRecheckFrom(exchangeFile, settled.columns);
}
