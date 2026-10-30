import { describe, expect, test } from "vitest";

import { getDefaultLinkageTerms } from "@alcove/core";

import {
  CONFIGURATION_ALREADY_SAVED,
  CONFIGURATION_LOAD_SEALED,
  CONFIGURATION_READ_UNAVAILABLE,
  CONFIGURATION_SAVED,
  CONFIGURATION_SAVE_UNAVAILABLE,
  CONVERT_CONFIGURATION_LABEL,
  CREATE_INVITATION_FROM_SETTINGS_LABEL,
  ICE_PROVISION_RUN_WITHHELD,
  IN_PLACE_IDENTITY_WRITTEN_NOTICE,
  MOUNTED_CONFIGURATION_UNREAD,
  NO_CONFIGURATION_IN_FOLDER,
  OPENED_EXCHANGE_RUNS_IN_PLACE,
  OPENED_SIGNALING_SERVER_NOTE,
  RELAY_ENROLLMENT_NOTICE,
  RELAY_OWNER_ENROLLMENT_NOTICE,
  carriedThroughNotice,
  columnsNotCoveredNotice,
  configurationSaveShown,
  configurationSaveState,
  connectionSettingsHeldNotice,
  conversionOffered,
  conversionStatement,
  convertedStatement,
  credentialWarningNotice,
  editedTermsWarning,
  inPlaceSigningIdentityShown,
  inPlaceSigningIdentityWithheldReason,
  keyFileNotice,
  mountedConfigurationNotices,
  mountedConfigurationOfferable,
  mountedConfigurationRead,
  openedRelayTurnUrls,
  openedSignalingServer,
  openedWebrtcEndpoint,
  opensInPlace,
  runWithheldReason,
  runsOpenedConfiguration,
  termsNotAppliedNotice,
  unconvertedSigningWithheldReason,
  withConversion,
  withNewInvitation,
  withTermsNotApplied,
  withUnavailableTransport,
} from "@console/mountedConfiguration";

import { PREVIOUS_CONFIGURATION_FILE_NAME } from "@jobContract/intentSchemas";
import { buildImageReference } from "@psi/dockerRunCommand";

import type {
  DisclosedExchangeDocument,
  InPlaceSigningIdentity,
} from "@jobContract/disclosedConfiguration";
import type { JobConfigurationHandBack } from "@jobContract/intentSchemas";
import type { MountedConfigurationAnswer } from "@psi/jobClient/mountedConfigClient";

// The load offer as a value: which of the three states each answer lands in, and
// the copy beside it. Every notice names SETTINGS ONLY, as the file spells them
// -- a setting's value can be a credential, which is why the console's own route
// names rather than sends both lists -- so the sweep below drives a document whose
// every value is distinctive and refuses to find one in any notice.

/** A hand-back a save sends, for the save states below. */
const HAND_BACK: JobConfigurationHandBack = {
  linkageTerms: getDefaultLinkageTerms("County Health"),
  csvDelimiter: "|",
  signing: { mode: "none" },
};

/** The terms update the operator runs: the image over their working folder. */
const UPDATE_COMMAND = {
  runCommand:
    'docker run --rm --user "$(id -u):$(id -g)" --mount ' +
    '"type=bind,src=/path/to/your/working-folder,dst=/work" ' +
    `${buildImageReference()} update`,
  windowsRunCommand:
    "docker run --rm --mount " +
    '"type=bind,src=C:\\path\\to\\your\\working-folder,dst=/work" ' +
    `${buildImageReference()} update`,
  podmanRunCommand:
    "podman run --rm --userns=keep-id:uid=1000,gid=1000 --mount " +
    '"type=bind,src=/path/to/your/working-folder,dst=/work" ' +
    `${buildImageReference()} update`,
};

const FINGERPRINT = "SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";

/** A setting outside every block a run here composes, as a later schema
 * version could add one: the load names it as held, and no run applies it. */
const UNCOMPOSED_SETTING = "added_setting";

function document(
  overrides: Partial<DisclosedExchangeDocument> = {},
): DisclosedExchangeDocument {
  return {
    channel: "sftp",
    server: { host: "sftp.partner.example", hostKeyFingerprint: FINGERPRINT },
    linkageTerms: getDefaultLinkageTerms("County Health"),
    ...overrides,
  };
}

function opened(
  overrides: Partial<DisclosedExchangeDocument> = {},
  carriedThrough: Array<string> = [],
  warnings: Array<string> = [],
): MountedConfigurationAnswer {
  return {
    kind: "opened",
    document: document(overrides),
    carriedThrough,
    warnings,
  };
}

