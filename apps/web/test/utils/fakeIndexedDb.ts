/**
 * An in-memory stand-in for the slice of IndexedDB the managed store uses, for
 * the Node unit project, which has none. It is a model, not the engine: the
 * browser suite drives real Chromium. What it models is the event order a
 * failed request takes there -- the request's error event reaches the
 * transaction's `onerror` while `transaction.error` is still null, and only
 * the abort that follows sets it -- so a unit test can show which error a
 * store function rejects with, beside the options, outcome and connection
 * count of every transaction it opened.
 */

/** One transaction a store function opened, as the fake saw it. */
export interface FakeTransactionLog {
  storeNames: ReadonlyArray<string>;
  mode: IDBTransactionMode;
  options: IDBTransactionOptions | undefined;
  outcome: "pending" | "complete" | "abort";
}

/** A request the fake is about to serve, for {@link FakeIndexedDb.failRequests}. */
export interface FakeRequestTarget {
  store: string;
  operation: FakeOperation;
}

type FakeOperation =
  "get" | "getAll" | "getAllKeys" | "put" | "add" | "delete" | "clear";

const WRITES: ReadonlySet<FakeOperation> = new Set([
  "put",
  "add",
  "delete",
  "clear",
]);

/** The handle a test holds on the fake. */
export interface FakeIndexedDb {
  /** What to install as the global `indexedDB`. */
  factory: IDBFactory;
  /** Every transaction opened, in order. */
  transactions: Array<FakeTransactionLog>;
  /** The connections opened and not yet closed. */
  openConnections: () => number;
  /** Fail every request `match` selects with `error`, until replaced. */
  failRequests: (
    match: (target: FakeRequestTarget) => boolean,
    error: DOMException,
  ) => void;
  /** The value stored under `key`, read past every transaction. */
  stored: (database: string, store: string, key: string) => unknown;
}

interface FakeDatabase {
  version: number;
  stores: Map<string, Map<string, unknown>>;
  keyPaths: Map<string, string | undefined>;
}

type Handler = ((event: { target: unknown }) => void) | null;

