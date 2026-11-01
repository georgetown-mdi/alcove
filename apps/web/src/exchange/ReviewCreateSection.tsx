import { useMemo } from "react";

import {
  Alert,
  Button,
  NativeSelect,
  Radio,
  Stack,
  Text,
  VisuallyHidden,
} from "@mantine/core";
import { IconAlertTriangle } from "@tabler/icons-react";
import { sanitizeForDisplay } from "@alcove/core";

import {
  buildAdvancedTerms,
  inertCoalesceNotice,
} from "@psi/authoring/advancedInvite";

import { isConsoleBuild } from "@utils/clientConfig";
import { useDeferredAnnouncement } from "@components/useDeferredAnnouncement";
import { useOnlineStatus } from "@components/useOnlineStatus";

import { AllowedRelaysField } from "@components/AllowedRelaysField";
import { CREATED_INVITATION_ALLOWED_RELAYS_SCOPE } from "@psi/transport/relayRestriction";

import { LIFETIME_CHOICES, expiryLabel } from "@psi/formatting";
import { answersRows, inviterCreateStatus } from "@psi/inviterModel";
import {
  availableTransports,
  transportChooserCopy,
  transportRunMode,
} from "@psi/transportChooser";
import {
  receiptsProblems,
  signingIdentityDivergence,
} from "@psi/receiptsModel";
import { runDiagnosticsProblems } from "@psi/runDiagnosticsModel";

import {
  CONFIGURATION_ALREADY_SAVED,
  CONFIGURATION_SAVED,
  CONVERT_CONFIGURATION_LABEL,
  OPENED_ALLOWED_RELAYS_ONLY,
  OPENED_EXCHANGE_CONTINUES,
  OPENED_EXCHANGE_RUNS_IN_PLACE,
  OPENED_NO_ALLOWED_RELAYS,
  OPENED_SIGNALING_SERVER_NOTE,
  OPENED_SIGNALING_SERVER_UNREADABLE,
  REOPEN_CONFIGURATION_LABEL,
  START_OPENED_EXCHANGE_LABEL,
} from "@console/mountedConfiguration";
import {
  CONFIG_EXCHANGE_FILES,
  exchangeFilesProblems,
} from "@console/exchangeFilesModel";
import {
  COORDINATION_SERVER_LOADING,
  COORDINATION_SERVER_MISSING,
} from "@console/signalingServerModel";
import {
  connectionTuningCapabilitiesFor,
  connectionTuningProblems,
} from "@console/connectionTuningModel";
import { ConnectionTuningCard } from "@console/ConnectionTuningCard";
import { EditedTermsNotice } from "@console/MountedConfigurationCard";
import { ExchangeFilesCard } from "@console/ExchangeFilesCard";
import { ReceiptsCard } from "@console/ReceiptsCard";
import { RelayCheckPanel } from "@console/RelayCheckPanel";
import { RunDiagnosticsCard } from "@console/RunDiagnosticsCard";
import { SftpConnectionCard } from "@console/SftpConnectionCard";
import { SharedFolderExposureNotice } from "@console/SharedFolderExposureNotice";
import { SignalingServerCard } from "@console/SignalingServerCard";
import { splitDirectoryRetainProblem } from "@console/sftpConnectionChoice";
import { splitRendezvousRetainProblem } from "@console/filedropRendezvousChoice";
import styles from "@styles/app.module.css";

import { ALLOWED_RELAYS_GUIDE_URL } from "./userGuide";
import { DefaultRelayNotice } from "./DefaultRelayNotice";
import { UnreadableCoordinationServerNotice } from "./CoordinationServerSection";

import {
  INVITER_RESET_STATEMENT,
  ResetToDefaultsButton,
} from "./ResetToDefaultsButton";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type { SpineProblem, SpineTarget } from "@psi/inviterModel";
import type { Transport } from "@psi/transportChooser";

