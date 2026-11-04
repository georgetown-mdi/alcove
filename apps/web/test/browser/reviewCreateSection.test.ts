/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

import {
  editorFromCsv,
  editorWithAuthoredDraft,
  editorWithKeyMoved,
  editorWithPrecisionFloorSelection,
} from "@psi/inviterEditor";

import {
  buildAdvancedTerms,
  draftFromTerms,
} from "@psi/authoring/advancedInvite";

import {
  EDITED_TERMS_TITLE,
  START_OPENED_EXCHANGE_LABEL,
} from "@console/mountedConfiguration";
import { CONNECTION_TUNING_DEFAULT } from "@console/connectionTuningModel";
import { EXCHANGE_FILES_DEFAULT } from "@console/exchangeFilesModel";
import { RECEIPTS_DEFAULT } from "@psi/receiptsModel";
import { RUN_DIAGNOSTICS_DEFAULT } from "@psi/runDiagnosticsModel";
import { ReviewCreateSection } from "@exchange/ReviewCreateSection";

import { workingFolderCommand } from "@psi/dockerRunCommand";

import { createAppMount } from "./renderApp";
import { expectWorkingFolderCommandPerShell } from "./workingFolderCommandBlocks";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type { AdvancedInviteDraft } from "@psi/authoring/advancedInvite";
import type { ConnectionSettingsText } from "@recurring/managedConnectionSettingsModel";
import type { EditedTermsWarning } from "@console/mountedConfiguration";

const INERT_COALESCE_NOTICE_NAME = "A default value will not be substituted";

const csv: AcquiredCsv = {
  fileName: "clients.csv",
  sizeBytes: 1024,
  rawRows: [
    {
      client_id: "1",
      first_name: "Ann",
      last_name: "Lee",
      dob: "01/02/1990",
      ssn4: "1234",
    },
  ],
  columns: ["client_id", "first_name", "last_name", "dob", "ssn4"],
  rowCount: 1,
};

const app = createAppMount();

function render(
  editor: InviterEditor,
  opened: {
    continuesOpenedExchange?: boolean;
    runWithheld?: string;
    editedTermsWarning?: EditedTermsWarning;
    connectionSettings?: Parameters<
      typeof ReviewCreateSection
    >[0]["connectionSettings"];
  } = {},
) {
  app.render(
    createElement(ReviewCreateSection, {
      ...opened,
      editor,
      csv,
      problems: [],
      minting: false,
      sftpConnection: null,
      sftpSaveFilePreferred: false,
      rendezvous: undefined,
      exchangeFiles: EXCHANGE_FILES_DEFAULT,
      onExchangeFiles: () => undefined,
      connectionTuning: CONNECTION_TUNING_DEFAULT,
      onConnectionTuning: () => undefined,
      runDiagnostics: RUN_DIAGNOSTICS_DEFAULT,
      onRunDiagnostics: () => undefined,
      receipts: RECEIPTS_DEFAULT,
      onReceipts: () => undefined,
      onLifetime: () => undefined,
      onTransport: () => undefined,
      onAuthorConnection: () => undefined,
      onClearConnection: () => undefined,
      onUseCliForSftp: () => undefined,
      onRunHereForSftp: () => undefined,
      onReset: () => undefined,
      onCreate: () => undefined,
      onNavigate: () => undefined,
    }),
  );
}

/** An editor whose keys were loaded from a terms document holding a key the
 * built-in rules do not declare. */
function importedFromDocument(): InviterEditor {
  const editor = editorFromCsv("Dana Okafor", csv);
  const document = buildAdvancedTerms(editor.draft);
  document.linkageKeys[0] = {
    ...document.linkageKeys[0],
    name: `${document.linkageKeys[0].name} (house rules)`,
  };
  return editorWithAuthoredDraft(
    editor,
    draftFromTerms(document, editor.seed, 3600, csv.rawRows),
  );
}

