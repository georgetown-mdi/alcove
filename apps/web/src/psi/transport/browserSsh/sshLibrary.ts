// The SSH library's modules the client uses, by deep path: its main entry
// requires `stream`, which no browser bundle here provides. Every other module
// in this directory imports the library through this one.
//
// `algorithms/sshAlgorithms` goes first: `algorithms/publicKeyAlgorithm`,
// `io/sshData` and `algorithms/sshAlgorithms` require one another in a cycle
// that completes only when `sshAlgorithms` is entered first.
//
// `Buffer` is the `buffer` package's, the one the library imports, never the
// Node built-in: the client runs in a page.

// eslint-disable-next-line node/prefer-node-protocol -- the npm package
export { Buffer } from "buffer";
export {
  PublicKeyAlgorithm,
  SshAlgorithms,
} from "@microsoft/dev-tunnels-ssh/algorithms/sshAlgorithms";
export { SshDataReader } from "@microsoft/dev-tunnels-ssh/io/sshData";
export { BigInt as SshBigInt } from "@microsoft/dev-tunnels-ssh/io/bigInt";
export {
  SshProtocolExtensionNames,
  SshSessionConfiguration,
} from "@microsoft/dev-tunnels-ssh/sshSessionConfiguration";
export { BaseStream } from "@microsoft/dev-tunnels-ssh/streams";
export { CommandRequestMessage } from "@microsoft/dev-tunnels-ssh/messages/connectionMessages";
export { SshAuthenticationType } from "@microsoft/dev-tunnels-ssh/events/sshAuthenticatingEventArgs";
export { SshClientSession } from "@microsoft/dev-tunnels-ssh/sshClientSession";

export type {
  ECParameters,
  KeyPair,
} from "@microsoft/dev-tunnels-ssh/algorithms/publicKeyAlgorithm";
export type {
  Signer,
  Verifier,
} from "@microsoft/dev-tunnels-ssh/algorithms/hmacAlgorithm";
export type { SshAlgorithm } from "@microsoft/dev-tunnels-ssh/algorithms/sshAlgorithm";
export type { SshChannel } from "@microsoft/dev-tunnels-ssh/sshChannel";