import type {
  ConfigurationSaveState,
  EditedTermsWarning,
  InPlaceSigningIdentityShown,
} from "@console/mountedConfiguration";
import type { ConnectionTuningDraft } from "@console/connectionTuningModel";
import type { ExchangeFilesDraft } from "@console/exchangeFilesModel";
import type { JobRendezvousConfig } from "@psi/jobClient/workInputClient";
import type { ReceiptsDraft } from "@psi/receiptsModel";
import type { RunDiagnosticsDraft } from "@psi/runDiagnosticsModel";
import type { SftpConnectionFormValues } from "@console/sftpConnectionForm";
import type { SftpConnectionProjection } from "@jobContract/sftpConnection";
import type { SignalingServerProjection } from "@jobContract/signalingServer";

/**
 * Step 3 of the inviter spine: the review-time decisions (lifetime and
 * transport), the check-your-answers restatement of the whole
 * proposal, and the create action -- the point of no return whose copy
 * says so. The transport chooser offers the live-browser exchange and the two
 * command-line transports (SFTP and a shared directory); its copy comes from
 * {@link transportChooserCopy}, which reflects whether the deployment runs a
 * shared-directory or SFTP exchange here (the console) or saves an
 * exchange file for the command-line tool. On a console build, choosing SFTP
 * shows the authored connection's locator under the card: the exchange runs here
 * through that connection, and the connection material stays on the console.
 * The console also offers WebRTC, run here through the coordination server set
 * under its card.
 */