describe("each answer lands the control in one state", () => {
  test("a mount holding no configuration is not a fault", () => {
    const read = mountedConfigurationRead({ kind: "absent" });
    expect(read.state).toEqual({ status: "absent" });
    expect(read.loaded).toBeUndefined();
    expect(NO_CONFIGURATION_IN_FOLDER).toMatch(/authored here/);
  });

  test("a read that did not answer leaves the offer standing", () => {
    const read = mountedConfigurationRead({ kind: "unavailable" });
    expect(read.state).toEqual({ status: "unavailable" });
    expect(read.loaded).toBeUndefined();
    expect(CONFIGURATION_READ_UNAVAILABLE).toMatch(/Nothing below has changed/);
  });

  test("a refusal shows the console's own text and fills nothing", () => {
    // A refusal the route raises reaches the operator whole, and no step is
    // filled from a document the console would not open.
    const error =
      "The alcove.yaml in your working folder is not a valid Alcove " +
      "configuration. Fix this setting in the file, then open it again: " +
      "connection.server.port.";
    const read = mountedConfigurationRead({ kind: "refused", error });
    expect(read.state).toEqual({ status: "refused", error });
    expect(read.loaded).toBeUndefined();
  });

  test("an opened configuration reports both lists and the authoring state", () => {
    const read = mountedConfigurationRead(
      opened({}, [UNCOMPOSED_SETTING], ["connection.server.password"]),
    );
    expect(read.state).toEqual({
      status: "opened",
      carriedThrough: [UNCOMPOSED_SETTING],
      warnings: ["connection.server.password"],
    });
    expect(read.loaded?.channel).toBe("sftp");
    expect(read.loaded?.sftpForm?.host).toBe("sftp.partner.example");
  });
});

describe("an opened configuration's own paths, until converted", () => {
  /** An opened filedrop configuration stating its signing identity and its
   * shared folder, as the load names them. */
  function openedWithPaths(
    signingPathSettings: Array<string> = ["signing.identity_file"],
  ) {
    return mountedConfigurationRead({
      kind: "opened",
      document: {
        channel: "filedrop",
        linkageTerms: getDefaultLinkageTerms("County Health"),
      },
      carriedThrough: [],
      warnings: [],
      signingPathSettings,
      folderPathSettings: ["connection.path"],
    }).state;
  }

  test("the read keeps the paths the load named on the state", () => {
    const state = openedWithPaths();
    expect(state).toMatchObject({
      status: "opened",
      signingPaths: ["signing.identity_file"],
      folderPaths: ["connection.path"],
    });
    if (state.status !== "opened") throw new Error("expected an open state");
    expect(state.converted).toBeUndefined();
  });

  test("a signed run of it is withheld, naming the settings and the conversion", () => {
    const reason = unconvertedSigningWithheldReason(
      openedWithPaths(),
      "certificate",
    );
    expect(reason).toContain(
      "sets its own signing path in signing.identity_file",
    );
    expect(reason).toContain(CONVERT_CONFIGURATION_LABEL);
    expect(reason).toContain("turn the signed receipt off");
    expect(reason).toContain(
      "This exchange then runs unsigned, and the configuration for " +
        "scheduled runs keeps your file's signing settings.",
    );
  });

  test("an unsigned run of it is not withheld", () => {
    expect(
      unconvertedSigningWithheldReason(openedWithPaths(), "none"),
    ).toBeUndefined();
  });

  test("a configuration naming only its folder withholds no signed run", () => {
    expect(
      unconvertedSigningWithheldReason(openedWithPaths([]), "certificate"),
    ).toBeUndefined();
  });

  test("the conversion is offered with every setting it replaces stated", () => {
    const state = openedWithPaths();
    expect(conversionOffered(state, false)).toBe(true);
    expect(conversionOffered(state, true)).toBe(false);
    const statement = conversionStatement(state);
    expect(statement).toContain(
      "sets its own paths in signing.identity_file, connection.path.",
    );
    expect(statement).toContain(
      "A run with a signed receipt waits until you convert",
    );
    expect(statement).toContain(
      "With the signed receipt off, this exchange runs unsigned",
    );
    expect(statement).toContain("keeps your file's signing settings");
    expect(statement).toContain("The run here uses your folder either way.");
    expect(statement).toContain(
      "Converting also changes the configuration for scheduled runs.",
    );
    expect(statement).toContain(
      "That configuration then states a placeholder for " +
        "signing.identity_file, connection.path, to set on the machine you " +
        "schedule from.",
    );
    expect(statement).not.toContain("receipt file");
  });

  test("converting only a folder path changes only the scheduled configuration", () => {
    const statement = conversionStatement(openedWithPaths([]));
    expect(statement).toContain(
      "Your alcove.yaml sets its own path in connection.path.",
    );
    expect(statement).toContain("The run here uses your folder either way.");
    expect(statement).toContain(
      "Converting changes only the configuration for scheduled runs.",
    );
    expect(statement).toContain(
      "That configuration then states a placeholder for connection.path, " +
        "to set on the machine you schedule from.",
    );
    expect(statement).not.toContain("signed receipt");
    expect(statement).not.toContain("receipt file");
  });

  test("once converted, the run is released and the statement says so", () => {
    const state = withConversion(openedWithPaths());
    expect(unconvertedSigningWithheldReason(state, "certificate")).toBe(
      undefined,
    );
    expect(conversionOffered(state, false)).toBe(false);
    expect(conversionStatement(state)).toBeUndefined();
    expect(convertedStatement(state)).toContain(
      "in place of signing.identity_file, connection.path",
    );
  });

  test("a configuration naming no path of its own has nothing to convert", () => {
    const state = mountedConfigurationRead(opened()).state;
    expect(conversionOffered(state, false)).toBe(false);
    expect(withConversion(state)).toBe(state);
  });
});

