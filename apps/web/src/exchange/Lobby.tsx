import { useEffect, useRef, useState } from "react";

import { Anchor, Button, Textarea, VisuallyHidden } from "@mantine/core";
import { Link, useNavigate } from "@tanstack/react-router";

import {
  listManagedExchanges,
  openManagedExchangeDatabase,
} from "@psi/managed/managedExchangeStore";
import { listManagedLocalState } from "@psi/managed/managedLocalState";

import { PASTE_INVITATION_FIELD_ID, tokenFromInput } from "@psi/invitation";

import { isConsoleBuild } from "@utils/clientConfig";
import { isInstalledRuntime } from "@utils/installedRuntime";

import { addSampleInputs } from "@psi/jobClient/workInputClient";

import { AppPage } from "@components/AppPage";
import { loadSavedExchanges } from "@recurring/savedExchangesLoad";
import { sampleInputsFailure } from "@console/ConsoleSampleData";
import styles from "@styles/app.module.css";

import { HOME_HEADLINE, HOME_TAGLINE } from "./homeCopy";
import { OTHER_WAYS_TO_USE_ALCOVE_URL, userGuideUrl } from "./userGuide";
import { downloadSampleCsvs } from "./sampleData";

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
  // empty extraction shows the inline field error and does not navigate.
  function reviewInvitation() {
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
      downloadSampleCsvs();
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
            ? `${styles.lobby} ${styles.lobbyWide}`
            : styles.lobby
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
            <h3>Have an invitation? Paste it here</h3>
            <Textarea
              id={PASTE_INVITATION_FIELD_ID}
              ref={invitationFieldRef}
              aria-label="Invitation"
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
            <p className={`${styles.small} ${styles.sub}`}>
              You can review the exchange before starting it.
            </p>
          </div>
          {/* The console's third path: a direct exchange the two parties arranged
              out of band (a shared server, no invitation). Console-only -- it drives
              the console's job API, which a hosted deployment does not run. */}
          {isConsoleBuild() && (
            <div className={styles.actionCard}>
              <h3>Enter server information</h3>
              <p className={`${styles.small} ${styles.sub}`}>
                You and your partner already have a server you will use. No
                invitation needed.
              </p>
              <p>
                <Button component={Link} to="/direct" variant="outline">
                  Run a quick exchange
                </Button>
              </p>
            </div>
          )}
        </div>
        <p className={`${styles.sub} ${styles.small}`}>
          First time here? The{" "}
          <Anchor
            inherit
            href={userGuideUrl()}
            target="_blank"
            rel="noreferrer"
          >
            user guide (on GitHub)
          </Anchor>{" "}
          walks through running an exchange step by step.
        </p>
        <p className={`${styles.sub} ${styles.small}`}>
          No data to link yet?{" "}
          <Anchor
            inherit
            component="button"
            type="button"
            disabled={addingSamples}
            onClick={() => void loadSample()}
          >
            See how it works with example data
          </Anchor>
          {isConsoleBuild()
            ? ". This writes two sample files into your working folder and opens the invite screen with the first one. To play your partner, accept the invitation in the public Alcove web app with the second file."
            : ". This downloads two sample files and opens the invite screen with the first one. To play your partner, open the invitation in another browser tab and accept it with the second file."}
        </p>
        {sampleFailure !== undefined && (
          <p className={`${styles.sub} ${styles.small}`} role="alert">
            {sampleFailure}{" "}
            <Anchor
              inherit
              component="button"
              type="button"
              onClick={downloadSampleCsvs}
            >
              Download the CSVs
            </Anchor>
          </p>
        )}
        <div className={styles.howItWorks}>
          <p>
            <strong>How it works.</strong>{" "}
            {isConsoleBuild()
              ? "Alcove encrypts the fields you match on and compares them using a method called private set intersection, so neither of you sees the other's records that don't match. This console runs the exchange itself, over an SFTP server, a shared folder or WebRTC, reading your file from your working folder. Over WebRTC your partner can use the public Alcove web app to invite you or to accept your invitation."
              : "Alcove encrypts the fields you match on and compares them using a method called private set intersection, so neither of you sees the other's records that don't match. Data is encrypted locally in your browser before being sent to your partner. A coordination server only helps the two browsers find each other to establish a secure peer-to-peer connection."}
          </p>
        </div>
        <h2 className={styles.lobbyHelpHeading}>Other connection options</h2>
        {!isConsoleBuild() && !isInstalledRuntime() && (
          <p className={`${styles.sub} ${styles.small}`}>
            For SFTP, a shared folder, or scheduled runs on your own servers,
            see the{" "}
            <Anchor
              inherit
              href={OTHER_WAYS_TO_USE_ALCOVE_URL}
              target="_blank"
              rel="noreferrer"
            >
              other ways to use Alcove (on GitHub)
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
        <p className={`${styles.sub} ${styles.small}`}>
          {isConsoleBuild()
            ? "If using peer-to-peer, some workplace networks may block the connection. Your IT team can give you a relay server address to enter in "
            : "Some workplace networks block the default peer-to-peer approach. Your IT team can give you a relay server address to enter in "}
          <Anchor inherit component={Link} to="/relay">
            relay settings
          </Anchor>
          .
        </p>
      </main>
    </AppPage>
  );
}
