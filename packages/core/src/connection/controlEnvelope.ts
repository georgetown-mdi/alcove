import * as z from "zod";

import { versionList } from "../versionHello";

/**
 * The protocol and envelope versions a hello offers, by the value rules of the
 * key-exchange hello's lists (docs/spec/FILE_SYNC.md, Selecting the versions
 * at the rendezvous).
 */
export interface HelloVersions {
  protocol: readonly number[];
  envelope: readonly number[];
}

/**
 * What a hello with no `versions` member offers: the one protocol and envelope
 * version every build before the member existed speaks.
 */
export const HELLO_VERSIONS_WHEN_ABSENT: HelloVersions = {
  protocol: [1],
  envelope: [1],
};

/**
 * The hello body: the two bilateral mode flags each party advertises at
 * rendezvous, compared by the peer so a mismatch fails fast, and on a run with
 * no key exchange the versions it offers. Both flags are required with no
 * defaulting. Fields are camelCase on disk with no `camelizeKeys` conversion,
 * since a control file is a protocol message; a new field must be camelCase
 * too. The ack marker is zero-length and has no envelope.
 */
export interface HelloEnvelope {
  /** This party's `lockless_rendezvous` setting; the peer's must match. */
  locklessRendezvous: boolean;
  /** This party's `retain_files` setting; the peer's must match. */
  retainFiles: boolean;
  /** The versions offered, written only by a run with no key exchange. */
  versions?: HelloVersions;
}

/**
 * Zod schema for {@link HelloEnvelope}. Unknown fields, at the top level and
 * inside `versions`, are stripped so a newer peer may add one; a missing
 * required field still fails (docs/spec/FILE_SYNC.md, Matching builds).
 */
export const HelloEnvelopeSchema: z.ZodType<HelloEnvelope> = z
  .object({
    locklessRendezvous: z.boolean(),
    retainFiles: z.boolean(),
    versions: z
      .object({ protocol: versionList, envelope: versionList })
      .strip()
      .optional(),
  })
  .strip();

/**
 * Serializes a {@link HelloEnvelope} for `FileTransportClient.put`, verbatim with
 * no key-case conversion.
 */
export const serializeEnvelope = (envelope: HelloEnvelope): Buffer =>
  Buffer.from(JSON.stringify(envelope));