/** An editor whose first field's cleaning declares a coalesce with nothing ahead
 * of it in the pipeline that can empty the value, so the run substitutes it
 * nowhere it sits -- the same construction the unit suite drives
 * `inertCoalesceNotice` with. */
function withFirstPositionCoalesce(): InviterEditor {
  const editor = editorFromCsv("Dana Okafor", csv);
  const declared: AdvancedInviteDraft = {
    ...editor.draft,
    standardization: editor.draft.standardization.map(
      (transformation, index) =>
        index === 0
          ? {
              ...transformation,
              steps: [{ function: "coalesce", params: { default: "UNKNOWN" } }],
            }
          : transformation,
    ),
  };
  return editorWithAuthoredDraft(editor, declared);
}

afterEach(app.unmount);

describe("ReviewCreateSection: the rules the keys were selected with", () => {
  function rulesSelectedCell() {
    return page
      .getByRole("row")
      .filter({ has: page.getByRole("rowheader", { name: "Rules selected" }) })
      .getByRole("cell")
      .first();
  }

  test("names the default floor", async () => {
    render(editorFromCsv("Dana Okafor", csv));

    await expect
      .element(rulesSelectedCell())
      .toHaveTextContent("broader matching");
    await expect
      .element(rulesSelectedCell())
      .not.toHaveTextContent("metropolitan");
  });

  test("names the 99% floor", async () => {
    render(
      editorWithPrecisionFloorSelection(editorFromCsv("Dana Okafor", csv), {
        floor: 99,
      }),
    );

    await expect
      .element(rulesSelectedCell())
      .toHaveTextContent("highest precision");
  });

  test("names no floor for keys loaded from a document", async () => {
    render(importedFromDocument());

    await expect
      .element(rulesSelectedCell())
      .toHaveTextContent(
        "Keys written in expert authoring or loaded from a document",
      );
  });

  test("states no rule-set citation for keys moved out of the built-in order", async () => {
    render(editorWithKeyMoved(editorFromCsv("Dana Okafor", csv), 0, 1));

    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();
    expect(app.container.textContent).not.toMatch(/citation/i);
  });
});