/** The TURN url a relayed configuration's run relays through. */
const RELAY_TURN_URL = "turns:relay.example.org:443?transport=tcp";

/** A webrtc configuration as the load answers it, naming the TURN urls its
 * run relays through, or none. */
function openedWebrtcFile(
  relayTurnUrls: Array<string>,
  overrides: Partial<DisclosedExchangeDocument> = {},
  carriedThrough: Array<string> = ["authentication.token_max_age_days"],
): MountedConfigurationAnswer {
  return {
    kind: "opened",
    document: {
      channel: "webrtc",
      signalingServer: "wss://signal.example.org/api/",
      linkageTerms: getDefaultLinkageTerms("County Health"),
      ...(relayTurnUrls.length > 0 ? { relayTurnUrls } : {}),
      ...overrides,
    },
    carriedThrough,
    warnings: [],
  };
}

describe("a webrtc configuration stating a relay", () => {
  function openedWebrtc(
    overrides: Partial<DisclosedExchangeDocument> = {},
  ): MountedConfigurationAnswer {
    return openedWebrtcFile([RELAY_TURN_URL], overrides);
  }

  test("opens to run in place, its relay shown beside its server, and every step seeded", () => {
    const read = mountedConfigurationRead(
      openedWebrtc({ csvDelimiter: "|", retentionDisposition: "Filed." }),
    );
    expect(read.state).toEqual({
      status: "opened",
      carriedThrough: ["authentication.token_max_age_days"],
      warnings: [],
      runsInPlace: true,
      signalingServer: "wss://signal.example.org/api/",
      relayTurnUrls: [RELAY_TURN_URL],
    });
    expect(openedRelayTurnUrls(read.state)).toEqual([RELAY_TURN_URL]);
    expect(read.loaded?.channel).toBe("webrtc");
    expect(read.loaded?.sftpForm).toBeUndefined();
    expect(read.loaded?.csvDelimiter.option).toBe("|");
    expect(read.loaded?.receipts.retentionDisposition).toBe("Filed.");
  });

  test("withholds no run for its relay", () => {
    const { state } = mountedConfigurationRead(openedWebrtc());
    expect(runWithheldReason(state)).toBeUndefined();
    expect(runsOpenedConfiguration(state)).toBe(true);
  });

  test("withholds the run of one stating ice_provision, naming what to list instead", () => {
    const answer = openedWebrtcFile([]);
    if (answer.kind !== "opened") throw new Error("expected an opened answer");
    const { state } = mountedConfigurationRead({
      ...answer,
      iceProvisionNamed: true,
    });
    expect(state).toMatchObject({ iceProvision: true, runsInPlace: true });
    expect(runWithheldReason(state)).toBe(ICE_PROVISION_RUN_WITHHELD);
    expect(ICE_PROVISION_RUN_WITHHELD).toContain("connection.ice_provision");
    expect(ICE_PROVISION_RUN_WITHHELD).toMatch(
      /under connection\.stun and connection\.turn in alcove\.yaml/,
    );
    expect(ICE_PROVISION_RUN_WITHHELD).toMatch(/open the configuration again/);
  });

  test("a channel the console conducts withholds nothing", () => {
    expect(runWithheldReason(mountedConfigurationRead(opened()).state)).toBe(
      undefined,
    );
    expect(
      runWithheldReason(
        mountedConfigurationRead(opened({ channel: "filedrop" })).state,
      ),
    ).toBeUndefined();
    expect(runWithheldReason({ status: "unread" })).toBeUndefined();
    expect(
      runWithheldReason({ status: "refused", error: "no" }),
    ).toBeUndefined();
  });

  test("its notices are those of any run here", () => {
    const { state } = mountedConfigurationRead(openedWebrtc());
    expect(mountedConfigurationNotices(state, {})).toEqual([
      carriedThroughNotice(["authentication.token_max_age_days"]),
    ]);
  });

  test("one naming a relay registrar adds the enrollment step before its run", () => {
    const answer = openedWebrtc();
    if (answer.kind !== "opened") throw new Error("expected an opened answer");
    const { state } = mountedConfigurationRead({
      ...answer,
      relayRegistrarNamed: true,
    });
    expect(state).toMatchObject({ relayEnrollment: true, runsInPlace: true });
    expect(mountedConfigurationNotices(state, {})).toEqual([
      carriedThroughNotice(["authentication.token_max_age_days"]),
      RELAY_ENROLLMENT_NOTICE,
    ]);
    expect(RELAY_ENROLLMENT_NOTICE).toMatch(/^If this exchange is not yet/);
    expect(RELAY_ENROLLMENT_NOTICE).toContain("alcove invite or alcove accept");
    expect(RELAY_ENROLLMENT_NOTICE).toContain("alcove enroll-relay");
    expect(RELAY_ENROLLMENT_NOTICE).toMatch(
      /standard input when there is no terminal/,
    );
  });

  test("one with own relay entries and no registrar says the relay's owner registers the key", () => {
    const { state } = mountedConfigurationRead(
      openedWebrtc({ relayCredentialMinted: true }),
    );
    expect(state).toMatchObject({ relayCredentialMinted: true });
    const notices = mountedConfigurationNotices(state, {});
    expect(notices).toContain(RELAY_OWNER_ENROLLMENT_NOTICE);
    expect(notices).not.toContain(RELAY_ENROLLMENT_NOTICE);
    expect(RELAY_OWNER_ENROLLMENT_NOTICE).toContain("relay's owner");
  });

  test("one with both a registrar and own relay entries says to enroll with the registrar", () => {
    const answer = openedWebrtc({ relayCredentialMinted: true });
    if (answer.kind !== "opened") throw new Error("expected an opened answer");
    const { state } = mountedConfigurationRead({
      ...answer,
      relayRegistrarNamed: true,
    });
    const notices = mountedConfigurationNotices(state, {});
    expect(notices).toContain(RELAY_ENROLLMENT_NOTICE);
    expect(notices).not.toContain(RELAY_OWNER_ENROLLMENT_NOTICE);
  });

  test("one naming no relay registrar adds nothing about it", () => {
    const { state } = mountedConfigurationRead(openedWebrtc());
    expect(state).not.toHaveProperty("relayEnrollment");
    expect(mountedConfigurationNotices(state, {})).not.toContain(
      RELAY_ENROLLMENT_NOTICE,
    );
    expect(mountedConfigurationNotices(state, {})).not.toContain(
      RELAY_OWNER_ENROLLMENT_NOTICE,
    );
  });

  test("a save leaves the state its answer names", () => {
    expect(configurationSaveState({ kind: "written" }, HAND_BACK)).toEqual({
      status: "saved",
      handBack: JSON.stringify(HAND_BACK),
    });
    expect(
      configurationSaveState(
        { kind: "refused", error: "Change them." },
        HAND_BACK,
      ),
    ).toEqual({ status: "failed", message: "Change them." });
    expect(configurationSaveState({ kind: "unavailable" }, HAND_BACK)).toEqual({
      status: "failed",
      message: CONFIGURATION_SAVE_UNAVAILABLE,
    });
    expect(
      configurationSaveState({ kind: "written", unchanged: true }, HAND_BACK),
    ).toEqual({
      status: "saved",
      handBack: JSON.stringify(HAND_BACK),
      unchanged: true,
    });
    expect(
      configurationSaveState(
        { kind: "refused", error: "Open it again.", changedSinceOpened: true },
        HAND_BACK,
      ),
    ).toEqual({ status: "failed", message: "Open it again.", reopens: true });
  });

  test("a written save is shown while the steps hold what it sent", () => {
    const saved = configurationSaveState({ kind: "written" }, HAND_BACK);
    expect(configurationSaveShown(saved, { ...HAND_BACK })).toEqual(saved);
  });

  test("a written save is not shown once the steps hold anything else", () => {
    const saved = configurationSaveState({ kind: "written" }, HAND_BACK);
    expect(
      configurationSaveShown(saved, { ...HAND_BACK, csvDelimiter: ";" }),
    ).toEqual({ status: "idle" });
    expect(configurationSaveShown(saved, undefined)).toEqual({
      status: "idle",
    });
    const failed = configurationSaveState({ kind: "unavailable" }, HAND_BACK);
    expect(
      configurationSaveShown(failed, { ...HAND_BACK, csvDelimiter: ";" }),
    ).toEqual(failed);
  });

  test("the saved message names the copy of the file kept beside it", () => {
    expect(CONFIGURATION_SAVED).toContain(PREVIOUS_CONFIGURATION_FILE_NAME);
    expect(CONFIGURATION_SAVED).toContain("the console did not write itself");
    expect(CONFIGURATION_ALREADY_SAVED).toContain("nothing was written");
  });

  test("its connection settings are held from the file, with a sentence", () => {
    const notice = connectionSettingsHeldNotice(
      mountedConfigurationRead(openedWebrtc()).state,
    );
    expect(notice).toContain("WebRTC connection");
    expect(notice).toMatch(/exactly as your file states it/);
    expect(notice).toMatch(/Edit those settings in alcove\.yaml itself/);
  });

  test("a channel the console conducts holds no connection setting", () => {
    expect(
      connectionSettingsHeldNotice(mountedConfigurationRead(opened()).state),
    ).toBeUndefined();
    expect(
      connectionSettingsHeldNotice(
        mountedConfigurationRead(opened({ channel: "filedrop" })).state,
      ),
    ).toBeUndefined();
    expect(connectionSettingsHeldNotice({ status: "unread" })).toBeUndefined();
  });

  test("what the input file cannot supply is still named after it", () => {
    const { state } = mountedConfigurationRead(openedWebrtc());
    const notices = mountedConfigurationNotices(
      withTermsNotApplied(state, ["metadata"], ["metadata"]),
    );
    expect(notices).toHaveLength(3);
    expect(notices[0]).toContain("token_max_age_days");
    expect(notices[1]).toContain("metadata");
  });
});

