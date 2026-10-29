import { useEffect, useRef, useState } from "react";

import { Anchor, Button, Textarea, VisuallyHidden } from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import {
  listManagedExchanges,
  openManagedExchangeDatabase,
} from "@psi/managed/managedExchangeStore";
import { listManagedLocalState } from "@psi/managed/managedLocalState";

import {
  PASTE_INVITATION_FIELD_ID,
  isDemoSiteInvitationLink,
  tokenFromInput,
} from "@psi/invitation";

import { defaultRelayBuild, isConsoleBuild } from "@utils/clientConfig";
import { isInstalledRuntime } from "@utils/installedRuntime";

import { addSampleInputs } from "@psi/jobClient/workInputClient";

import { AppPage } from "@components/AppPage";
import { HOSTED_WEB_APP_ADDRESS } from "@console/signalingServerModel";
import { loadSavedExchanges } from "@recurring/savedExchangesLoad";
import { sampleInputsFailure } from "@console/ConsoleSampleData";
import styles from "@styles/app.module.css";

import { HOME_HEADLINE, HOME_TAGLINE } from "./homeCopy";
import { INSTRUCTIONS_URL, userGuideUrl } from "./userGuide";
import { HOSTED_FILE_ASSURANCE } from "./fileAssurance";
import { SampleCsvLinks } from "./SampleCsvLinks";

/** The paste card's heading, which names the invitation field. */
const PASTE_INVITATION_HEADING_ID = "paste-invitation-heading";

/**
 * The paste field's error for a full invitation link made on the demo site,
 * on a build that offers its default relay switched off.
 *
 * @internal exported for testing
 */
export const DEMO_SITE_LINK_REFUSAL =
  "This link opens an invitation on the demo site, so it was not opened " +
  "here. Open the link itself in your browser to accept it there.";

/**
 * The console start page's relay pointer: where a console sets a relay.
 *
 * @internal exported for testing
 */
export const CONSOLE_RELAY_POINTER =
  "If using peer-to-peer, some workplace networks may block the connection. " +
  "Your IT team can give you a relay server address. To use it, create an " +
  "invitation, choose Over WebRTC, run here on its review step, and choose " +
  "Set a relay.";

/**
 * The quick path's screen: two primary actions side by side -- invite a partner to a
 * one-off exchange, or paste an invitation you were sent -- then the first-visit
 * help, the how-it-works explanation, and the restore and relay pointers. It has its
 * own route at `/quick` and is also the home route's first-run landing (an empty or
 * unavailable managed store at `/` renders it directly, with no redirect); the
 * recurring-exchange list lives at `/saved`, which this screen links to on a hosted
 * build. A console build has no recurring surface, so it omits that pointer.
 */