describe("ReviewCreateSection: the inert-coalesce notice", () => {
  test("restates it where the terms are sealed, blocking nothing", async () => {
    render(withFirstPositionCoalesce());

    await expect
      .element(page.getByRole("heading", { name: "Review & create" }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("note", { name: INERT_COALESCE_NOTICE_NAME }))
      .toMatchTextContent("is never substituted where it sits");
    // Advisory, not a refusal: terms with this shape are valid and run, so
    // the create action stays available.
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();
  });
});

describe("ReviewCreateSection: the Connection settings", () => {
  const SERVER = "wss://signaling.example.org/api/";
  const values = (
    change: Partial<ConnectionSettingsText> = {},
  ): ConnectionSettingsText => ({
    server: SERVER,
    turn: "",
    stun: "",
    websocket: "",
    defaultRelayOn: false,
    ...change,
  });
  const createButton = () =>
    page.getByRole("button", { name: "Create the invitation" });

  test("show the coordination server and a relay line, and leave the create open", async () => {
    render(editorFromCsv("Dana Okafor", csv), {
      connectionSettings: {
        values: values(),
        errors: {},
        ownRelay: undefined,
        fixed: false,
        onChange: () => undefined,
      },
    });

    await expect
      .element(page.getByRole("textbox", { name: "Coordination server" }))
      .toHaveValue(SERVER);
    await expect.element(page.getByText("No relay set.")).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Set a relay" }))
      .toBeEnabled();
    await expect.element(createButton()).toBeEnabled();
  });

  test("a value a field refuses holds the create", async () => {
    render(editorFromCsv("Dana Okafor", csv), {
      connectionSettings: {
        values: values({ server: "" }),
        errors: { server: "Enter a coordination server address." },
        ownRelay: undefined,
        fixed: false,
        onChange: () => undefined,
      },
    });

    await expect
      .element(page.getByText("Enter a coordination server address."))
      .toBeVisible();
    await expect.element(createButton()).toBeDisabled();
    expect(app.container.textContent).toContain(
      "Resolve the connection settings above",
    );
  });

  test("are fixed on what a created invitation took", async () => {
    render(editorFromCsv("Dana Okafor", csv), {
      connectionSettings: {
        values: values({ turn: "turn:relay.example.org" }),
        errors: {},
        ownRelay: { turn: ["turn:relay.example.org"], stun: [] },
        fixed: true,
        onChange: () => undefined,
      },
    });

    await expect
      .element(page.getByRole("textbox", { name: "Coordination server" }))
      .toHaveAttribute("readonly");
    await expect
      .element(page.getByText("Relay: turn:relay.example.org"))
      .toBeVisible();
    expect(
      page.getByRole("button", { name: "Change relay" }).query(),
    ).toBeNull();
    expect(
      page.getByRole("button", { name: "Remove relay" }).query(),
    ).toBeNull();
  });
});

describe("ReviewCreateSection: a run of an opened configuration", () => {
  const WARNING = "The terms changed here are not the ones your partner holds.";

  test("a new invitation offers its duration", async () => {
    render(editorFromCsv("Dana Okafor", csv));

    await expect
      .element(page.getByLabelText("Invitation duration"))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("rowheader", { name: "Invitation duration" }))
      .toBeInTheDocument();
    await expect
      .element(
        page.getByRole("table", {
          name: "Check your answers before creating the invitation",
        }),
      )
      .toBeInTheDocument();
  });

  test("a run that makes no invitation offers no duration", async () => {
    render(editorFromCsv("Dana Okafor", csv), {
      continuesOpenedExchange: true,
    });

    await expect
      .element(page.getByRole("button", { name: START_OPENED_EXCHANGE_LABEL }))
      .toBeInTheDocument();
    expect(page.getByLabelText("Invitation duration").query()).toBeNull();
    expect(
      page.getByRole("rowheader", { name: "Invitation duration" }).query(),
    ).toBeNull();
    expect(app.container.textContent).not.toContain("Shared now, it expires");
    await expect
      .element(
        page.getByRole("table", {
          name: "Check your answers before starting the exchange",
        }),
      )
      .toBeInTheDocument();
  });

  test("a configuration saved back rather than run offers no duration", async () => {
    render(editorFromCsv("Dana Okafor", csv), {
      runWithheld: "The console cannot run this webrtc configuration.",
    });

    await expect
      .element(
        page.getByRole("table", {
          name: "Check your answers before saving your changes",
        }),
      )
      .toBeInTheDocument();
    expect(page.getByLabelText("Invitation duration").query()).toBeNull();
    expect(
      page.getByRole("rowheader", { name: "Invitation duration" }).query(),
    ).toBeNull();
    expect(app.container.textContent).not.toContain("Shared now, it expires");
  });

  test("changed terms are warned of, and the run can still start", async () => {
    render(editorFromCsv("Dana Okafor", csv), {
      continuesOpenedExchange: true,
      editedTermsWarning: {
        message: WARNING,
        command: workingFolderCommand(["update"]),
      },
    });

    await expect.element(page.getByText(WARNING)).toBeInTheDocument();
    // The alcove update command it names, for each shell.
    expectWorkingFolderCommandPerShell(app.container, " update");
    await expect
      .element(page.getByText(EDITED_TERMS_TITLE).first())
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: START_OPENED_EXCHANGE_LABEL }))
      .toBeEnabled();
  });

  test("unchanged terms draw no warning", async () => {
    render(editorFromCsv("Dana Okafor", csv), {
      continuesOpenedExchange: true,
    });

    await expect
      .element(page.getByRole("button", { name: START_OPENED_EXCHANGE_LABEL }))
      .toBeInTheDocument();
    expect(app.container.textContent).not.toContain(EDITED_TERMS_TITLE);
  });
});