describe("a record this flow has no control for opens and is named", () => {
  test.each([
    ["expectedPartnerDeduplicate", "expected_partner_deduplicate", true],
  ] as const)(
    "%s is held and named as the file spells it",
    (field, spelling, value) => {
      const read = mountedConfigurationRead(opened({ [field]: value }));
      expect(read.loaded?.records[field]).toEqual(value);
      if (read.state.status !== "opened")
        throw new Error("expected an open configuration");
      expect(read.state.carriedThrough).toContain(spelling);
      const notice = mountedConfigurationNotices(read.state)[0];
      expect(notice).toContain(spelling);
      expect(notice).toContain("keeps it unchanged");
    },
  );

  test("it is named beside the settings the route itself held", () => {
    const read = mountedConfigurationRead(
      opened(
        {
          expectedPartnerDeduplicate: false,
        },
        [UNCOMPOSED_SETTING],
      ),
    );
    if (read.state.status !== "opened")
      throw new Error("expected an open configuration");
    expect(read.state.carriedThrough).toEqual([
      UNCOMPOSED_SETTING,
      "expected_partner_deduplicate",
    ]);
  });
});

describe("the notices name the settings and say what happens to them", () => {
  test("one held setting is named, with where it is edited", () => {
    const notice = carriedThroughNotice([UNCOMPOSED_SETTING]);
    expect(notice).toContain(UNCOMPOSED_SETTING);
    expect(notice).toContain("keeps it unchanged");
    expect(notice).toMatch(/Alcove on the command line/);
  });

  test("a held setting the run does not apply says so", () => {
    const notice = carriedThroughNotice([UNCOMPOSED_SETTING]);
    expect(notice).toContain("The run started here does not apply it");
    expect(notice).toContain("hands back states it as your file does");
  });

  test("a record the run states is not named as unapplied", () => {
    const notice = carriedThroughNotice(["expected_partner_deduplicate"]);
    expect(notice).toContain("keeps it unchanged");
    expect(notice).not.toContain("does not apply");
  });

  test("several held settings are all named", () => {
    const notice = carriedThroughNotice([
      UNCOMPOSED_SETTING,
      "expected_partner_deduplicate",
    ]);
    expect(notice).toContain(UNCOMPOSED_SETTING);
    expect(notice).toContain("expected_partner_deduplicate");
    expect(notice).toContain("keeps each unchanged");
    expect(notice).toContain(`does not apply ${UNCOMPOSED_SETTING}`);
  });

  test("no held setting draws no notice", () => {
    expect(carriedThroughNotice([])).toBeUndefined();
  });

  test("one credential field is named, with where to supply it", () => {
    const notice = credentialWarningNotice(["connection.server.password"]);
    expect(notice).toContain("connection.server.password");
    expect(notice).toMatch(/connection step/);
    expect(notice).toMatch(/from your folder/);
  });

  test("several credential fields are all named", () => {
    const notice = credentialWarningNotice([
      "connection.server.private_key",
      "connection.server.private_key_passphrase",
    ]);
    expect(notice).toContain("connection.server.private_key,");
    expect(notice).toContain("connection.server.private_key_passphrase");
    expect(notice).toContain("Supply each again");
  });

  test("no credential field draws no notice", () => {
    expect(credentialWarningNotice([])).toBeUndefined();
  });

  test("the held settings are stated before the credential to supply", () => {
    const read = mountedConfigurationRead(
      opened({}, [UNCOMPOSED_SETTING], ["connection.server.password"]),
    );
    const notices = mountedConfigurationNotices(read.state);
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain(UNCOMPOSED_SETTING);
    expect(notices[1]).toContain("connection.server.password");
  });

  test("a channel this console cannot run says so and what to do", () => {
    const read = mountedConfigurationRead(opened({ channel: "filedrop" }));
    const notices = mountedConfigurationNotices(
      withUnavailableTransport(read.state, "filedrop"),
    );
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain("shared folder");
    expect(notices[0]).toContain("JOB_RENDEZVOUS_DIR");
    expect(notices[0]).toMatch(/review step/);
  });

  test("a setting the input file cannot supply is named, not dropped", () => {
    const notice = termsNotAppliedNotice(["metadata", "standardization"]);
    expect(notice).toContain("metadata, standardization");
    expect(notice).toMatch(/Alcove on the command line/);
    expect(termsNotAppliedNotice([])).toBeUndefined();
  });

  test("what the file could not supply is stated last", () => {
    const read = mountedConfigurationRead(
      opened(
        { channel: "filedrop" },
        [UNCOMPOSED_SETTING],
        ["connection.server.password"],
      ),
    );
    const notices = mountedConfigurationNotices(
      withUnavailableTransport(
        withTermsNotApplied(read.state, ["metadata"]),
        "filedrop",
      ),
    );
    expect(notices).toHaveLength(4);
    expect(notices[0]).toContain("shared folder");
    expect(notices[1]).toContain(UNCOMPOSED_SETTING);
    expect(notices[2]).toContain("connection.server.password");
    expect(notices[3]).toContain("metadata");
  });

  test("a load that opened nothing takes neither added notice", () => {
    expect(withUnavailableTransport({ status: "absent" }, "filedrop")).toEqual({
      status: "absent",
    });
    expect(withTermsNotApplied({ status: "absent" }, ["metadata"])).toEqual({
      status: "absent",
    });
  });

  test("a file that supplies everything clears what an earlier one could not", () => {
    // The notice is about the file the terms reached last, so the next file
    // supplying the whole document leaves nothing named.
    const read = mountedConfigurationRead(opened());
    const named = withTermsNotApplied(read.state, ["metadata"]);
    const cleared = withTermsNotApplied(named, []);
    expect(mountedConfigurationNotices(named)).toHaveLength(1);
    expect(mountedConfigurationNotices(cleared)).toEqual([]);
  });

  test("a state that opened nothing renders no notice", () => {
    expect(mountedConfigurationNotices({ status: "absent" })).toEqual([]);
    expect(mountedConfigurationNotices({ status: "unread" })).toEqual([]);
    expect(
      mountedConfigurationNotices({ status: "refused", error: "no" }),
    ).toEqual([]);
  });
});

