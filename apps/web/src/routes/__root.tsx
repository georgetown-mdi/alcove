/// <reference types="vite/client" />
import {
  HeadContent,
  Outlet,
  Scripts,
  createRootRoute,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import "@mantine/core/styles.css";
import "@mantine/dropzone/styles.css";
import {
  ColorSchemeScript,
  MantineProvider,
  mantineHtmlProps,
} from "@mantine/core";

import { cssVariablesResolver, mantineTheme } from "@theme";
import { AppShellStatus } from "@components/AppShellStatus";
import { DefaultCatchBoundary } from "@components/DefaultCatchBoundary";
import { NotFound } from "@components/NotFound";
import { PendingInvitationPrune } from "@exchange/PendingInvitationPrune";
import { ScheduledExchangeRunner } from "@components/ScheduledExchangeRunner";
import { rootDocumentHead } from "@utils/documentHead";

import type { ReactNode } from "react";

declare global {
  interface ImportMetaEnv {
    /** Set by the console and hosted static builds (`vite.console.config.ts`,
     * `vite.hosted.config.ts`), whose client renders the whole document
     * itself; unset in the Start build. */
    readonly CLIENT_RENDERED_DOCUMENT?: boolean;
  }
}

export const Route = createRootRoute({
  head: () => ({
    meta: [...rootDocumentHead.meta],
    links: [...rootDocumentHead.links],
  }),
  errorComponent: DefaultCatchBoundary,
  notFoundComponent: () => <NotFound />,
  component: RootComponent,
});

function RootComponent() {
  // Every route renders on the console, which supplies its own page surface and
  // landmarks (see AppPage/WorkShell), so the root gives the whole viewport to
  // the route Outlet with no shared wrapper.
  return (
    <RootDocument>
      <Outlet />
    </RootDocument>
  );
}

function RootDocument({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" {...mantineHtmlProps}>
      <head>
        <HeadContent />
        {/* A script React renders on the client never runs, so a document
            rendered there has no use for one. */}
        {import.meta.env.CLIENT_RENDERED_DOCUMENT ? null : (
          <ColorSchemeScript />
        )}
      </head>
      <body>
        <MantineProvider
          theme={mantineTheme}
          cssVariablesResolver={cssVariablesResolver}
        >
          <AppShellStatus />
          <ScheduledExchangeRunner />
          <PendingInvitationPrune />
          {children}
          <TanStackRouterDevtools position="bottom-right" />
          <Scripts />
        </MantineProvider>
      </body>
    </html>
  );
}
