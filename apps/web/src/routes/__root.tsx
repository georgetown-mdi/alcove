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
import { MantineProvider, mantineHtmlProps } from "@mantine/core";

import { cssVariablesResolver, mantineTheme } from "@theme";
import { AppShellStatus } from "@components/AppShellStatus";
import { DefaultCatchBoundary } from "@components/DefaultCatchBoundary";
import { NotFound } from "@components/NotFound";
import { PendingInvitationPrune } from "@exchange/PendingInvitationPrune";
import { ScheduledExchangeRunner } from "@components/ScheduledExchangeRunner";
import { rootDocumentHead } from "@utils/documentHead";

import type { ReactNode } from "react";

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
