import { vi } from "vitest";

import { createElement } from "react";

import type * as ExchangeLifecycleModule from "@psi/exchangeLifecycle";
import type {
  ParkedWebSocketRelayConnection,
  WebSocketRelayConnectionOptions,
} from "@psi/transport/websocketRelayConnection";
import type { ReactNode } from "react";
import type { RunCompletion } from "@psi/exchangeLifecycle";
import type { RunOutputs } from "@psi/runOutputs";

/**
 * Shared `vi.mock` factories for the modules the browser suite stubs
 * everywhere.
 *
 * A factory is pulled in with a dynamic import from inside the mock body --
 * `vi.mock("...", async () => (await import("./moduleMocks")).xMock())` --
 * since Vitest hoists `vi.mock` above the imports, so a factory that closes
 * over a top-level binding fails at mock resolution ("make sure there are no
 * top level variables inside"). A suite may still import this file at the top
 * to read what a stub captured ({@link lifecycleCalls}): that import and the
 * factory's dynamic one load the same module instance.
 */

/**
 * Settings a suite layers onto {@link reactRouterMock}.
 */
export interface ReactRouterMockOptions {
  /**
   * Called with the argument the component passed to the function
   * `useNavigate()` returned, for a suite asserting the navigation target. Left
   * unset, navigation is a silent no-op.
   */
  onNavigate?: (options: unknown) => void;
  /**
   * Render a Link's `href` as the path it resolves to: each `$name` segment of
   * `to` filled from `params`, and `#hash` appended. Left unset, the `href` is
   * the unresolved `to` template.
   */
  resolveLinks?: boolean;
}

/** A Link's `to` with its `$name` segments filled from `params`, plus `#hash`. */
function resolvedLinkHref(to: string, params: unknown, hash: unknown): string {
  const values = (params ?? {}) as Record<string, string>;
  const path = to.replace(/\$(\w+)/g, (_segment, name: string) =>
    encodeURIComponent(values[name] ?? ""),
  );
  return typeof hash === "string" && hash !== "" ? `${path}#${hash}` : path;
}

/**
 * Stubs `@tanstack/react-router` down to the boundary the component suites touch:
 * `Link` as a plain anchor exposing `to` as its `href` (resolved, under
 * {@link ReactRouterMockOptions.resolveLinks}), and `useNavigate` as a
 * function returning a navigate that does nothing beyond `onNavigate`.
 *
 * A real `RouterProvider` trips a duplicate-React dispatcher error in the browser
 * runner, so the router is stubbed, forwarding remaining props so a styled Link
 * (Mantine's `className`, `data-*`) still renders right.
 */
export function reactRouterMock(options: ReactRouterMockOptions = {}) {
  return {
    Link: ({
      to,
      children,
      ...rest
    }: {
      to?: string;
      children?: ReactNode;
      [prop: string]: unknown;
    }) => {
      if (options.resolveLinks === true) {
        const { params, hash, ...anchorProps } = rest;
        return createElement(
          "a",
          {
            ...anchorProps,
            href:
              typeof to === "string" ? resolvedLinkHref(to, params, hash) : "#",
          },
          children,
        );
      }
      return createElement(
        "a",
        { ...rest, href: typeof to === "string" ? to : "#" },
        children,
      );
    },
    useNavigate: () => (navigateOptions: unknown) => {
      options.onNavigate?.(navigateOptions);
      return undefined;
    },
  };
}

/**
 * Stubs `@psi/transport/rendezvous` for a suite mounting a component that
 * transitively imports it, so no test reaches a real signaling server and a
 * suite can assert on the dial and listen calls.
 */
export function rendezvousMock() {
  return {
    dialAsAcceptor: vi.fn(),
    listenAsInviter: vi.fn(),
    BROKER_REGISTRATION_TIMEOUT_MS: 30_000,
    brokerRegistrationTimedOutMessage: (timeoutMs: number) => {
      const seconds = Math.max(1, Math.round(timeoutMs / 1000));
      return (
        `The coordination server did not accept the connection within ` +
        `${seconds} second${seconds === 1 ? "" : "s"}. Check the network ` +
        `connection and try again; if it keeps happening, the coordination server ` +
        `may be down.`
      );
    },
  };
}

/** The exports of `@psi/exchangeLifecycle`, as the real module types them. */
type ExchangeLifecycleExports = typeof ExchangeLifecycleModule;

/** The options a screen's run handed `runExchangeLifecycle`, typed from the
 * real function at the outputs the screens run it with. */
export type CapturedLifecycle = Parameters<
  typeof ExchangeLifecycleModule.runExchangeLifecycle<RunOutputs>
>[0];

/** What a completed run hands its owner beside the outputs, for a test that
 * completes a captured run: a well-formed rotated secret. */
export const TEST_RUN_COMPLETION: RunCompletion = {
  rotatedSecret: `${"R".repeat(42)}A`,
};

/** Every run the {@link exchangeLifecycleMock} stub received in this test
 * file, oldest first. A suite that reads it empties it after each test. */
export const lifecycleCalls: Array<CapturedLifecycle> = [];

/** The run at `index` in {@link lifecycleCalls}, failing by name when the
 * stub received fewer runs than that. */
export function lifecycleCall(index: number): CapturedLifecycle {
  const call = lifecycleCalls.at(index);
  if (call === undefined)
    throw new Error(
      `no run at index ${index}: the lifecycle was run ${lifecycleCalls.length} times`,
    );
  return call;
}

/**
 * Stubs `@psi/exchangeLifecycle` over the real module so no run dials:
 * `runExchangeLifecycle` records its options in {@link lifecycleCalls}, so a
 * test can fire the same callbacks the real lifecycle fires. `settle`, when
 * given, is what each run then does, for a suite whose run ends by itself.
 */
export async function exchangeLifecycleMock(
  importOriginal: () => Promise<ExchangeLifecycleExports>,
  settle: (options: CapturedLifecycle) => Promise<void> = () =>
    Promise.resolve(),
): Promise<ExchangeLifecycleExports> {
  const runExchangeLifecycle = (options: CapturedLifecycle): Promise<void> => {
    lifecycleCalls.push(options);
    return settle(options);
  };
  return {
    ...(await importOriginal()),
    // The real function is generic over its outputs; the stub fixes them at
    // the screens' type.
    runExchangeLifecycle:
      runExchangeLifecycle as ExchangeLifecycleExports["runExchangeLifecycle"],
  };
}

/** Each relay {@link unpairedRelay} parked: its options and whether it closed. */
export const parkedRelays: Array<{
  options: WebSocketRelayConnectionOptions;
  closed: boolean;
}> = [];

/**
 * A `parkWebSocketRelayConnection` stand-in for a suite with no relay to
 * reach: the relay never pairs, so WebRTC alone settles the run, and each call
 * is recorded in {@link parkedRelays}.
 */
export function unpairedRelay(
  options: WebSocketRelayConnectionOptions,
): ParkedWebSocketRelayConnection {
  const record = { options, closed: false };
  parkedRelays.push(record);
  return {
    url: options.url,
    paired: false,
    partnerStarted: false,
    failure: undefined,
    onChange: () => () => {},
    start: () => new Promise<never>(() => {}),
    close: () => {
      record.closed = true;
    },
  };
}