export function ReviewCreateSection({
  editor,
  csv,
  problems,
  minting,
  sftpConnection,
  signalingServer,
  onSignalingServer,
  configurationOpened = false,
  openedRunsInPlace = false,
  openedSignalingServer,
  openedRelayTurnUrls = [],
  openedAllowedRelays,
  loadedSftpForm,
  sftpSaveFilePreferred,
  runWithheld,
  continuesOpenedExchange = false,
  editedTermsWarning,
  connectionSettingsHeld,
  rendezvous,
  exchangeFiles,
  onExchangeFiles,
  connectionTuning,
  onConnectionTuning,
  runDiagnostics,
  onRunDiagnostics,
  receipts,
  inPlaceSigningIdentity,
  onReceipts,
  onLifetime,
  onTransport,
  onAuthorConnection,
  onClearConnection,
  onUseCliForSftp,
  onRunHereForSftp,
  onReset,
  onCreate,
  onNavigate,
  configurationSave,
  onSaveConfiguration,
  onReopenConfiguration,
  conversion,
  allowedRelays,
}: {
  editor: InviterEditor;
  csv: AcquiredCsv;
  problems: ReadonlyArray<SpineProblem>;
  minting: boolean;
  /** The effective SFTP connection locator, fetched once on a console build (and
   * updated when the operator authors or clears one); undefined before the fetch
   * resolves (or off a console), null when none is effective. */
  sftpConnection: SftpConnectionProjection | null | undefined;
  /** The coordination server a WebRTC run connects through, as the console
   * holds it: undefined before the fetch resolves (or off a console), null
   * when none is set. */
  signalingServer?: SignalingServerProjection | null;
  /** The operator set or cleared the coordination server. */
  onSignalingServer?: (server: SignalingServerProjection | null) => void;
  /** Whether a configuration from the mounted folder is open, which withholds
   * WebRTC: its run writes an alcove.yaml of its own into that folder. */
  configurationOpened?: boolean;
  /** Whether that configuration is a webrtc one the run runs in place, which
   * offers WebRTC for it. */
  openedRunsInPlace?: boolean;
  /** The coordination server address that configuration names, shown in
   * place of the console's own server, which its run does not use. */
  openedSignalingServer?: string;
  /** The TURN urls that configuration's run relays through, shown beside its
   * coordination server; empty where it names none. */
  openedRelayTurnUrls?: ReadonlyArray<string>;
  /** That configuration's `connection.allowed_relays`, shown beside its
   * relays and not edited here; undefined where it states none. */
  openedAllowedRelays?: ReadonlyArray<string>;
  /** The connection form a configuration opened from the mounted folder seeds,
   * forwarded to the SFTP card for the case where no connection is authored yet. */
  loadedSftpForm?: SftpConnectionFormValues;
  /** Whether the operator chose to run SFTP through their own
   * command-line tool (save-a-file) instead of authoring a connection here. */
  sftpSaveFilePreferred: boolean;
  /** Why the configuration opened from the mounted folder withholds the run,
   * undefined where nothing withholds it (`runWithheldReason`). */
  runWithheld?: string;
  /** Whether the run continues the exchange the opened configuration set up,
   * under the key file beside it, so the start action makes no invitation. */
  continuesOpenedExchange?: boolean;
  /** The warning that the opened configuration's terms were changed here,
   * which the partner does not hold (`editedTermsWarning`). Undefined where
   * there is nothing to warn of. */
  editedTermsWarning?: EditedTermsWarning;
  /** Why the file-handling and connection-tuning cards take no edits, standing
   * in for them: the opened configuration's connection block is saved as the
   * file states it (`connectionSettingsHeldNotice`). Undefined where the
   * cards edit the run's connection. */
  connectionSettingsHeld?: string;
  /** The console's rendezvous provisioning, or undefined before it resolves (or
   * off a console). The filedrop card runs here when it reports a mount and renders
   * disabled with the console's own reason when it does not; a split pair also
   * brings the retain-mode precondition into this step's create gate. Off a console
   * build it is unused (filedrop saves a file). */
  rendezvous: JobRendezvousConfig | undefined;
  /** The operator's file-handling choices for a run the console conducts. Only
   * the console's file-sync transports have them, so the card renders there. */
  exchangeFiles: ExchangeFilesDraft;
  onExchangeFiles: (draft: ExchangeFilesDraft) => void;
  /** The operator's connection-tuning choices for the same run, offered on the
   * same transports as the file-handling card. */
  connectionTuning: ConnectionTuningDraft;
  onConnectionTuning: (draft: ConnectionTuningDraft) => void;
  /** The operator's per-run diagnostic and recovery choices for the same run,
   * offered on the same transports the two cards above are. */
  runDiagnostics: RunDiagnosticsDraft;
  onRunDiagnostics: (draft: RunDiagnosticsDraft) => void;
  /** The operator's receipt-signing and retention choices for the same run,
   * offered on the same transports the three cards above are. */
  receipts: ReceiptsDraft;
  /** The identity a signed run of an opened configuration in place signs
   * with, which the receipts card shows. */
  inPlaceSigningIdentity?: InPlaceSigningIdentityShown;
  onReceipts: (draft: ReceiptsDraft) => void;
  onLifetime: (seconds: number) => void;
  onTransport: (transport: Transport) => void;
  /** An in-app authored connection landed (its credential-free projection). */
  onAuthorConnection: (connection: SftpConnectionProjection) => void;
  /** The operator cleared the authored connection. */
  onClearConnection: () => void;
  /** The operator chose the save-a-file alternative for SFTP. */
  onUseCliForSftp: () => void;
  /** The operator undid the save-a-file choice to author a connection here. */
  onRunHereForSftp: () => void;
  onReset: () => void;
  onCreate: () => void;
  onNavigate: (target: SpineTarget) => void;
  /** Where saving the opened configuration back to the folder stands, beside
   * {@link onSaveConfiguration}. */
  configurationSave?: ConfigurationSaveState;
  /** Save the settings these steps edit into the opened configuration's file.
   * Offered only where that configuration withholds the run
   * ({@link runWithheld}), since a run hands back its own configuration. */
  onSaveConfiguration?: () => void;
  /** Open the configuration again, offered beside a save refused over a file
   * that changed since it was opened. */
  onReopenConfiguration?: () => void;
  /** The conversion of the opened configuration to the console's own paths,
   * offered here where it is what releases the withheld run: the statement of
   * what it replaces (`conversionStatement`), and the action. */
  conversion?: { statement: string; onConvert: () => void };
  /** The hosted browser exchange's Allowed relays, shown in the browser
   * transport card: the text the field shows, its error, and whether it is
   * fixed on the list a created invitation took. A line the field refuses
   * holds the create. Absent where the field is not offered. */
  allowedRelays?: {
    value: string;
    error: string | undefined;
    fixed: boolean;
    onChange: (text: string) => void;
  };
}) {
  const consoleBuild = isConsoleBuild();
  const online = useOnlineStatus();
  // Derived from the draft here rather than passed in: a notice is a function
  // of the terms this step is restating.
  const currentTerms = useMemo(
    () => buildAdvancedTerms(editor.draft),
    [editor.draft],
  );
  const inertCoalesce = useMemo(
    () => inertCoalesceNotice(editor.draft, currentTerms),
    [editor.draft, currentTerms],
  );
  // The name this party signs under, read off the built terms rather than the
  // typed draft: the terms state a normalized form of what was typed, and that
  // form is what the certificate is bound to, what the partner authorizes
  // against, and what the run's own refusal compares. Terms stating no name at
  // all read as empty, which is what an unnamed exchange is held over.
  const termsIdentity = currentTerms.identity ?? "";
  const sftpConfigured = sftpConnection != null;
  const rendezvousConfigured = rendezvous?.configured === true;
  const available = availableTransports(
    consoleBuild,
    sftpConfigured,
    rendezvousConfigured,
    sftpSaveFilePreferred,
    configurationOpened,
    openedRunsInPlace,
  );
  const transport = editor.transport ?? available.defaultTransport;
  const disabledFor = (candidate: Transport): boolean =>
    available.options.find((option) => option.transport === candidate)
      ?.disabled === true;
  const browserDisabled = disabledFor("browser");
  const filedropDisabled = disabledFor("filedrop");
  const webrtcOffered = available.options.some(
    (option) => option.transport === "webrtc",
  );
  const webrtcDisabled = disabledFor("webrtc");
  const sftpAuthoringRequired =
    available.options.find((option) => option.transport === "sftp")
      ?.authoringRequired === true;
  const {
    browserLabel,
    browserDescription,
    filedropLabel,
    filedropDescription,
    sftpLabel,
    sftpDescription,
    webrtcLabel,
    webrtcDescription,
    capabilityNote,
  } = transportChooserCopy(
    consoleBuild,
    sftpConfigured,
    rendezvousConfigured,
    sftpSaveFilePreferred,
    {
      ...(rendezvous?.split === true ? { split: true } : {}),
      ...(rendezvous?.problem !== undefined
        ? { problem: rendezvous.problem }
        : {}),
    },
    configurationOpened,
    openedRunsInPlace,
  );
  // An sftp exchange chosen to run here cannot be created until a connection is
  // set up: block the seal and say so, rather than minting a code with no
  // rendezvous.
  const connectionIncomplete = transport === "sftp" && sftpAuthoringRequired;
  // Likewise a WebRTC exchange with no coordination server to name, or one
  // chosen before a configuration was opened.
  // A run of an opened configuration in place dials the server its file names,
  // whatever the console holds.
  const showsOpenedServer =
    openedRunsInPlace && transport === "webrtc" && !webrtcDisabled;
  const coordinationServerHeld =
    transport !== "webrtc"
      ? undefined
      : webrtcDisabled
        ? webrtcDescription
        : showsOpenedServer
          ? openedSignalingServer === undefined
            ? OPENED_SIGNALING_SERVER_UNREADABLE.message
            : undefined
          : signalingServer === undefined
            ? COORDINATION_SERVER_LOADING
            : signalingServer === null
              ? COORDINATION_SERVER_MISSING
              : undefined;
  // The console conducts the run there, so its settings cards are offered
  // there and nowhere else: a browser exchange has no shared directory, and a
  // save-a-file transport hands the settings to the operator's own command
  // line, where the flags already live.
  const exchangeFilesOffered =
    consoleBuild &&
    transport !== "browser" &&
    available.options.find((option) => option.transport === transport)
      ?.runMode === "server-job";
  // A WebRTC run has no folder whose files these settings handle.
  const fileSyncRun = exchangeFilesOffered && transport !== "webrtc";
  const connectionSettingsEditable =
    exchangeFilesOffered && connectionSettingsHeld === undefined;
  // A combination core refuses is a form problem here, before the invitation is
  // sealed, rather than a job that fails at composition or at rendezvous.
  const exchangeFilesBlocked =
    fileSyncRun &&
    connectionSettingsEditable &&
    exchangeFilesProblems(exchangeFiles, CONFIG_EXCHANGE_FILES).length > 0;
  const runDiagnosticsBlocked =
    fileSyncRun && runDiagnosticsProblems(runDiagnostics).length > 0;
  const receiptsBlocked =
    exchangeFilesOffered &&
    receiptsProblems(receipts, termsIdentity).length > 0;
  // Read only where this console conducts the run: a save-a-file or browser
  // transport signs nothing here, so there is no identity of this console's to
  // diverge from the terms.
  const identityDivergence = !exchangeFilesOffered
    ? undefined
    : signingIdentityDivergence(receipts, termsIdentity);
  const tuningCapabilities = connectionTuningCapabilitiesFor(transport);
  const connectionTuningBlocked =
    connectionSettingsEditable &&
    connectionTuningProblems(connectionTuning, tuningCapabilities).length > 0;
  // The rendezvous and the retain-mode toggle are decided in separate places, so
  // a split rendezvous -- an authored split SFTP connection, or a console
  // provisioned with two filedrop mounts -- can outlive the retain choice it
  // required: hold the create here, where both are known, rather than minting a
  // partner-facing accept kit for a rendezvous the run would then refuse. Read
  // only where this console conducts the run, since the file-handling choices
  // reach no other transport's run.
  const splitDirectoryProblem = !fileSyncRun
    ? undefined
    : transport === "sftp"
      ? splitDirectoryRetainProblem(sftpConnection, exchangeFiles.retainFiles)
      : splitRendezvousRetainProblem(rendezvous, exchangeFiles.retainFiles);
  // A create that begins a live run cannot succeed with no network: this browser
  // listens for the partner from the mint onward, and a console server-job run
  // dials from the console. A save-a-file create connects to nothing -- it
  // seals the terms and hands an exchange file to the command line -- so it
  // stays available offline. Only the offline direction is gated: being online
  // is no promise the partner is there (see @utils/networkStatus).
  const offlineBlocked =
    !online && transportRunMode(available, transport) !== "save-file";
  // A list the run would not take is a form problem here, before the
  // invitation names any relay.
  const allowedRelaysBlocked =
    transport === "browser" &&
    allowedRelays !== undefined &&
    allowedRelays.error !== undefined;
  const createStatus = inviterCreateStatus({
    runWithheld,
    offlineBlocked,
    connectionIncomplete,
    coordinationServerHeld,
    allowedRelaysBlocked,
    splitDirectoryProblem,
    exchangeFilesBlocked,
    connectionTuningBlocked,
    runDiagnosticsBlocked,
    receiptsBlocked,
    signingIdentityDivergence: identityDivergence,
    problemCount: problems.length,
  });
  // A mint already under way is the one hold with nothing to say: the button
  // holds it as its own loading state.
  const canCreate = createStatus.ready && !minting;
  // Voiced when the create gate flips either way; deferred so a blocked state
  // present when the section mounts still announces.
  const readiness = useDeferredAnnouncement(createStatus.announcement);
  const saveOffered =
    runWithheld !== undefined && onSaveConfiguration !== undefined;
  const configurationSaving = configurationSave?.status === "saving";
  // An opened configuration makes no invitation, whether this step runs it or
  // withholds the run, so the step offers no invitation duration.
  const makesInvitation = !continuesOpenedExchange && runWithheld === undefined;
  return (
    <>
      <p className={styles.eyebrow}>Step 3 of 3</p>
      <h1 tabIndex={-1}>Review &amp; create</h1>
      {makesInvitation && (
        <>
          <NativeSelect
            label="Invitation duration"
            description="How long this invitation can be accepted before it expires."
            value={String(editor.draft.lifetimeSeconds)}
            data={LIFETIME_CHOICES.map((choice) => ({
              value: String(choice.seconds),
              label: choice.label,
            }))}
            onChange={(event) => onLifetime(Number(event.currentTarget.value))}
          />
          <p className={`${styles.small} ${styles.sub}`}>
            Shared now, it expires{" "}
            <span className={styles.mono}>
              {expiryLabel(editor.draft.lifetimeSeconds, new Date())}
            </span>
            .
          </p>
        </>
      )}
      <fieldset className={styles.fieldset}>
        <legend>How will this exchange run?</legend>
        <div
          className={
            transport === "browser"
              ? `${styles.radioCard} ${styles.radioCardSelected}`
              : styles.radioCard
          }
        >
          <Radio
            name="transport"
            checked={transport === "browser"}
            disabled={browserDisabled}
            onChange={() => onTransport("browser")}
            label={browserLabel}
            description={browserDescription}
          />
          {transport === "browser" && makesInvitation && (
            <>
              {!consoleBuild && <UnreadableCoordinationServerNotice />}
              <DefaultRelayNotice />
              {allowedRelays !== undefined && (
                <AllowedRelaysField
                  value={allowedRelays.value}
                  error={allowedRelays.error}
                  fixed={allowedRelays.fixed}
                  liveError
                  onChange={allowedRelays.onChange}
                  scope={CREATED_INVITATION_ALLOWED_RELAYS_SCOPE}
                  guideUrl={ALLOWED_RELAYS_GUIDE_URL}
                  mt="md"
                />
              )}
            </>
          )}
        </div>
        <div
          className={
            transport === "sftp"
              ? `${styles.radioCard} ${styles.radioCardSelected}`
              : styles.radioCard
          }
        >
          <Radio
            name="transport"
            checked={transport === "sftp"}
            onChange={() => onTransport("sftp")}
            label={sftpLabel}
            description={sftpDescription}
          />
          {transport === "sftp" && consoleBuild && (
            <SftpConnectionCard
              connection={sftpConnection ?? null}
              loadedForm={loadedSftpForm}
              saveFilePreferred={sftpSaveFilePreferred}
              retainFiles={exchangeFiles.retainFiles}
              probeCeremony="exchange"
              onAuthored={onAuthorConnection}
              onCleared={onClearConnection}
              onUseCli={onUseCliForSftp}
              onRunHere={onRunHereForSftp}
            />
          )}
        </div>
        <div
          className={
            transport === "filedrop"
              ? `${styles.radioCard} ${styles.radioCardSelected}`
              : styles.radioCard
          }
        >
          <Radio
            name="transport"
            checked={transport === "filedrop"}
            disabled={filedropDisabled}
            onChange={() => onTransport("filedrop")}
            label={filedropLabel}
            description={filedropDescription}
          />
          {transport === "filedrop" && exchangeFilesOffered && (
            <SharedFolderExposureNotice
              rendezvous={rendezvous}
              mintsInvitation
            />
          )}
        </div>
        {webrtcOffered && (
          <div
            className={
              transport === "webrtc"
                ? `${styles.radioCard} ${styles.radioCardSelected}`
                : styles.radioCard
            }
          >
            <Radio
              name="transport"
              checked={transport === "webrtc"}
              disabled={webrtcDisabled}
              onChange={() => onTransport("webrtc")}
              label={webrtcLabel}
              description={webrtcDescription}
            />
            {showsOpenedServer && openedSignalingServer !== undefined && (
              <Stack gap="xs" mt="xs">
                <Text size="sm">
                  Connects through{" "}
                  <span className={styles.mono}>
                    {sanitizeForDisplay(openedSignalingServer)}
                  </span>
                  .
                </Text>
                {openedRelayTurnUrls.length > 0 && (
                  <Text size="sm">
                    Relays through{" "}
                    <span className={styles.mono}>
                      {sanitizeForDisplay(openedRelayTurnUrls.join(", "))}
                    </span>{" "}
                    when a direct connection fails.
                  </Text>
                )}
                {openedAllowedRelays !== undefined &&
                  (openedAllowedRelays.length > 0 ? (
                    <Text size="sm">
                      Allowed relays:{" "}
                      <span className={styles.mono}>
                        {sanitizeForDisplay(openedAllowedRelays.join(", "))}
                      </span>
                      . {OPENED_ALLOWED_RELAYS_ONLY}
                    </Text>
                  ) : (
                    <Text size="sm">{OPENED_NO_ALLOWED_RELAYS}</Text>
                  ))}
                <Text size="sm" c="dimmed">
                  {OPENED_SIGNALING_SERVER_NOTE}
                </Text>
                {openedRelayTurnUrls.length > 0 && <RelayCheckPanel />}
              </Stack>
            )}
            {transport === "webrtc" &&
              !webrtcDisabled &&
              !showsOpenedServer && (
                <SignalingServerCard
                  server={signalingServer}
                  onSet={(server) => onSignalingServer?.(server)}
                  onCleared={() => onSignalingServer?.(null)}
                />
              )}
          </div>
        )}
        <p className={`${styles.small} ${styles.sub}`}>{capabilityNote}</p>
      </fieldset>
      {exchangeFilesOffered && (
        <>
          {connectionSettingsEditable ? (
            <>
              {fileSyncRun && (
                <ExchangeFilesCard
                  draft={exchangeFiles}
                  capabilities={CONFIG_EXCHANGE_FILES}
                  onChange={onExchangeFiles}
                />
              )}
              <ConnectionTuningCard
                draft={connectionTuning}
                capabilities={tuningCapabilities}
                onChange={onConnectionTuning}
              />
            </>
          ) : (
            <p className={`${styles.small} ${styles.sub}`}>
              {connectionSettingsHeld}
            </p>
          )}
          <RunDiagnosticsCard
            draft={runDiagnostics}
            sweepOffered={fileSyncRun}
            onChange={onRunDiagnostics}
          />
          <ReceiptsCard
            draft={receipts}
            identity={termsIdentity}
            rendezvous={rendezvous}
            maxAgeOffered={connectionSettingsEditable}
            inPlaceSigningIdentity={inPlaceSigningIdentity}
            onChange={onReceipts}
          />
        </>
      )}
      <h2>Exchange proposal</h2>
      <p className={`${styles.small} ${styles.sub}`}>
        Check every term before you create the invitation. Creating it seals the
        terms.
      </p>
      {/* The one fact the restatement below cannot show: a declared default the
        run will not substitute is a term that is treated as widening the match and
        does nothing. Stated where the terms are sealed, since the step editor's
        own advisory sits inside a card an operator need never reopen. It holds
        nothing shut -- such terms are valid and run. */}
      {inertCoalesce !== undefined && (
        <Alert
          role="note"
          color="yellow"
          icon={<IconAlertTriangle aria-hidden />}
          title="A default value will not be substituted"
          mt="md"
        >
          {inertCoalesce}
        </Alert>
      )}
      <div className={styles.tableScroll}>
        <table className={`${styles.dataTable} ${styles.answers}`}>
          <caption className={styles.visuallyHidden}>
            {continuesOpenedExchange
              ? "Check your answers before starting the exchange"
              : makesInvitation
                ? "Check your answers before creating the invitation"
                : "Check your answers before saving your changes"}
          </caption>
          <tbody>
            {answersRows(editor, csv, transport, { makesInvitation }).map(
              (row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td className={row.mono === true ? styles.mono : undefined}>
                    {row.value}
                    {row.notes?.map((note, index) => (
                      <div
                        key={index}
                        className={`${styles.small} ${styles.sub}`}
                      >
                        {note.keyNames !== undefined && (
                          <ul>
                            {note.keyNames.map((name, nameIndex) => (
                              <li key={nameIndex}>{name}</li>
                            ))}
                          </ul>
                        )}
                        <p>{note.statement}</p>
                      </div>
                    ))}
                  </td>
                  <td className={styles.answersChange}>
                    {row.changeTarget !== undefined ? (
                      <button
                        type="button"
                        className={styles.stepLink}
                        onClick={() =>
                          onNavigate(row.changeTarget as SpineTarget)
                        }
                      >
                        Change
                        <span className={styles.visuallyHidden}>
                          {" "}
                          {row.label.toLowerCase()}
                        </span>
                      </button>
                    ) : row.setAbove === true ? (
                      <span className={styles.setAbove}>
                        Set above on this step
                      </span>
                    ) : null}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
      <VisuallyHidden>
        <p role="status" aria-live="polite" aria-atomic="true">
          {readiness}
        </p>
      </VisuallyHidden>
      {saveOffered && (
        <div className={styles.workFoot}>
          <Button
            disabled={problems.length > 0}
            loading={configurationSaving}
            onClick={onSaveConfiguration}
          >
            Save changes to alcove.yaml
          </Button>
          <p
            role="status"
            className={
              configurationSave?.status === "failed"
                ? `${styles.statusLine} ${styles.statusLineDanger}`
                : `${styles.statusLine} ${styles.statusLineOk}`
            }
          >
            {configurationSave?.status === "saved"
              ? configurationSave.unchanged === true
                ? CONFIGURATION_ALREADY_SAVED
                : CONFIGURATION_SAVED
              : configurationSave?.status === "failed"
                ? configurationSave.message
                : ""}
          </p>
          {configurationSave?.status === "failed" &&
            configurationSave.reopens === true &&
            onReopenConfiguration !== undefined && (
              <Button variant="default" onClick={onReopenConfiguration}>
                {REOPEN_CONFIGURATION_LABEL}
              </Button>
            )}
        </div>
      )}
      {conversion !== undefined && (
        <div className={styles.workFoot}>
          <p className={styles.small}>{conversion.statement}</p>
          <Button variant="default" onClick={conversion.onConvert}>
            {CONVERT_CONFIGURATION_LABEL}
          </Button>
        </div>
      )}
      <EditedTermsNotice warning={editedTermsWarning} />
      {continuesOpenedExchange && (
        <p className={styles.small}>
          {openedRunsInPlace && transport === "webrtc"
            ? OPENED_EXCHANGE_RUNS_IN_PLACE
            : OPENED_EXCHANGE_CONTINUES}
        </p>
      )}
      <div className={styles.workFoot}>
        <Button disabled={!canCreate} loading={minting} onClick={onCreate}>
          {continuesOpenedExchange
            ? START_OPENED_EXCHANGE_LABEL
            : "Create the invitation"}
        </Button>
        <ResetToDefaultsButton
          variant="default"
          disabled={minting}
          resets={INVITER_RESET_STATEMENT}
          onReset={onReset}
        />
        <p
          className={
            canCreate
              ? `${styles.statusLine} ${styles.statusLineOk}`
              : `${styles.statusLine} ${styles.statusLineDanger}`
          }
        >
          {createStatus.statusLine}
        </p>
      </div>
    </>
  );
}
