import "@styles/tokens.css";
import styles from "@styles/app.module.css";

import { isConsoleBuild } from "@utils/clientConfig";

import { SiteFooter } from "./SiteFooter";

import type { ReactNode } from "react";

/**
 * The full-height page surface every console route renders on: the background,
 * text color, and base type scale of the linkage console design. It is the
 * outermost console element and declares no landmark of its own -- the single
 * `<main>` is in {@link WorkShell}'s work column or a route's own lobby layout.
 * Every page, hosted or console, ends with the {@link SiteFooter}; the console
 * widens it to the console lobby column.
 */
export function AppPage({ children }: { children: ReactNode }) {
  return (
    <div className={styles.page}>
      {children}
      <SiteFooter wide={isConsoleBuild()} />
    </div>
  );
}