describe("no value of the document reaches a notice", () => {
  test("names only, over a document whose every value is distinctive", () => {
    const secret = "correct-horse-battery-staple";
    const read = mountedConfigurationRead(
      opened(
        {
          server: {
            host: `host-${secret}`,
            username: `user-${secret}`,
            hostKeyFingerprint: FINGERPRINT,
          },
          csvDelimiter: "|",
          retentionDisposition: `note-${secret}`,
          signing: { mode: "certificate", partnerFingerprint: FINGERPRINT },
        },
        [UNCOMPOSED_SETTING],
        ["connection.server.password"],
      ),
    );
    const named = withTermsNotApplied(read.state, ["metadata"], ["metadata"]);
    for (const notice of mountedConfigurationNotices(named)) {
      expect(notice).not.toContain(secret);
      expect(notice).not.toContain(FINGERPRINT);
    }
  });
});

describe("the offer stands only while the steps it fills are editable", () => {
  test("an unread offer is made, and withheld once an invitation is minted", () => {
    expect(
      mountedConfigurationOfferable(MOUNTED_CONFIGURATION_UNREAD, false),
    ).toBe(true);
    expect(
      mountedConfigurationOfferable(MOUNTED_CONFIGURATION_UNREAD, true),
    ).toBe(false);
    expect(CONFIGURATION_LOAD_SEALED).toContain("Start a new exchange");
  });

  test("a read that did not answer can be retried, an open one cannot be reopened", () => {
    expect(
      mountedConfigurationOfferable({ status: "unavailable" }, false),
    ).toBe(true);
    expect(
      mountedConfigurationOfferable(
        mountedConfigurationRead(opened()).state,
        false,
      ),
    ).toBe(false);
  });
});