class FakeRequest {
  result: unknown = undefined;
  error: DOMException | null = null;
  readyState: "pending" | "done" = "pending";
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

interface QueuedRequest {
  request: FakeRequest;
  target: FakeRequestTarget;
  run: (data: Map<string, unknown>) => unknown;
}

/** Build a fresh fake with no databases. */
export function createFakeIndexedDb(): FakeIndexedDb {
  const databases = new Map<string, FakeDatabase>();
  const transactions: Array<FakeTransactionLog> = [];
  let connections = 0;
  let failure:
    | { match: (target: FakeRequestTarget) => boolean; error: DOMException }
    | undefined;

  function transaction(
    database: FakeDatabase,
    storeNames: ReadonlyArray<string>,
    mode: IDBTransactionMode,
    options: IDBTransactionOptions | undefined,
  ) {
    const log: FakeTransactionLog = {
      storeNames,
      mode,
      options,
      outcome: "pending",
    };
    transactions.push(log);
    const working = new Map(
      storeNames.map((name) => {
        const data = database.stores.get(name);
        if (data === undefined)
          throw new DOMException(`no object store ${name}`, "NotFoundError");
        return [name, new Map(data)] as const;
      }),
    );
    const queue: Array<QueuedRequest> = [];
    let finished = false;
    let scheduled = false;
    const fake = {
      error: null as DOMException | null,
      oncomplete: null as Handler,
      onerror: null as Handler,
      onabort: null as Handler,
      objectStore: (name: string) => {
        const data = working.get(name);
        if (data === undefined)
          throw new DOMException(`${name} is not in scope`, "NotFoundError");
        return objectStore(name, data, database.keyPaths.get(name));
      },
      abort: () => {
        if (finished)
          throw new DOMException("transaction finished", "InvalidStateError");
        abortWith(null);
      },
    };

    function schedule() {
      if (scheduled) return;
      scheduled = true;
      setTimeout(step, 0);
    }

    function abortWith(error: DOMException | null) {
      finished = true;
      for (const { request } of queue.splice(0)) {
        request.readyState = "done";
        request.error = new DOMException("aborted", "AbortError");
        request.onerror?.({ target: request });
        fake.onerror?.({ target: request });
      }
      fake.error = error;
      setTimeout(() => {
        log.outcome = "abort";
        fake.onabort?.({ target: fake });
      }, 0);
    }

    function step() {
      scheduled = false;
      if (finished) return;
      const next = queue.shift();
      if (next === undefined) {
        finished = true;
        for (const [name, data] of working) database.stores.set(name, data);
        log.outcome = "complete";
        fake.oncomplete?.({ target: fake });
        return;
      }
      const { request, target } = next;
      request.readyState = "done";
      let error = failure?.match(target) === true ? failure.error : undefined;
      if (error === undefined) {
        try {
          request.result = next.run(working.get(target.store)!);
        } catch (thrown) {
          if (!(thrown instanceof DOMException)) throw thrown;
          error = thrown;
        }
      }
      if (error !== undefined) {
        request.error = error;
        request.onerror?.({ target: request });
        fake.onerror?.({ target: request });
        abortWith(error);
        return;
      }
      request.onsuccess?.({ target: request });
      schedule();
    }

    function issue(
      store: string,
      operation: FakeOperation,
      run: QueuedRequest["run"],
    ): FakeRequest {
      if (finished)
        throw new DOMException(
          "transaction finished",
          "TransactionInactiveError",
        );
      if (mode === "readonly" && WRITES.has(operation))
        throw new DOMException("readonly transaction", "ReadOnlyError");
      const request = new FakeRequest();
      queue.push({ request, target: { store, operation }, run });
      schedule();
      return request;
    }

    function objectStore(
      name: string,
      data: Map<string, unknown>,
      keyPath: string | undefined,
    ) {
      const keyOf = (value: unknown, key: unknown): string =>
        String(
          keyPath === undefined
            ? key
            : (value as Record<string, unknown>)[keyPath],
        );
      const sortedKeys = () => [...data.keys()].sort();
      return {
        get: (key: string) => issue(name, "get", (d) => d.get(key)),
        getAll: () =>
          issue(name, "getAll", (d) =>
            [...d.keys()].sort().map((key) => d.get(key)),
          ),
        getAllKeys: () => issue(name, "getAllKeys", () => sortedKeys()),
        put: (value: unknown, key?: string) => {
          const cloned = structuredClone(value);
          return issue(name, "put", (d) => {
            d.set(keyOf(cloned, key), cloned);
            return keyOf(cloned, key);
          });
        },
        add: (value: unknown, key?: string) => {
          const cloned = structuredClone(value);
          return issue(name, "add", (d) => {
            const at = keyOf(cloned, key);
            if (d.has(at))
              throw new DOMException(`key ${at} exists`, "ConstraintError");
            d.set(at, cloned);
            return at;
          });
        },
        delete: (key: string) =>
          issue(name, "delete", (d) => {
            d.delete(key);
          }),
        clear: () =>
          issue(name, "clear", (d) => {
            d.clear();
          }),
      };
    }

    return fake;
  }

  function connection(database: FakeDatabase) {
    connections += 1;
    let closed = false;
    return {
      onversionchange: null as Handler,
      objectStoreNames: {
        contains: (name: string) => database.stores.has(name),
      },
      createObjectStore: (name: string, options?: { keyPath?: string }) => {
        database.stores.set(name, new Map());
        database.keyPaths.set(name, options?.keyPath);
      },
      transaction: (
        storeNames: string | ReadonlyArray<string>,
        mode: IDBTransactionMode = "readonly",
        options?: IDBTransactionOptions,
      ) =>
        transaction(
          database,
          typeof storeNames === "string" ? [storeNames] : storeNames,
          mode,
          options,
        ),
      close: () => {
        if (closed) return;
        closed = true;
        connections -= 1;
      },
    };
  }

  const factory = {
    open: (name: string, version = 1) => {
      const request = new FakeRequest();
      setTimeout(() => {
        let database = databases.get(name);
        if (database === undefined) {
          database = { version: 0, stores: new Map(), keyPaths: new Map() };
          databases.set(name, database);
        }
        request.result = connection(database);
        request.readyState = "done";
        if (version > database.version) {
          database.version = version;
          request.onupgradeneeded?.({ target: request });
        }
        request.onsuccess?.({ target: request });
      }, 0);
      return request;
    },
  };

  return {
    factory: factory as unknown as IDBFactory,
    transactions,
    openConnections: () => connections,
    failRequests: (match, error) => {
      failure = { match, error };
    },
    stored: (database, store, key) =>
      databases.get(database)?.stores.get(store)?.get(key),
  };
}
