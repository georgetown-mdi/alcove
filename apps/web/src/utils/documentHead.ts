import { seo } from "./seo";

/** A `<meta>` or `<title>` entry, in the shape the router's `head` takes. */
export type DocumentHeadMeta =
  | { readonly title: string }
  | { readonly charSet: string }
  | { readonly name: string; readonly content: string | undefined }
  | { readonly property: string; readonly content: string | undefined };

/** A `<link>` entry, in the shape the router's `head` takes. */
export interface DocumentHeadLink {
  readonly rel: string;
  readonly href: string;
  readonly type?: string;
  readonly sizes?: string;
}

/**
 * The head every document of the app starts from: the root route renders it,
 * and the hosted static build writes it into each document it emits, so a page
 * served before any script runs has its title, icons and manifest.
 */
export const rootDocumentHead: {
  readonly meta: ReadonlyArray<DocumentHeadMeta>;
  readonly links: ReadonlyArray<DocumentHeadLink>;
} = {
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
};
