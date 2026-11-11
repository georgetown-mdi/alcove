// The browser bundle's `vscode-jsonrpc`, aliased in by apps/web/vite.config.ts.
// The SSH library uses only these classes, from two of the package's own
// modules; the package's main entry also loads its message reader, which reads
// a `Buffer` global when it loads, and its pipe and socket support, which
// require Node modules. The code here is vscode-jsonrpc 4.0.0's own.

export { Disposable, Emitter, Event } from "vscode-jsonrpc/lib/events";
export {
  CancellationToken,
  CancellationTokenSource,
} from "vscode-jsonrpc/lib/cancellation";
