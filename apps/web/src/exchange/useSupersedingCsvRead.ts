import { useEffect, useRef } from "react";

import { emptyColumnPositions } from "@psi/columnNames";
import { loadCSVFileOffMainThread } from "@psi/workers/csvParseController";

import type { CSVParseResult } from "@psi/workers/csvParseController";

/** A read the header check passed, handed to the screen's own dispatch. */
export interface CsvReadAccepted {
  columns: Array<string>;
  rows: CSVParseResult["data"];
  /** The header positions the read's column-name sanitation changed. */
  sanitizedPositions: Array<number>;
}

/** How a read ended, for the screen to turn into its own dispatch. */
export type CsvReadOutcome =
  /** A newer read or a discard replaced this one: nothing is dispatched. */
  | { kind: "superseded" }
  | { kind: "accepted" }
  /** The header leaves a column unnamed, so the read is refused. */
  | {
      kind: "refused";
      emptyPositions: Array<number>;
      sanitizedPositions: Array<number>;
    }
  /** The read, or the screen's handling of an accepted read, threw. */
  | { kind: "failed"; error: unknown };

/**
 * One in-flight browser CSV read at a time, as both intake screens run it. A
 * new read or `discard` aborts the parse worker of the read before it, and a
 * read that was replaced resolves as `superseded` instead of clobbering
 * current state; unmounting discards. A header with an empty column name is
 * refused before `accept` runs, or core's inferMetadata would throw when the
 * screen seeds its editor.
 */
export function useSupersedingCsvRead(): {
  /** Read `file` by `delimiter` (undefined detects it). `accept` runs inside
   * the read's failure handling, so a throw from it is a `failed` outcome. */
  read: (
    file: File,
    delimiter: string | undefined,
    accept: (read: CsvReadAccepted) => void,
  ) => Promise<CsvReadOutcome>;
  discard: () => void;
} {
  const readId = useRef(0);
  const readAbort = useRef<AbortController | undefined>(undefined);

  function discard() {
    readId.current += 1;
    readAbort.current?.abort();
  }

  useEffect(() => discard, []);

  async function read(
    file: File,
    delimiter: string | undefined,
    accept: (read: CsvReadAccepted) => void,
  ): Promise<CsvReadOutcome> {
    const id = ++readId.current;
    readAbort.current?.abort();
    const controller = new AbortController();
    readAbort.current = controller;
    try {
      const result = await loadCSVFileOffMainThread(file, {
        signal: controller.signal,
        ...(delimiter !== undefined ? { delimiter } : {}),
      });
      if (id !== readId.current) return { kind: "superseded" };
      const columns = result.meta.fields ?? [];
      const sanitizedPositions = result.meta.sanitizedColumnPositions;
      const emptyPositions = emptyColumnPositions(columns);
      if (emptyPositions.length > 0)
        return { kind: "refused", emptyPositions, sanitizedPositions };
      accept({ columns, rows: result.data, sanitizedPositions });
      return { kind: "accepted" };
    } catch (error) {
      if (id !== readId.current) return { kind: "superseded" };
      return { kind: "failed", error };
    }
  }

  return { read, discard };
}
