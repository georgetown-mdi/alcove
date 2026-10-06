# @alcove/cli-contract

The `alcove` CLI's machine interface, declared once for the CLI that emits it and the processes that read it:
the fd-3 event schema, the warning sources, the CLI's named exit codes, and the `cause` field of the `error` event.
[docs/spec/CLI_EVENTS.md](../../docs/spec/CLI_EVENTS.md) specifies the stream; [docs/CLI.md](../../docs/CLI.md#exit-codes) lists every exit code.

The `cause` field is built from one row per kind of core's failure-cause catalog (`FAILURE_CAUSE_STREAM_FIELDS`).
The kinds the stream states are that record's keys, and a cause whose kind has no row is dropped rather than built.

This is a workspace-internal package.
It imports `@alcove/core` and nothing from an application.

## Building

The package compiles to `dist/` with `tsc`, which reads core's types, so build core first.
The CLI reads the package from `dist/`, so build it before the CLI:

```sh
npm run build -w packages/core
npm run build -w packages/cli-contract
```

## Running tests

```sh
npm test -w packages/cli-contract
```

The suite imports `src/`, so it needs no build of this package.
