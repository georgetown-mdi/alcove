import type { EventType } from "@alcove/cli-contract";

/**
 * A relayed CLI event after validation against the fd-3 schema
 * (`@alcove/cli-contract`, docs/spec/CLI_EVENTS.md) and field sanitization. A
 * malformed or unknown line is a degradation notice, never a crash.
 */
export interface RelayEvent {
  v: number;
  type: EventType;
  [key: string]: unknown;
}
