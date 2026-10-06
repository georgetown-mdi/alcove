// The CLI's machine interface, for the CLI that emits it and the consumers
// that read it: the fd-3 event schema, the warning sources, the exit codes,
// the failure-cause field, and the notice a reader gives for an event outside
// the schema. docs/spec/CLI_EVENTS.md is its specification.

export * from "./events.js";
export * from "./exitCodes.js";
export * from "./failureCauses.js";
export * from "./unknownEventNotice.js";
export * from "./warningSources.js";
