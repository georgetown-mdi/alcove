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
import { seo } from "@utils/seo";

import type { ReactNode } from "react";

declare global {
  interface ImportMetaEnv {
    /** Set by the console build (`vite.console.config.ts`), whose client
     * renders the whole document itself; unset in every other build. */
    readonly CLIENT_RENDERED_DOCUMENT?: boolean;
  }
}

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        // Matches the manifest's theme_color and the console's background, so an
        // installed window's title bar takes the app's color rather than
        // browser white.
        name: "theme-color",
        content: "#f6f5f1",
      },
      ...seo({
        title: "Alcove - encrypted matching and sharing",
        description:
          "Find the records you both hold - without either of you seeing the other's data.",
      }),
    ],
    links: [
      {
        rel: "apple-touch-icon",
        sizes: "180x180",
        href: "/apple-touch-icon.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "32x32",
        href: "/favicon-32x32.png",
      },
      {
        rel: "icon",
        type: "image/png",
        sizes: "16x16",
        href: "/favicon-16x16.png",
      },
      { rel: "manifest", href: "/site.webmanifest" },
      { rel: "icon", href: "/favicon.ico" },
    ],
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
