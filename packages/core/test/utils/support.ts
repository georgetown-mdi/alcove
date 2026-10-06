// The helpers the core suites share: PSI participants and a two-party cascade
// run over an in-memory pipe, a prepared exchange over first-name terms, the
// in-memory file transport, and the invitation token encoding below its schema
// check. A suite imports these rather than defining its own copy, so a change
// to a protocol or terms shape is made once.

import type { PSILibrary } from "@openmined/psi.js/implementation/psi.d.ts";

import type { PsiElementBounds } from "../../src/connection/frameSize";
import type {
  FileInfo,
  FileTransportClient,
} from "../../src/connection/fileSyncConnection";
import {
  createMessagePipe,
  type MessageConnection,
} from "../../src/connection/messageConnection";
import type { Output, LinkageTerms } from "../../src/config/linkageTermsSchema";
import type { Metadata } from "../../src/config/metadata";
import { prepareForExchange, type PreparedExchange } from "../../src/exchange";
import type { CSVRow } from "../../src/file";
import { PSIParticipant } from "../../src/psi/participant";
import type { EntityClusterSummary } from "../../src/psi/entityClosure";
import { linkViaPSI, type LinkageCardinality } from "../../src/psi/link";
import type { AssociationTable } from "../../src/types";
import {
  candidateSetBounds,
  declaredKeyWidths,
  mirrorCardinality,
  type Column,
} from "./candidateSetBounds";
import { deviateListBody } from "./matchedListPartFrames";
import { UNBOUNDED_PSI_ELEMENTS } from "./psiElementBounds";

// --- PSI participants and the cascade ----------------------------------------

/** One side of a two-party run. */
export type Party = "starter" | "joiner";

/**
 * A participant playing `role`, with element bounds that never reject unless
 * a test passes real ones.
 */
export function makeParticipant(
  library: PSILibrary,
  role: Party,
  elementBounds: PsiElementBounds = UNBOUNDED_PSI_ELEMENTS,
): PSIParticipant {
  return new PSIParticipant(
    role === "starter" ? "server" : "client",
    library,
    { role, verbose: -1 },
    elementBounds,
  );
}

/** A rewrite applied to each frame one party receives. */
export type Deviation = (frame: unknown) => unknown;

/**
 * `conn` with every inbound frame passed through `deviate` (a matched-record
 * list is rewritten as its JSON body), standing in for a partner that runs the
 * protocol correctly up to the frame under test.
 */
export function deviatingInbound(
  conn: MessageConnection,
  deviate: Deviation,
): MessageConnection {
  return {
    send: (data) => conn.send(data),
    receive: async (timeoutMs?: number) =>
      deviateListBody(await conn.receive(timeoutMs), deviate),
    close: () => conn.close(),
    setInboundFrameCap: conn.setInboundFrameCap?.bind(conn),
  };
}

/** What {@link runCascade} drives. */
export interface CascadeRunOptions {
  readonly library: PSILibrary;
  readonly starterKeys: ReadonlyArray<Column>;
  readonly joinerKeys: ReadonlyArray<Column>;
  /** The starter's cardinality, default one-to-one; the joiner runs its mirror. */
  readonly cardinality?: LinkageCardinality;
  /** Default: the widths the agreed terms declare for the keys. */
  readonly keyWidths?: ReadonlyArray<number>;
  /** Default: bounds that never reject. */
  readonly elementBounds?: PsiElementBounds;
  /** Wraps one party's end of the pipe, for a deviation or a recorder. */
  readonly wrap?: Partial<
    Record<Party, (conn: MessageConnection) => MessageConnection>
  >;
  /** Rewrites one party's inbound frames; shorthand for a `wrap`. */
  readonly deviate?: { readonly party: Party; readonly deviation: Deviation };
  /** A party unsettled after this long settles as an Error naming it. */
  readonly stallMs?: number;
}

/** Each party's table, or the error it ended with. */
export interface CascadeRun {
  readonly starter: AssociationTable | Error;
  readonly joiner: AssociationTable | Error;
  /** What each party reported through the entity-cluster callback, if any. */
  readonly starterClusters?: EntityClusterSummary;
  readonly joinerClusters?: EntityClusterSummary;
}

/**
 * `run`'s value, or the error it rejected with; with `stallMs`, an Error naming
 * `label` if it has not settled by then.
 */
