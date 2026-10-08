import logLibrary from "loglevel";

import { redactPrivateKeyMaterial } from "./sanitizeErrorForDisplay";

const { getLevel } = logLibrary;

const PREFIXED = Symbol("prefixed");

const logLevels = logLibrary.levels;

/**
 * Where prefixed loggers send diagnostic output once an application installs
 * it with {@link setDiagnosticSink} (the CLI: stderr or `--log-file`). It
 * receives the loglevel method name, the `[ISO] [LEVEL] [CONTEXT]` prefix, and
 * the unformatted arguments with private-key blocks stripped from the string
 * ones; the sink owns formatting, which keeps core browser-safe. Unset, output
 * keeps loglevel's per-level `console` routing, which the web app uses.
 */
export type DiagnosticSink = (
  methodName: logLibrary.LogLevelNames,
  prefix: string,
  args: unknown[],
) => void;

// Read at each log call rather than bound per logger: loglevel freezes a
// logger's method at creation, and loggers built at import time must still
// reach a sink installed later.
let diagnosticSink: DiagnosticSink | undefined;

/**
 * Install, or with `undefined` clear, the process-wide {@link DiagnosticSink}.
 * It takes effect for loggers that already exist as well as later ones. Pair
 * with {@link getDiagnosticSink} to restore the previous sink.
 */
export const setDiagnosticSink = (sink: DiagnosticSink | undefined): void => {
  diagnosticSink = sink;
};

/** The installed {@link DiagnosticSink}, or `undefined` for console routing. */
export const getDiagnosticSink = (): DiagnosticSink | undefined =>
  diagnosticSink;

/**
 * Apply `level` to every logger, existing and later, so a module-scope logger
 * built at import time does not keep loglevel's `warn` default. `level` is a
 * number or a level name in either case; loglevel throws a `TypeError` on one
 * naming no level. The sweep uses `Reflect.ownKeys` so symbol-named loggers are
 * reached, and `persist: false` so a browser's web storage is not written.
 *
 * Known limit: in a browser with a persisted root or per-logger level,
 * loglevel keeps that level for loggers built after the sweep.
 *
 * Call it at bootstrap: it overwrites levels {@link getLoggerForVerbosity} has
 * floored, and rebuilds each logger's methods, so a method reference captured
 * beforehand (a spy, a destructured `log.warn`) is stale.
 */
export const setLogLevel = (level: logLibrary.LogLevelDesc): void => {
  logLibrary.setDefaultLevel(level);
  const registry = logLibrary.getLoggers() as Record<
    string | symbol,
    logLibrary.Logger
  >;
  for (const name of Reflect.ownKeys(registry))
    registry[name].setLevel(level, false);
};

export const getLoggerForVerbosity = (
  name: string | symbol,
  verbosity: number,
) => {
  const preferredLogLevel =
    verbosity >= 2
      ? logLevels.TRACE
      : verbosity === 1
        ? logLevels.DEBUG
        : verbosity < 0
          ? logLevels.WARN
          : logLevels.INFO;

  const result = logLibrary.getLogger(name);
  const currentLevel = getLevel();

  result.setLevel(
    // lower number levels include more information
    preferredLogLevel >= currentLevel ? preferredLogLevel : currentLevel,
    false,
  );

  setLogPrefixer(result);

  return result;
};

export const getLogger = (name: string | symbol) => {
  const result = logLibrary.getLogger(name);

  setLogPrefixer(result);

  return result;
};

/**
 * The `[ISO] [LEVEL] [CONTEXT]` prefix a prefixed logger puts ahead of every
 * line, and that a consumer reading its own log back matches on.
 */
export const formatLogPrefix = (
  timestamp: string,
  methodName: logLibrary.LogLevelNames,
  context: string,
): string => `[${timestamp}] [${methodName.toUpperCase()}] [${context}]`;

const setLogPrefixer = (logger: logLibrary.Logger) => {
  if ((logger as unknown as Record<symbol, boolean>)[PREFIXED]) return;
  (logger as unknown as Record<symbol, boolean>)[PREFIXED] = true;
  const originalFactory = logger.methodFactory;
  logger.methodFactory = (
    methodName: logLibrary.LogLevelNames,
    level: logLibrary.LogLevelNumbers,
    loggerName: string | symbol,
  ) => {
    const rawMethod = originalFactory(methodName, level, loggerName);

    return (...messageArgs) => {
      const prefix = formatLogPrefix(
        new Date().toISOString(),
        methodName,
        String(loggerName || "root"),
      );

      // Redacted here so both routings below are covered. Per string argument
      // only: a key split across two arguments is not seen, and joining them
      // would let a dangling marker consume every later argument. See
      // docs/spec/CHANNEL_SECURITY.md#display-sanitization-escape-format.
      const redactedArgs = messageArgs.map((arg) =>
        typeof arg === "string" ? redactPrivateKeyMaterial(arg) : arg,
      );

      const sink = diagnosticSink;
      if (sink !== undefined) {
        sink(methodName, prefix, redactedArgs);
      } else {
        rawMethod(prefix, ...redactedArgs);
      }
    };
  };

  // Rebuilds the logger's methods through the factory above; `persist: false`
  // keeps the level out of a browser's web storage.
  logger.setLevel(logger.getLevel(), false);
};