// A document stating `metadata` states the whole column set, so a column this
// party's file has and that set does not name is held back. The notice says the
// file holds more than the configuration states -- the opposite direction from
// the one beside it -- and names the setting only.
describe("columns the configuration does not state", () => {
  test("the notice names the setting and what happens to the columns", () => {
    const notice = columnsNotCoveredNotice(["metadata"]);
    expect(notice).toContain("metadata");
    expect(notice).toMatch(/keep those columns back/);
    expect(columnsNotCoveredNotice([])).toBeUndefined();
  });

  test("it stands beside what the file could not supply, after it", () => {
    const read = mountedConfigurationRead(opened());
    const notices = mountedConfigurationNotices(
      withTermsNotApplied(read.state, ["standardization"], ["metadata"]),
    );
    expect(notices).toHaveLength(2);
    expect(notices[0]).toContain("standardization");
    expect(notices[1]).toContain("does not state under metadata");
  });
});

describe("a webrtc configuration stating no relay settings", () => {
  const { state, loaded } = mountedConfigurationRead(openedWebrtcFile([]));

  test("opens to run in place", () => {
    expect(state).toEqual({
      status: "opened",
      carriedThrough: ["authentication.token_max_age_days"],
      warnings: [],
      runsInPlace: true,
      signalingServer: "wss://signal.example.org/api/",
    });
    expect(loaded?.channel).toBe("webrtc");
    expect(opensInPlace(state)).toBe(true);
    expect(openedSignalingServer(state)).toBe("wss://signal.example.org/api/");
    expect(runsOpenedConfiguration(state)).toBe(true);
    expect(runWithheldReason(state)).toBeUndefined();
    expect(openedRelayTurnUrls(state)).toEqual([]);
  });

  test("an sftp configuration does not run in place", () => {
    expect(opensInPlace(mountedConfigurationRead(opened()).state)).toBe(false);
    expect(
      openedSignalingServer(mountedConfigurationRead(opened()).state),
    ).toBeUndefined();
  });

  test("one stating a relay shows its coordination server and its relay", () => {
    const relayed = mountedConfigurationRead(
      openedWebrtcFile([RELAY_TURN_URL]),
    ).state;
    expect(openedSignalingServer(relayed)).toBe(
      "wss://signal.example.org/api/",
    );
    expect(openedRelayTurnUrls(relayed)).toEqual([RELAY_TURN_URL]);
  });

  test("its connection settings are held from the file, as the run uses them", () => {
    const notice = connectionSettingsHeldNotice(state);
    expect(notice).toContain("WebRTC connection");
    expect(notice).toMatch(/the run uses it as it is/);
  });

  test("the invitation of its run names the server the file names", () => {
    expect(openedWebrtcEndpoint("wss://signal.example.org/api/")).toEqual({
      channel: "webrtc",
      host: "signal.example.org",
      path: "/api/",
    });
    expect(openedWebrtcEndpoint("ws://[::1]:9000/")).toEqual({
      channel: "webrtc",
      host: "::1",
      port: 9000,
      path: "/",
    });
    expect(openedWebrtcEndpoint("wss://Peer.Example.org/")?.host).toBe(
      "peer.example.org",
    );
    expect(openedWebrtcEndpoint("wss://bad host/")).toBeUndefined();
    expect(openedWebrtcEndpoint("https://signal.example.org/")).toBeUndefined();
    expect(openedWebrtcEndpoint(undefined)).toBeUndefined();
  });

  test("names no channel notice, and no conversion", () => {
    expect(mountedConfigurationNotices(state, {})).toEqual([
      carriedThroughNotice(["authentication.token_max_age_days"]),
    ]);
    expect(conversionOffered(state, false)).toBe(false);
    expect(withNewInvitation(state)).toBe(state);
  });

  test("the review step says the run saves any change first, then runs it", () => {
    expect(OPENED_EXCHANGE_RUNS_IN_PLACE).toContain(
      PREVIOUS_CONFIGURATION_FILE_NAME,
    );
    expect(OPENED_EXCHANGE_RUNS_IN_PLACE).toMatch(/saves any change/);
    expect(OPENED_EXCHANGE_RUNS_IN_PLACE).toMatch(
      /unless the console wrote that file itself/,
    );
    expect(OPENED_EXCHANGE_RUNS_IN_PLACE).toMatch(/as alcove exchange does/);
    expect(OPENED_SIGNALING_SERVER_NOTE).toMatch(/^From your alcove\.yaml/);
    expect(OPENED_SIGNALING_SERVER_NOTE).toContain(
      "connection.invitation_relay where the file has one, else connection.turn",
    );
  });

  test("an edit of its terms says starting saves them, and how to keep or change them", () => {
    const warning = editedTermsWarning(state, {
      termsEdited: true,
      continuesOpenedExchange: true,
    });
    expect(warning?.message).toContain(
      "Starting the exchange saves these terms",
    );
    expect(warning?.message).toContain("undo the change before you start");
    expect(warning?.message).toContain(
      "start, then run the alcove update command below for your system",
    );
    expect(warning?.message).not.toMatch(/close the configuration/);
    expect(warning?.command).toEqual(UPDATE_COMMAND);
  });
});

