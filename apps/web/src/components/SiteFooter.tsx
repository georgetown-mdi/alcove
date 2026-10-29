import { Anchor, VisuallyHidden } from "@mantine/core";

import styles from "@styles/app.module.css";

import {
  DOCUMENTATION_URL,
  MDI_PETS_URL,
  PRIVACY_URL,
  SECURITY_URL,
  SOURCE_CODE_URL,
  SUPPORT_URL,
} from "./projectLinks";

const FOOTER_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Documentation", href: DOCUMENTATION_URL },
  { label: "Privacy", href: PRIVACY_URL },
  { label: "Security", href: SECURITY_URL },
  { label: "Support", href: SUPPORT_URL },
  { label: "Source code on GitHub", href: SOURCE_CODE_URL },
];

/**
 * The site footer: who builds Alcove, its documentation, privacy, security and
 * support pages on the project site, and its source code on GitHub. `wide`
 * matches the console lobby column.
 */
export function SiteFooter({ wide = false }: { wide?: boolean }) {
  return (
    <footer
      className={
        wide
          ? `${styles.siteFooter} ${styles.siteFooterWide}`
          : styles.siteFooter
      }
    >
      <p>
        Alcove is open-source software built by{" "}
        <Anchor inherit href={MDI_PETS_URL} target="_blank" rel="noreferrer">
          Georgetown&apos;s Massive Data Institute
          <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
        </Anchor>
        .
      </p>
      <div className={styles.siteFooterLinks}>
        <span>More about Alcove:</span>
        {FOOTER_LINKS.map(({ label, href }) => (
          <Anchor
            key={label}
            inherit
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            {label}
            <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
          </Anchor>
        ))}
      </div>
    </footer>
  );
}
