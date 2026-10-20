import { Anchor } from "@mantine/core";

import styles from "@styles/app.module.css";

import {
  PRIVACY_URL,
  SECURITY_URL,
  SOURCE_CODE_URL,
  SUPPORT_URL,
} from "./projectLinks";

const FOOTER_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: "Privacy", href: PRIVACY_URL },
  { label: "Security", href: SECURITY_URL },
  { label: "Support", href: SUPPORT_URL },
  { label: "Source code", href: SOURCE_CODE_URL },
];

/**
 * The hosted site's footer: who builds Alcove, and its privacy, security,
 * support and source pages, all on GitHub.
 */
export function SiteFooter() {
  return (
    <footer className={styles.siteFooter}>
      <p>
        Alcove is open-source software built by Georgetown&apos;s Massive Data
        Institute.
      </p>
      <div className={styles.siteFooterLinks}>
        {FOOTER_LINKS.map(({ label, href }) => (
          <Anchor
            key={label}
            inherit
            href={href}
            target="_blank"
            rel="noreferrer"
          >
            {label}
          </Anchor>
        ))}
        <span>(all on GitHub)</span>
      </div>
    </footer>
  );
}