describe("the identity a signed run in place signs with", () => {
  const picked = { mount: "secrets" as const, subPath: ["keys", "id.json"] };

  function inPlaceWith(
    inPlaceSigningIdentity?: InPlaceSigningIdentity,
    relayTurnUrls: Array<string> = [],
  ) {
    return mountedConfigurationRead({
      ...openedWebrtcFile(relayTurnUrls),
      ...(inPlaceSigningIdentity !== undefined
        ? { inPlaceSigningIdentity }
        : {}),
    }).state;
  }

  const signed = { mode: "certificate" as const, identityLocation: undefined };

  test("a file naming none has the console's written into it, and runs", () => {
    const state = inPlaceWith();
    expect(inPlaceSigningIdentityShown(state, signed)).toEqual({
      kind: "written",
    });
    expect(inPlaceSigningIdentityWithheldReason(state, signed)).toBeUndefined();
    expect(IN_PLACE_IDENTITY_WRITTEN_NOTICE).toContain(
      "writes the identity in use here into it as signing.identity_file",
    );
  });

  test("a file naming the identity the card holds runs as it is", () => {
    const folder = inPlaceWith({
      identityFile: "/data/.alcove-signing-identity.json",
      consoleLocation: { mount: "folder" },
    });
    expect(inPlaceSigningIdentityShown(folder, signed)).toEqual({
      kind: "console",
    });
    expect(
      inPlaceSigningIdentityWithheldReason(folder, signed),
    ).toBeUndefined();
    const secrets = inPlaceWith({
      identityFile: "/secrets/keys/id.json",
      consoleLocation: picked,
    });
    expect(
      inPlaceSigningIdentityShown(secrets, {
        mode: "certificate",
        identityLocation: { mount: "secrets", subPath: ["keys", "id.json"] },
      }),
    ).toEqual({ kind: "console" });
  });

  test("a file naming another identity shows its path and withholds the run", () => {
    const other = inPlaceWith({ identityFile: "/home/operator/id.json" });
    expect(inPlaceSigningIdentityShown(other, signed)).toEqual({
      kind: "file",
      identityFile: "/home/operator/id.json",
      consoleLocation: false,
    });
    const reason = inPlaceSigningIdentityWithheldReason(other, signed);
    expect(reason).toContain("the console signs only with its own");
    expect(reason).toContain("Turn the signed receipt off");
    expect(reason).toContain("saves that change to alcove.yaml");
    expect(reason).toContain("command line");
    expect(reason).not.toContain("Choose the file it names");
  });

  test("a file stating a relay runs in place, its identity judged as any other", () => {
    const relay = inPlaceWith({ identityFile: "/home/operator/id.json" }, [
      RELAY_TURN_URL,
    ]);
    expect(inPlaceSigningIdentityShown(relay, signed)).toEqual({
      kind: "file",
      identityFile: "/home/operator/id.json",
      consoleLocation: false,
    });
  });

  test("a file naming a console identity the card does not hold says where to choose it", () => {
    const folder = inPlaceWith({
      identityFile: "/data/.alcove-signing-identity.json",
      consoleLocation: { mount: "folder" },
    });
    const elsewhere = {
      mode: "certificate" as const,
      identityLocation: picked,
    };
    expect(inPlaceSigningIdentityShown(folder, elsewhere)).toMatchObject({
      kind: "file",
      consoleLocation: true,
    });
    expect(inPlaceSigningIdentityWithheldReason(folder, elsewhere)).toContain(
      "Choose the file it names",
    );
    const secrets = inPlaceWith({
      identityFile: "/secrets/keys/id.json",
      consoleLocation: picked,
    });
    expect(inPlaceSigningIdentityShown(secrets, signed)?.kind).toBe("file");
  });

  test("an unsigned run, or a file not run in place, is not withheld", () => {
    const other = { identityFile: "/home/operator/id.json" };
    expect(
      inPlaceSigningIdentityShown(inPlaceWith(other), {
        mode: "none",
        identityLocation: undefined,
      }),
    ).toBeUndefined();
    expect(
      inPlaceSigningIdentityWithheldReason(
        mountedConfigurationRead(opened()).state,
        signed,
      ),
    ).toBeUndefined();
  });
});

