import { vi } from "vitest";

import { createElement } from "react";

import type { ReactNode } from "react";

/**
 * Shared `vi.mock` factories for the two modules the browser suite stubs
 * everywhere.
 *
 * A factory is pulled in with a dynamic import from inside the mock body --
 * `vi.mock("...", async () => (await import("./moduleMocks")).xMock())` --
 * never a top-level import of this file: Vitest hoists `vi.mock` above the
 * imports, so a factory that closes over a top-level binding fails at mock
 * resolution ("make sure there are no top level variables inside").
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
}

/**
 * Stubs `@tanstack/react-router` down to the boundary the component suites touch:
 * `Link` as a plain anchor exposing `to` as its `href`, and `useNavigate` as a
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
    }) =>
      createElement(
        "a",
        { ...rest, href: typeof to === "string" ? to : "#" },
        children,
      ),
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
        `The signaling server did not accept the connection within ` +
        `${seconds} second${seconds === 1 ? "" : "s"}. Check the network ` +
        `connection and try again; if it keeps happening, the signaling server ` +
        `may be down.`
      );
    },
  };
}
