import { payloadRow, payloadRowCount } from "../../src/payloadExchange";

import type { PartnerPayload } from "../../src/payloadExchange";

/**
 * `payload` with its row indices and rows as plain arrays, so a test compares
 * a received payload, held as bytes, against the values it means.
 */
export function plainPayload(payload: PartnerPayload): {
  columns: Array<string>;
  rowIndices: Array<number>;
  rows: Array<Array<string | null>>;
} {
  return {
    columns: [...payload.columns],
    rowIndices: Array.from(payload.rowIndices),
    rows: Array.from({ length: payloadRowCount(payload.rows) }, (_, index) => [
      ...payloadRow(payload.rows, index),
    ]),
  };
}