export function Lobby() {
  const navigate = useNavigate();
  const [invitation, setInvitation] = useState("");
  const [invitationError, setInvitationError] = useState<string>();

  // Whether this browser already holds a saved recurring exchange, read once
  // on mount. Gates the "run it again" pointer below; the restore-from-backup
  // pointer stands regardless (see savedExchangesLoad / /saved). Stays undefined
  // until the async store read settles, so the pointer slot renders nothing
  // rather than flashing the wrong empty-state copy (the /quick path reaches
  // this screen with a populated store).
  const [hasSavedExchanges, setHasSavedExchanges] = useState<boolean>();
  useEffect(() => {
    // The managed store is not a console concept, and a console build renders no
    // pointer to it, so it reads nothing.
    if (isConsoleBuild()) return;
    let live = true;
    void loadSavedExchanges({
      openStore: openManagedExchangeDatabase,
      listExchanges: listManagedExchanges,
      listLocalState: listManagedLocalState,
      now: Date.now,
    }).then((result) => {
      if (live)
        setHasSavedExchanges(result.kind === "ready" && result.rows.length > 0);
    });
    return () => {
      live = false;
    };
  }, []);

  // "Review invitation" peels the token out of whatever was pasted -- a bare code
  // or a deep-link URL -- via the shared tokenFromInput helper, and routes to the
  // accept console with the token in the URL fragment, never a search param. An
  // empty extraction shows the inline field error and does not navigate, as
  // does a demo-site link where this build offers its default relay switched
  // off; the demo site is the build whose relay is on (docs/DEPLOYMENT.md).
  function reviewInvitation() {
    if (
      defaultRelayBuild().kind === "opt-in" &&
      isDemoSiteInvitationLink(invitation)
    ) {
      setInvitationError(DEMO_SITE_LINK_REFUSAL);
      return;
    }
    const token = tokenFromInput(invitation);
    if (token === "") {
      setInvitationError("An invitation is required");
      return;
    }
    void navigate({ to: "/accept", hash: token });
  }

  // Focus the field when the fragment names it.
  const invitationFieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (window.location.hash === `#${PASTE_INVITATION_FIELD_ID}`)
      invitationFieldRef.current?.focus();
  }, []);

  const [addingSamples, setAddingSamples] = useState(false);
  const [sampleFailure, setSampleFailure] = useState<string>();

  // A full navigation, not the SPA Link: the inviter reads `?demo=1` from the
  // real URL on mount, and the route has no typed search schema to hold it.
  // The console reads no file in the browser, so it writes the sample into its
  // folder for the picker to list instead.
  async function loadSample() {
    if (!isConsoleBuild()) {
      window.location.assign("/exchange?demo=1");
      return;
    }
    setAddingSamples(true);
    setSampleFailure(undefined);
    const failure = sampleInputsFailure(await addSampleInputs());
    setAddingSamples(false);
    if (failure !== undefined) {
      setSampleFailure(failure);
      return;
    }
    void navigate({ to: "/exchange" });
  }

  return (
    <AppPage>
      <main
        className={
          isConsoleBuild()
            ? `${styles.lobby} ${styles.lobbyFullWidth} ${styles.lobbyWide}`
            : `${styles.lobby} ${styles.lobbyFullWidth}`
        }
      >
        <h1>{HOME_HEADLINE}</h1>
        <p className={styles.tagline}>{HOME_TAGLINE}</p>
        <VisuallyHidden component="h2">
          Start a private data exchange
        </VisuallyHidden>
        <div className={styles.lobbyActions}>
          <div className={styles.actionCard}>
            <h3>Invite a partner</h3>
            <p className={`${styles.small} ${styles.sub}`}>
              Choose a file, confirm what you disclose, and share an invitation.
            </p>
            <p>
              <Button component={Link} to="/exchange">
                Create an invitation
              </Button>
            </p>
          </div>
          <div className={styles.actionCard}>
            <h3 id={PASTE_INVITATION_HEADING_ID}>
              Have an invitation? Paste it here
            </h3>
            <Textarea
              id={PASTE_INVITATION_FIELD_ID}
              ref={invitationFieldRef}
              aria-labelledby={PASTE_INVITATION_HEADING_ID}
              placeholder="Paste the invitation link or text"
              rows={2}
              value={invitation}
              error={invitationError}
              errorProps={{ role: "alert" }}
              onChange={(event) => {
                setInvitation(event.currentTarget.value);
                if (invitationError !== undefined)
                  setInvitationError(undefined);
              }}
            />
            <p>
              <Button variant="outline" onClick={reviewInvitation}>
                Review invitation
              </Button>
            </p>
          </div>
          {/* The console's third path: a direct exchange the two parties arranged
              out of band (a shared server or folder, no invitation). Console-only --
              it drives the console's job API, which a hosted deployment does not run. */}
          {isConsoleBuild() && (
            <div className={styles.actionCard}>
              <h3>Skip the invitation</h3>
              <p className={`${styles.small} ${styles.sub}`}>
                Use an agreed server or shared folder, and run it together with
                your partner.
              </p>
              <p>
                <Button component={Link} to="/direct" variant="outline">
                  Start
                </Button>
              </p>
            </div>
          )}
        </div>
        <p className={`${styles.sub} ${styles.small}`}>
          First time here? Follow the{" "}
          <Anchor
            inherit
            href={userGuideUrl()}
            target="_blank"
            rel="noreferrer"
          >
            step-by-step instructions
            <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
          </Anchor>{" "}
          to run an exchange.
        </p>
        <p className={`${styles.sub} ${styles.small}`}>
          <Anchor
            inherit
            component="button"
            type="button"
            disabled={addingSamples}
            onClick={() => void loadSample()}
          >
            See how it works with example data
          </Anchor>
          {isConsoleBuild() ? (
            <>
              . This writes two sample files into your working folder and opens
              the invite screen, where you choose the first one. To run both
              sides, choose WebRTC when you create the invitation, then accept
              it in the{" "}
              <Anchor
                inherit
                href={HOSTED_WEB_APP_ADDRESS}
                target="_blank"
                rel="noreferrer"
              >
                public Alcove web app
                <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
              </Anchor>{" "}
              with the second file.
            </>
          ) : (
            ". This opens the invite screen with sample data loaded. To run both sides, open the invitation in another tab of this browser, where accepting it offers the sample partner file. To accept it in a different browser, download the partner CSV from the invite screen and choose it there."
          )}
        </p>
        {sampleFailure !== undefined && (
          <p className={`${styles.sub} ${styles.small}`} role="alert">
            {sampleFailure} You can <SampleCsvLinks /> and put it in your
            folder.
          </p>
        )}
        <div className={styles.howItWorks}>
          <h2 className={styles.lobbyHelpHeading}>How it works</h2>
          <p>
            {isConsoleBuild()
              ? "Alcove encrypts the fields you match on and compares them using a method called private set intersection, so neither of you sees the other's records that don't match. This console runs the exchange itself, over an SFTP server, a shared folder, or WebRTC, reading your file from your working folder. Over WebRTC your partner can use the public Alcove web app to invite you or to accept your invitation."
              : `Alcove encrypts the fields you match on and compares them using a method called private set intersection, so neither of you sees the other's records that don't match. ${HOSTED_FILE_ASSURANCE} A coordination server helps the two sides find each other. It never sees your data.`}
          </p>
        </div>
        <h2 className={styles.lobbyHelpHeading}>More options</h2>
        {!isConsoleBuild() && !isInstalledRuntime() && (
          <p className={`${styles.sub} ${styles.small}`}>
            For SFTP, a shared folder, or scheduled runs on your own servers,
            see the{" "}
            <Anchor
              inherit
              href={INSTRUCTIONS_URL}
              target="_blank"
              rel="noreferrer"
            >
              instructions for the other ways to use Alcove
              <VisuallyHidden> (opens in a new tab)</VisuallyHidden>
            </Anchor>
            .
          </p>
        )}
        {!isConsoleBuild() &&
          (hasSavedExchanges === undefined ? null : hasSavedExchanges ? (
            <p className={`${styles.sub} ${styles.small}`}>
              Saved an exchange to run again? Run it or restore it from a backup
              file on the{" "}
              <Anchor inherit component={Link} to="/saved">
                Recurring exchanges
              </Anchor>{" "}
              page.
            </p>
          ) : (
            <p className={`${styles.sub} ${styles.small}`}>
              Have a backup file from a saved exchange? Restore it on the{" "}
              <Anchor inherit component={Link} to="/saved">
                Recurring exchanges
              </Anchor>{" "}
              page.
            </p>
          ))}
        {isConsoleBuild() ? (
          <p className={`${styles.sub} ${styles.small}`}>
            {CONSOLE_RELAY_POINTER}
          </p>
        ) : (
          <p className={`${styles.sub} ${styles.small}`}>
            {
              "If you can't connect to your partner, your IT team can give you a relay server address to enter in "
            }
            <Anchor inherit component={Link} to="/relay">
              relay settings
            </Anchor>
            .
          </p>
        )}
      </main>
    </AppPage>
  );
}
