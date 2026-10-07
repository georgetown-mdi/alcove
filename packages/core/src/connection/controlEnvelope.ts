import * as z from "zod";

/**
 * The hello body: the two bilateral mode flags each party advertises at
 * rendezvous, compared by the peer so a mismatch fails fast. Both are required
 * with no defaulting. Fields are camelCase on disk with no `camelizeKeys`
 * conversion, since a control file is a protocol message; a new field must be
 * camelCase too. The ack marker is zero-length and has no envelope.
 */
export interface HelloEnvelope {
  /** This party's `lockless_rendezvous` setting; the peer's must match. */
  locklessRendezvous: boolean;
  /** This party's `retain_files` setting; the peer's must match. */
  retainFiles: boolean;
}

/**
 * Zod schema for {@link HelloEnvelope}. Unknown fields are stripped so a newer
 * peer may add one; a missing required field still fails (docs/spec/FILE_SYNC.md,
 * Matching builds).
 */
export const HelloEnvelopeSchema: z.ZodType<HelloEnvelope> = z
  .object({
    locklessRendezvous: z.boolean(),
    retainFiles: z.boolean(),
  })
  .strip();

/**
 * Serializes a {@link HelloEnvelope} for `FileTransportClient.put`, verbatim with
 * no key-case conversion.
 */
export const serializeEnvelope = (envelope: HelloEnvelope): Buffer =>
  Buffer.from(JSON.stringify(envelope));
