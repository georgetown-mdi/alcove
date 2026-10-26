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

import {
  parseCoordinationServerUrl,
  writeCoordinationServerSetting,
} from "@psi/transport/coordinationServerSetting";
import { COORDINATION_SERVER_UNREADABLE_AT_INVITE } from "@exchange/CoordinationServerSection";

import { createAppMount } from "./renderApp";

import type { AcquiredCsv, InviterEditor } from "@psi/inviterEditor";
import type { AdvancedInviteDraft } from "@psi/authoring/advancedInvite";

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
    editedTermsWarning?: string;
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
      onDirection: () => undefined,
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

describe("ReviewCreateSection: an unreadable coordination server setting", () => {
  const unreadableWarning = () =>
    page.getByText(COORDINATION_SERVER_UNREADABLE_AT_INVITE);

  afterEach(() => {
    window.localStorage.clear();
  });

  test("warns that the invitation will name this site's server", async () => {
    window.localStorage.setItem("alcove-own-coordination-server", "{not json");
    render(editorFromCsv("Dana Okafor", csv));

    expect(COORDINATION_SERVER_UNREADABLE_AT_INVITE).toBe(
      "Your saved coordination server could not be read, so this " +
        "invitation will name this site's coordination server. To use " +
        "yours, set it again in relay settings before you create the " +
        "invitation.",
    );
    await expect.element(unreadableWarning()).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Create the invitation" }))
      .toBeEnabled();
  });

  test("shows nothing where the setting is unset or readable", async () => {
    render(editorFromCsv("Dana Okafor", csv));
    await expect
      .element(page.getByRole("heading", { name: "Review & create" }))
      .toBeInTheDocument();
    expect(unreadableWarning().query()).toBeNull();

    app.unmount();
    const entry = parseCoordinationServerUrl(
      `${window.location.protocol === "https:" ? "wss" : "ws"}://coordination.agency.example/`,
      window.location.protocol,
    );
    if (!entry.ok) throw new Error(entry.message);
    writeCoordinationServerSetting(entry.url);
    render(editorFromCsv("Dana Okafor", csv));
    await expect
      .element(page.getByRole("heading", { name: "Review & create" }))
      .toBeInTheDocument();
    expect(unreadableWarning().query()).toBeNull();
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
      editedTermsWarning: WARNING,
    });

    await expect.element(page.getByText(WARNING)).toBeInTheDocument();
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