export function settleWithin<T>(
  run: Promise<T>,
  label: string,
  stallMs: number | undefined,
): Promise<T | Error> {
  const settled = run.then(
    (value) => value,
    (err: unknown) =>
      err instanceof Error ? err : new Error(String(err), { cause: err }),
  );
  if (stallMs === undefined) return settled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<Error>((resolve) => {
    timer = setTimeout(
      () => resolve(new Error(`${label} never settled`)),
      stallMs,
    );
  });
  return Promise.race([settled, stalled]).finally(() => clearTimeout(timer));
}

/**
 * Runs the cascade between a starter and a joiner over an in-memory pipe and
 * returns both outcomes; neither party's failure rejects.
 */
export async function runCascade(
  options: CascadeRunOptions,
): Promise<CascadeRun> {
  const { library, starterKeys, joinerKeys } = options;
  const cardinality = options.cardinality ?? "one-to-one";
  const keyWidths =
    options.keyWidths ?? declaredKeyWidths([...starterKeys], [...joinerKeys]);
  const [starterConn, joinerConn] = createMessagePipe();
  const connFor = (party: Party, conn: MessageConnection) => {
    const wrapped = options.wrap?.[party]?.(conn) ?? conn;
    return options.deviate?.party === party
      ? deviatingInbound(wrapped, options.deviate.deviation)
      : wrapped;
  };
  const reported: Partial<Record<Party, EntityClusterSummary>> = {};
  const run = (party: Party, conn: MessageConnection) => {
    const [own, partner] =
      party === "starter"
        ? [starterKeys, joinerKeys]
        : [joinerKeys, starterKeys];
    return settleWithin(
      linkViaPSI(
        {
          cardinality:
            party === "starter" ? cardinality : mirrorCardinality(cardinality),
        },
        makeParticipant(library, party, options.elementBounds),
        connFor(party, conn),
        [...own],
        candidateSetBounds(partner[0].length, keyWidths),
        -1,
        undefined,
        (summary) => (reported[party] = summary),
      ),
      `the cascade ${party}`,
      options.stallMs,
    );
  };
  const starterRun = run("starter", starterConn);
  const joinerRun = run("joiner", joinerConn);
  // A party that aborts leaves its partner parked on a frame it never sends, so
  // the pipe closes once the deviated party (else the starter) has settled.
  await (options.deviate?.party === "joiner" ? joinerRun : starterRun);
  await starterConn.close();
  return {
    starter: await starterRun,
    joiner: await joinerRun,
    starterClusters: reported.starter,
    joinerClusters: reported.joiner,
  };
}

/** Both tables of a run; rethrows the error a party ended with. */
export function tablesOf(run: CascadeRun): {
  starter: AssociationTable;
  joiner: AssociationTable;
} {
  if (run.starter instanceof Error) throw run.starter;
  if (run.joiner instanceof Error) throw run.joiner;
  return { starter: run.starter, joiner: run.joiner };
}

// --- Prepared exchanges -------------------------------------------------------

/** Both parties expect the output and share it. */
export const bothOutput: Output = {
  expectsOutput: true,
  shareWithPartner: true,
};

/** Cascade PSI terms linking on one first-name key, with no identity or output. */
export const firstNameTerms = {
  version: "1.0.0",
  date: "2026-01-01",
  algorithm: "psi" as const,
  linkageStrategy: "cascade" as const,
  deduplicate: false,
  linkageFields: [{ name: "firstName", type: "first_name" as const }],
  linkageKeys: [{ name: "firstName", elements: [{ field: "firstName" }] }],
};

/** A first-name linkage column and a `note` column sent as payload. */
export const firstNameAndSentNote: Metadata = [
  { name: "first_name", type: "first_name", role: "linkage", isPayload: false },
  { name: "note", type: "other", role: "payload", isPayload: true },
];

/** What {@link prepared} varies. */
export interface PreparedOptions {
  /** Merged over {@link firstNameTerms}, `identity`, and {@link bothOutput}. */
  readonly terms?: Partial<LinkageTerms>;
  /** Used as given instead of the merge `terms` makes. */
  readonly linkageTerms?: LinkageTerms;
  readonly metadata?: Metadata;
  /** Default: `["first_name"]`. */
  readonly columns?: Array<string>;
}

/** {@link prepared} over `first_name` and a `note` column sent as payload. */
export const withSentNote: PreparedOptions = {
  metadata: firstNameAndSentNote,
  columns: ["first_name", "note"],
};

