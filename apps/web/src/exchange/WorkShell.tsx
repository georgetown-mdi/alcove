import { Fragment } from "react";

import { AppPage } from "@components/AppPage";
import styles from "@styles/app.module.css";

import { HelpLink } from "./TopBar";
import { useNarrowViewport } from "./narrowViewport";

import type { ReactNode } from "react";

/**
 * The linkage console's working surface: a full-width top bar above a two-region
 * grid, the work column in the center and the standing disclosure ledger on
 * the right. The work column is the page's single `<main>` landmark; the
 * ledger is a landmark of its own (`<aside>` in {@link Ledger}), as is the
 * top bar's Stepper nav (see {@link TopBar}). Omitting both `topBar` and
 * `ledger` collapses to the single-column "plain" layout {@link
 * VerifyReceiptScreen} uses; omitting only the ledger keeps the work column
 * alone under the top bar.
 *
 * At or below the narrow cut-over the ledger is placed AHEAD of the work
 * column in the DOM, so its collapsible share bar (see {@link Ledger}) is the
 * page's first interactive element -- a focus/DOM-order commitment CSS
 * reordering alone cannot make. The two regions render as a keyed array so a
 * live breakpoint crossing (docking, rotation, devtools) is a reconciler MOVE:
 * both subtrees keep their instances and local state (in-progress fields,
 * reveal toggles, live-region identity). The browser does drop focus when the
 * node containing the focused element moves -- inherent to the DOM move, not
 * something keying can prevent.
 *
 * The top bar leaves its Help link out at that width, so with a top bar the
 * shell places it after the ledger instead: after the share bar in Tab order,
 * ahead of the work column.
 */
export function WorkShell({
  topBar,
  ledger,
  children,
}: {
  topBar?: ReactNode;
  ledger?: ReactNode;
  children: ReactNode;
}) {
  const narrow = useNarrowViewport();
  // gridUnderBar raises the ledger's sticky offset above the stuck top bar;
  // a ledger with no bar keeps the plain offset.
  const gridClass =
    topBar === undefined && ledger === undefined
      ? `${styles.grid} ${styles.gridPlain}`
      : ledger === undefined
        ? styles.grid
        : topBar === undefined
          ? `${styles.grid} ${styles.gridLedger}`
          : `${styles.grid} ${styles.gridLedger} ${styles.gridUnderBar}`;
  const work = (
    <main key="work" className={styles.work}>
      {children}
    </main>
  );
  const ledgerRegion =
    ledger === undefined ? undefined : (
      <Fragment key="ledger">{ledger}</Fragment>
    );
  const narrowHelp =
    topBar === undefined ? undefined : (
      <p key="help" className={styles.narrowHelp}>
        <HelpLink />
      </p>
    );
  return (
    <AppPage>
      {topBar}
      <div className={gridClass}>
        {narrow ? [ledgerRegion, narrowHelp, work] : [work, ledgerRegion]}
      </div>
    </AppPage>
  );
}