describe("the terms of an opened configuration changed here", () => {
  const conducted = mountedConfigurationRead(opened()).state;

  test("a run of the opened configuration names update and apply", () => {
    const warning = editedTermsWarning(conducted, {
      termsEdited: true,
      continuesOpenedExchange: true,
    });
    expect(warning?.message).toMatch(/still holds its terms as they were/);
    expect(warning?.message).toMatch(/This run is refused/);
    expect(warning?.message).toContain(
      "run the alcove update command below for your system, and send",
    );
    expect(warning?.message).toContain("to apply with alcove apply.");
    expect(warning?.command).toEqual(UPDATE_COMMAND);
  });

  test("unchanged terms raise nothing", () => {
    expect(
      editedTermsWarning(conducted, {
        termsEdited: false,
        continuesOpenedExchange: true,
      }),
    ).toBeUndefined();
  });

  test("a run that makes a new invitation raises nothing", () => {
    expect(
      editedTermsWarning(conducted, {
        termsEdited: true,
        continuesOpenedExchange: false,
      }),
    ).toBeUndefined();
  });

  test("nothing open raises nothing", () => {
    expect(
      editedTermsWarning(MOUNTED_CONFIGURATION_UNREAD, {
        termsEdited: true,
        continuesOpenedExchange: true,
      }),
    ).toBeUndefined();
  });
});

describe("an opened configuration whose key file would refuse its run", () => {
  function openedWithoutKeyFile(
    fault: "absent" | "invalid" = "absent",
    channel: DisclosedExchangeDocument["channel"] = "sftp",
  ) {
    return mountedConfigurationRead({
      ...opened({ channel }),
      signingPathSettings: ["signing.identity_file"],
      keyFileFault: fault,
    } as MountedConfigurationAnswer).state;
  }

  test("is told on the load, with both ways on", () => {
    for (const fault of ["absent", "invalid"] as const) {
      const notice = keyFileNotice(openedWithoutKeyFile(fault));
      expect(notice?.title).toContain(".alcove.key");
      expect(notice?.message).toContain("open the configuration again");
      expect(notice?.message).toContain(CREATE_INVITATION_FROM_SETTINGS_LABEL);
    }
  });

  test("a webrtc one run in place withholds the run and offers no new invitation", () => {
    for (const fault of ["absent", "invalid"] as const) {
      const state = openedWithoutKeyFile(fault, "webrtc");
      const notice = keyFileNotice(state);
      expect(notice?.message).toContain("open the configuration again");
      expect(notice?.message).toContain(
        "if the key file is somewhere else, run the configuration with " +
          "Alcove on the command line there",
      );
      expect(notice?.message).toContain("start again with alcove invite");
      expect(notice?.message).not.toContain(
        CREATE_INVITATION_FROM_SETTINGS_LABEL,
      );
      expect(runWithheldReason(state)).toContain(".alcove.key");
      expect(withNewInvitation(state)).toBe(state);
    }
  });

  test("a new invitation from its settings stops continuing the opened exchange", () => {
    const before = openedWithoutKeyFile();
    expect(runsOpenedConfiguration(before)).toBe(true);
    expect(
      unconvertedSigningWithheldReason(before, "certificate"),
    ).toBeDefined();
    const after = withNewInvitation(before);
    expect(runsOpenedConfiguration(after)).toBe(false);
    expect(keyFileNotice(after)).toBeUndefined();
    // A new invitation's run signs with the console's own identity, so the
    // file's signing paths hold nothing back and there is nothing to convert.
    expect(
      unconvertedSigningWithheldReason(after, "certificate"),
    ).toBeUndefined();
    expect(conversionOffered(after, false)).toBe(false);
    expect(conversionStatement(after)).toBeUndefined();
    expect(convertedStatement(withConversion(after))).toBeUndefined();
  });

  test("a usable key file names nothing", () => {
    const state = mountedConfigurationRead(opened()).state;
    expect(keyFileNotice(state)).toBeUndefined();
    expect(runsOpenedConfiguration(state)).toBe(true);
    expect(runsOpenedConfiguration(MOUNTED_CONFIGURATION_UNREAD)).toBe(false);
  });
});