/** `rows` prepared for an exchange as `identity`, by default over first-name terms. */
export function prepared(
  identity: string,
  rows: Array<CSVRow>,
  options: PreparedOptions = {},
): PreparedExchange {
  const linkageTerms = options.linkageTerms ?? {
    ...firstNameTerms,
    identity,
    output: bothOutput,
    ...options.terms,
  };
  return prepareForExchange(
    {
      ...(options.metadata !== undefined ? { metadata: options.metadata } : {}),
      linkageTerms,
    },
    identity,
    rows,
    options.columns ?? ["first_name"],
  );
}

// --- In-memory file transport -------------------------------------------------

// Reduce a put() src to the on-disk bytes a real transport writes: a chunk-list
// is joined, a lone Buffer and a drained stream pass through. A string src is a
// local file PATH to a real transport (never an in-memory body), so it throws
// here as the real adapters do rather than silently dropping the body.
async function putSrcBytes(
  src: string | Buffer | Uint8Array[] | NodeJS.ReadableStream,
): Promise<Buffer> {
  if (typeof src === "string")
    throw new Error("put expects a Buffer or chunk-list body, not a string");
  if (Buffer.isBuffer(src)) return src;
  if (Array.isArray(src)) return Buffer.concat(src);
  const chunks: Buffer[] = [];
  for await (const chunk of src)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * A mock-transport operation's behavior: "real" runs against the in-memory
 * store, "throw" always rejects (a transport that lacks the operation), "noop"
 * resolves without touching the store.
 */
export type MockBehavior = "real" | "throw" | "noop";

/**
 * Given the listing a poll would see and the (0-based) list() call index,
 * returns the listing the caller observes on that poll.
 */
export type ListScript = (listing: FileInfo[], call: number) => FileInfo[];

/** How {@link makeMockClient}'s transport departs from a working directory. */
export interface MockClientOptions {
  /**
   * Share one store across two clients (the two-party single-directory
   * model); omitted, each client gets a fresh Map.
   */
  files?: Map<string, Buffer>;
  /** Default "real". "throw" models a no-delete transport. */
  deleteBehavior?: MockBehavior;
  /** Default: "real" with a working delete, else "noop". */
  safeDeleteBehavior?: MockBehavior;
  /**
   * Default "real" (an atomic create refusing an existing path with EEXIST).
   * "throw" models a lockless transport without atomic exclusive-create;
   * "eexist" refuses every create as if the path existed.
   */
  createExclusiveBehavior?: MockBehavior | "eexist";
  /** Spy fired before delete's behavior runs. */
  onDelete?: (path: string) => void;
  /** Spy fired at the start of get(). */
  onGet?: (path: string) => void;
  /** A get() rejection for `path`, or undefined to read the store. */
  getError?: (path: string) => Error | undefined;
  /** Every list() rejects with this. */
  listError?: Error;
  /** Every rename() rejects with this. */
  renameError?: Error;
  /** exists() answers this whatever the store holds. */
  existsReturns?: boolean;
  /** Names no list() reports. */
  hideFromList?: ReadonlyArray<string>;
  /**
   * Names hidden from the FIRST list() (the entry scan) only: a protocol file
   * a peer publishes after this party's entry check has run.
   */
  hideAtEntry?: ReadonlyArray<string>;
  /** Rewrites each listing after the hides above. */
  listScript?: ListScript;
  /** put() and rename() wait this long before acting. */
  writeDelayMs?: number;
  /** put() never settles. */
  hangWrite?: boolean;
  /**
   * After end(), a put() or rename() rejects, as on a real transport whose
   * channel end() destroyed.
   */
  rejectWritesAfterEnd?: boolean;
  /**
   * Receives an op log: `end`, `get:<name>`, `put-start:<name>`,
   * `put-done:<name>`, `rename:<name>`, and `beginTeardown`.
   */
  ops?: string[];
  /** Gives the transport a beginTeardown() that logs to `ops`. */
  withBeginTeardown?: boolean;
}

/**
 * A FileTransportClient over an in-memory directory. A missing file's get()
 * rejects with code ENOENT, as the real adapters do.
 */
export function makeMockClient(opts: MockClientOptions = {}): {
  client: FileTransportClient;
  files: Map<string, Buffer>;
} {
  const files = opts.files ?? new Map<string, Buffer>();
  const deleteBehavior = opts.deleteBehavior ?? "real";
  const safeDeleteBehavior =
    opts.safeDeleteBehavior ?? (deleteBehavior === "real" ? "real" : "noop");
  const createExclusiveBehavior = opts.createExclusiveBehavior ?? "real";
  const writeDelayMs = opts.writeDelayMs ?? 0;
  const log = (op: string) => opts.ops?.push(op);
  const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);
  const delay = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));
  let ended = false;
  let listCall = 0;

  const deleteFor =
    (behavior: MockBehavior) =>
    async (path: string): Promise<void> => {
      if (behavior === "throw")
        throw new Error("delete not supported on this transport");
      if (behavior === "real") files.delete(path);
    };
  const refuseAfterEnd = (path: string, op: string) => {
    if (opts.rejectWritesAfterEnd && ended)
      throw new Error(`${path}: transport ended mid-${op}`);
  };

  const client: FileTransportClient = {
    connect: async () => {},
    end: async () => {
      log("end");
      ended = true;
    },
    list: async (dir: string): Promise<FileInfo[]> => {
      if (opts.listError) throw opts.listError;
      const prefix = dir.endsWith("/") ? dir : `${dir}/`;
      let entries = [...files.entries()]
        .filter(
          ([p]) =>
            p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map(([p, buf]) => ({
          name: p.slice(prefix.length),
          modifyTime: 0,
          size: buf.length,
        }));
      const hidden = [
        ...(opts.hideFromList ?? []),
        ...(listCall === 0 ? (opts.hideAtEntry ?? []) : []),
      ];
      entries = entries.filter((e) => !hidden.includes(e.name));
      if (opts.listScript) entries = opts.listScript(entries, listCall);
      listCall += 1;
      return entries;
    },
    get: async (path: string) => {
      opts.onGet?.(path);
      log(`get:${baseName(path)}`);
      const err = opts.getError?.(path);
      if (err) throw err;
      const data = files.get(path);
      if (!data)
        throw Object.assign(new Error(`${path}: not found`), {
          code: "ENOENT",
        });
      return data as Buffer<ArrayBufferLike>;
    },
    put: async (src, dest) => {
      log(`put-start:${baseName(dest)}`);
      if (opts.hangWrite) return new Promise<void>(() => {});
      if (writeDelayMs > 0) await delay(writeDelayMs);
      refuseAfterEnd(dest, "write");
      files.set(dest, await putSrcBytes(src));
      log(`put-done:${baseName(dest)}`);
    },
    delete: async (path: string) => {
      opts.onDelete?.(path);
      return deleteFor(deleteBehavior)(path);
    },
    safeDelete: deleteFor(safeDeleteBehavior),
    rename: async (from: string, to: string) => {
      if (opts.renameError) throw opts.renameError;
      if (writeDelayMs > 0) await delay(writeDelayMs);
      refuseAfterEnd(to, "rename");
      const data = files.get(from);
      if (data === undefined) throw new Error(`${from}: no such file`);
      files.delete(from);
      files.set(to, data);
      log(`rename:${baseName(to)}`);
    },
    createExclusive: async (path: string) => {
      if (createExclusiveBehavior === "throw")
        throw new Error("createExclusive not supported on this transport");
      if (createExclusiveBehavior === "noop") return;
      if (createExclusiveBehavior === "eexist" || files.has(path))
        throw Object.assign(new Error(`${path}: file already exists`), {
          code: "EEXIST",
        });
      files.set(path, Buffer.alloc(0));
    },
    exists: async (path: string) => opts.existsReturns ?? files.has(path),
    ...(opts.withBeginTeardown
      ? { beginTeardown: () => void log("beginTeardown") }
      : {}),
  };

  return { client, files };
}

// --- Invitation tokens ----------------------------------------------------------

/**
 * The invitation token encoding (base64url body, then the base64url of the
 * body's first four SHA-256 bytes) over `payload` as given, with no schema
 * check: a decode test hands decodeInvitation a token encodeInvitation would
 * refuse to produce, including one whose body is not JSON.
 */
export async function encodeRawInvitationPayload(
  payload: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(payload);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const base64Url = (b: Uint8Array) => Buffer.from(b).toString("base64url");
  return base64Url(bytes) + base64Url(new Uint8Array(hash).slice(0, 4));
}

/** {@link encodeRawInvitationPayload} over `token`'s JSON. */
export async function encodeRawInvitation(token: unknown): Promise<string> {
  return encodeRawInvitationPayload(JSON.stringify(token));
}
