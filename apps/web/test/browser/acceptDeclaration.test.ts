/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page } from "vitest/browser";

import { createElement } from "react";

// Load Mantine's stylesheet so components render with their real geometry, as the
// other exchange component suites do.
import "@mantine/core/styles.css";

import {
  DEFAULT_MAX_DISPLAY_LENGTH,
  DISPLAY_TRUNCATION_MARKER,
  MAX_DECLARED_NAMES_SHOWN,
  MAX_NAME_LENGTH,
  safeParseLinkageTerms,
  sanitizeForDisplay,
} from "@alcove/core";
import { MAX_PAYLOAD_ENTRIES } from "@alcove/core/testing";

import {
  acceptorColumnsEditorState,
  acceptorInitialColumnsState,
  acceptorVerdict,
} from "@exchange/acceptorColumnsModel";

import { AcceptorColumnsStep } from "@exchange/AcceptorColumnsStep";

// The grid labels its controls through this helper, so a query for one derives the
// expected label from it rather than restating the isolate as literal characters.
import { isolatedColumnName } from "@components/ColumnName";

// applyDisclosure is the call the grid's own "How it is used" control edits
// through, so a test that opens on a column set to something other than "sent"
// reaches that state the way the operator would rather than by hand-writing
// role/isPayload.
import { applyDisclosure } from "@psi/metadataEditing";

import { createAppMount } from "./renderApp";

import type { LinkageTerms } from "@alcove/core";

// The confirm-columns step under an invitation whose declared payload set for this
// party is NON-EMPTY and disagrees with the operator's marks. The empty-declaration
// notice on the same screen, the one that holds the launch, has its own coverage in
// accept.test.ts; what is asserted here is that this notice informs without holding
// the launch, that both directions reach the operator in one statement, and that
// the two provenances of the names in it are treated differently at this sink.
const app = createAppMount();

afterEach(() => {
  app.unmount();
});

// Two single-element keys, one per name field, so the file below satisfies both and
// nothing but the declaration could close the launch.
const acceptorTerms: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: true, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

// Written as an escape, never as a raw byte, so a test about an invisible character
// is itself readable: U+202E RIGHT-TO-LEFT OVERRIDE reorders the copy around it
// wherever it is rendered unescaped and uncontained.
const RLO = "\u202E";

// Ordinary content rather than an attack, and outside printable ASCII: U+00E9 LATIN
// SMALL LETTER E WITH ACUTE is what a real header and a real declaration both
// contain, which is what makes it the character the two treatments on this screen
// disagree about. Written as an escape for the reason RLO above is.
const NON_ASCII = "\u00E9";

// What the conflict notice may show with the declaration flooded. An absolute
// number, not derived from MAX_DECLARED_NAMES_SHOWN, so removing that cap would
// not also remove this check. It leaves headroom over what the notice measures
// today (roughly 440 characters for a flooded declaration) and bounds only the
// partner-driven list, not the operator's own headers -- staying hundreds of
// times under the megabyte the same declaration would paint uncapped.
const NOTICE_CEILING = 4_000;

// What the notice says happens next, for every kind of difference.
const ASKED_TO_ACCEPT_DIFFERENCE =
  "Before any data is sent, your partner's run is asked to accept the " +
  "difference; a partner that cannot answer stops the exchange there.";

// The offer to send a declared column the file has, by the use that column has.
const WIDENING_OFFER = ' To send it, set it to "Sent to your partner" below.';

const WIDENING_OFFER_MATCHED =
  ' To send it, set it to "Used to match - sent to your partner" below.';

const WIDENING_OFFER_MATCHED_PLURAL =
  ' To send them, set them to "Used to match - sent to your partner" below.';

const WIDENING_OFFER_IDENTIFIER =
  ' To send it, set it to "Unique record identifier - sent to your partner"' +
  " below.";

// Where the declaration also names columns the file lacks, the offer names the
// ones the file has.
const WIDENING_OFFER_MATCHED_WITH_IDENTIFIER =
  " To send the ones in your file, set your record identifier to" +
  ' "Unique record identifier - sent to your partner" and the column used to' +
  ' match to "Used to match - sent to your partner" below.';

/** The launch is open and its reason line is empty. */
async function expectLaunchOpen() {
  const start = page.getByRole("button", { name: "Start the exchange" });
  await expect.element(start).toBeEnabled();
  expect(start.element().getAttribute("aria-describedby")).toBeNull();
  expect(page.getByTestId("launch-blocked-reason").element().textContent).toBe(
    "",
  );
}

function mountStep(
  linkageTerms: LinkageTerms,
  columns: Array<string>,
  // Columns the step opens with set to "Not used", the state a column has to be in
  // to sit in the declared-but-not-sent half while the file still contains it.
  // Every other column that inference does not recognize, which the seed lists
  // as ignored, opens set to sent.
  unsent: ReadonlyArray<string> = [],
  // Whether the record identifier, which the seed lists as not sent, opens set
  // to sent.
  identifierSent = false,
) {
  const rows = [Object.fromEntries(columns.map((c) => [c, "x"]))];
  const inferred = acceptorInitialColumnsState(columns);
  const columnsState = {
    ...inferred,
    metadata: inferred.metadata.map((column) => {
      if (unsent.includes(column.name))
        return applyDisclosure(column, "ignored");
      if (column.role === "ignored") return applyDisclosure(column, "payload");
      if (identifierSent && column.role === "identifier")
        return applyDisclosure(column, "identifier-sent");
      return column;
    }),
  };
  const editorState = acceptorColumnsEditorState(
    columnsState,
    linkageTerms,
    rows,
  );
  const noop = () => undefined;
  app.render(
    createElement(AcceptorColumnsStep, {
      linkageTerms,
      columns,
      sanitizedColumnPositions: [],
      columnsState,
      editorState,
      verdict: acceptorVerdict(columns, linkageTerms, editorState),
      onMetadataChange: noop,
      onRemap: noop,
      onReset: noop,
      onLaunch: noop,
      onBack: noop,
    }),
  );
}

// The declaration-conflict notice as one element, for an assertion about its whole
// rendered content rather than the page's. The step gives three advisories the
// role -- this one, the dead-key note, and the overlong-name note -- and neither of
// the other two holds in any scenario below, so the count is asserted rather than
// assumed: a second one appearing would otherwise silently redirect the query.
function declarationNotice(): HTMLElement {
  const notices = app.container.querySelectorAll<HTMLElement>('[role="note"]');
  expect(notices).toHaveLength(1);
  return notices[0];
}

describe("acceptor columns step: a disagreeing non-empty declaration", () => {
  test("states both directions at once, escaping the declared name and isolating the operator's own", async () => {
    // The declaration names a column this file does not send, while the file sends
    // one the declaration does not name: both halves are stated at once.
    const declaredName = `risk${RLO}score`;
    const ownHeader = `notes${RLO}evil`;
    mountStep(
      { ...acceptorTerms, payload: { receive: [{ name: declaredName }] } },
      ["first_name", "last_name", ownHeader],
    );

    await expect
      .element(
        page.getByText("Your columns differ from your partner's invitation"),
      )
      .toBeInTheDocument();
    const notice = declarationNotice();
    expect(notice.textContent).toContain("Sent, but not in the invitation:");
    expect(notice.textContent).toContain("In the invitation, but not sent:");
    expect(notice.textContent).toContain(ASKED_TO_ACCEPT_DIFFERENCE);

    // The operator's OWN header, named as the grid row names it: isolated, never
    // escaped.
    const marked = app.container.querySelector<HTMLElement>("li bdi");
    expect(marked?.textContent).toBe(ownHeader);
    expect(app.container.textContent).not.toContain(
      sanitizeForDisplay(ownHeader),
    );

    // The declared name is the partner's text on this path, so it reaches the
    // operator escaped -- the opposite treatment, in the same notice.
    expect(app.container.textContent).toContain(
      sanitizeForDisplay(declaredName),
    );
    expect(app.container.textContent).not.toContain(declaredName);

    await expectLaunchOpen();
  });

  test("informs, without holding the launch, when the file sends its record identifier and the invitation does not list it", async () => {
    // The operator set the `id` record identifier sent. An invitation from an
    // established exchange that lists only `notes` does not name it: the
    // partner's run is offered it as a terms change before any data is sent, so
    // the launch stays open.
    mountStep(
      { ...acceptorTerms, payload: { receive: [{ name: "notes" }] } },
      ["id", "first_name", "last_name", "notes"],
      [],
      true,
    );
    await expect
      .element(
        page.getByText("Your partner's invitation does not list this column"),
      )
      .toBeInTheDocument();
    const notice = declarationNotice();
    const painted = Array.from(notice.querySelectorAll("li")).map(
      (item) => item.textContent,
    );
    expect(painted).toEqual(["id"]);
    expect(notice.textContent).toContain(ASKED_TO_ACCEPT_DIFFERENCE);
    expect(notice.textContent).not.toContain('"How it is used"');
    await expectLaunchOpen();
  });

  // The file the tests below use: it satisfies every key and discloses exactly
  // one column.
  const columns = ["first_name", "last_name", "notes"];

  test("says a declared column is absent from the file, and offers no local edit for it", async () => {
    // A column this file does not contain cannot be marked at all, so the entry
    // says so and no offer to send it is made.
    mountStep(
      {
        ...acceptorTerms,
        payload: { receive: [{ name: "notes" }, { name: "risk_score" }] },
      },
      columns,
    );
    await expect
      .element(
        page.getByText(
          "Your partner's invitation lists a column you are not sending",
        ),
      )
      .toBeInTheDocument();
    const notice = declarationNotice();
    expect(notice.textContent).toContain(
      "risk_score - not a column in this file",
    );
    expect(notice.textContent).toContain(ASKED_TO_ACCEPT_DIFFERENCE);
    expect(notice.textContent).not.toContain("To send");
    await expectLaunchOpen();
  });

  test("offers to send a declared column the file matches on and keep matching on it", async () => {
    // The same direction where the offer exists, over the column it is most
    // often offered for: the declared column is in this file and used for
    // matching, so the offer names the choice that sends it and keeps its keys.
    mountStep(
      {
        ...acceptorTerms,
        payload: { receive: [{ name: "notes" }, { name: "first_name" }] },
      },
      columns,
    );
    await expect
      .element(
        page.getByText(
          "Your partner's invitation lists a column you are not sending",
        ),
      )
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(
      `${ASKED_TO_ACCEPT_DIFFERENCE}${WIDENING_OFFER_MATCHED}`,
    );
    expect(app.container.textContent).not.toContain(WIDENING_OFFER);
    expect(app.container.textContent).not.toContain(
      "not a column in this file",
    );
  });

  test("speaks about a held column the declaration names twice as the one column it is", async () => {
    // Nothing stops a declaration from naming the same column twice, and the whole
    // notice is about the operator's own columns: one name to read, one column to
    // set, and a title and an offer that both say one.
    const terms: LinkageTerms = {
      ...acceptorTerms,
      payload: {
        receive: [
          { name: "notes" },
          { name: "first_name" },
          { name: "first_name" },
        ],
      },
    };
    expect(safeParseLinkageTerms(terms).success).toBe(true);
    mountStep(terms, columns);
    await expect
      .element(
        page.getByText(
          "Your partner's invitation lists a column you are not sending",
        ),
      )
      .toBeInTheDocument();
    const painted = Array.from(declarationNotice().querySelectorAll("li")).map(
      (item) => item.textContent,
    );
    expect(painted).toEqual(["first_name"]);
    expect(app.container.textContent).toContain(
      `${ASKED_TO_ACCEPT_DIFFERENCE}${WIDENING_OFFER_MATCHED}`,
    );
    expect(app.container.textContent).not.toContain(
      WIDENING_OFFER_MATCHED_PLURAL,
    );
  });

  test("speaks about an absent column the declaration names twice as the one column it is", async () => {
    // The same repeat where the file does not have the column: one name listed,
    // and a title that says one.
    const terms: LinkageTerms = {
      ...acceptorTerms,
      payload: {
        receive: [
          { name: "notes" },
          { name: "risk_score" },
          { name: "risk_score" },
        ],
      },
    };
    expect(safeParseLinkageTerms(terms).success).toBe(true);
    mountStep(terms, columns);
    await expect
      .element(
        page.getByText(
          "Your partner's invitation lists a column you are not sending",
        ),
      )
      .toBeInTheDocument();
    const painted = Array.from(declarationNotice().querySelectorAll("li")).map(
      (item) => item.textContent,
    );
    expect(painted).toEqual(["risk_score - not a column in this file"]);
  });

  test("offers to send a column the file keeps as its record identifier as that identifier", async () => {
    // `record_id` is this file's record identifier, so it is neither matched on
    // nor sent. Setting it to "Sent to your partner" would drop it as the
    // identifier, so the offer names the identifier's own sending choice.
    const identifierColumns = ["first_name", "last_name", "record_id"];
    mountStep(
      { ...acceptorTerms, payload: { receive: [{ name: "record_id" }] } },
      identifierColumns,
    );
    await expect
      .element(
        page.getByText(
          "Your partner's invitation lists a column you are not sending",
        ),
      )
      .toBeInTheDocument();
    expect(app.container.textContent).toContain(
      `${ASKED_TO_ACCEPT_DIFFERENCE}${WIDENING_OFFER_IDENTIFIER}`,
    );
    expect(app.container.textContent).not.toContain(WIDENING_OFFER);

    // The use the grid states for the column the offer names. The label contains
    // the isolate as characters (a string sink cannot hold the markup), so the
    // query is built from the same helper the grid labels with.
    const use = app.container.querySelector<HTMLInputElement>(
      `[aria-label="How column ${isolatedColumnName("record_id")} is used"]`,
    );
    expect(use?.value).toBe("Unique record identifier - not sent");
  });

  test("bounds the declared-name list, and counts the rest, when the declaration is flooded", async () => {
    // The declaration at core's own ceiling, every name long enough to spend the
    // whole escaped display allowance: the shape that decides whether the operator
    // can still reach the grid and the launch control below this notice.
    const flooded = Array.from(
      { length: MAX_PAYLOAD_ENTRIES },
      (_, index) => `${index}-${NON_ASCII.repeat(MAX_NAME_LENGTH)}`,
    );
    // The assumption, asserted rather than assumed: each of those names spends the
    // whole per-value allowance at this sink and is cut at it, so what is measured
    // below is the worst case and not a mild one.
    const escaped = sanitizeForDisplay(flooded[0]);
    expect(escaped.endsWith(DISPLAY_TRUNCATION_MARKER)).toBe(true);
    expect(escaped.length).toBeGreaterThan(DEFAULT_MAX_DISPLAY_LENGTH);
    mountStep(
      {
        ...acceptorTerms,
        payload: { receive: flooded.map((name) => ({ name })) },
      },
      // No column of this file is marked to send, so the declared half is the only
      // direction that holds and every list item in the notice is a declared name.
      ["first_name", "last_name"],
    );
    await expect
      .element(
        page.getByText(
          "Your partner's invitation lists columns you are not sending",
        ),
      )
      .toBeInTheDocument();

    // What the same declaration would paint uncapped, measured rather than
    // asserted from the constants: the notice's bound is only worth pinning
    // against the size it replaces.
    const uncappedSize = flooded.reduce(
      (total, name) => total + sanitizeForDisplay(name).length,
      0,
    );
    expect(uncappedSize).toBeGreaterThan(1_000_000);

    const notice = declarationNotice();
    expect(notice.querySelectorAll("li")).toHaveLength(
      MAX_DECLARED_NAMES_SHOWN,
    );
    expect(notice.textContent).toContain(
      `and ${MAX_PAYLOAD_ENTRIES - MAX_DECLARED_NAMES_SHOWN} more not shown here.`,
    );
    expect(notice.textContent.length).toBeLessThanOrEqual(NOTICE_CEILING);
  });

  test("states the offer over a declaration longer than the list it paints", async () => {
    // The bound above paints names, not remedies: the columns the offer sets sit
    // past it here, so an offer read per painted name would say nothing at all.
    // The offer is one sentence over the whole declaration, and it is the whole
    // declaration it is read from.
    const unpainted = Array.from(
      { length: MAX_DECLARED_NAMES_SHOWN + 1 },
      (_, index) => `absent_${index}`,
    );
    // Two columns this file does have, at the two uses the offer covers: one it
    // matches on and one it keeps as its record identifier. The sentence names
    // each column's choice.
    const held = ["first_name", "record_id"];
    mountStep(
      {
        ...acceptorTerms,
        payload: {
          receive: [...unpainted, ...held].map((name) => ({ name })),
        },
      },
      ["first_name", "last_name", "record_id"],
    );
    await expect
      .element(
        page.getByText(
          "Your partner's invitation lists columns you are not sending",
        ),
      )
      .toBeInTheDocument();

    const notice = declarationNotice();
    const painted = Array.from(notice.querySelectorAll("li")).map(
      (item) => item.textContent,
    );
    expect(painted).toHaveLength(MAX_DECLARED_NAMES_SHOWN);
    for (const name of held) expect(painted).not.toContain(name);
    expect(notice.textContent).toContain(
      `${ASKED_TO_ACCEPT_DIFFERENCE}${WIDENING_OFFER_MATCHED_WITH_IDENTIFIER}`,
    );
    expect(notice.textContent.length).toBeLessThanOrEqual(NOTICE_CEILING);
  });

  test("escapes a declared name the file also has, while the grid row it points at renders that header verbatim", async () => {
    // The one column two provenances meet on: the invitation declares it and the
    // operator's file has a header of the same bytes. The notice escapes the
    // partner's copy -- it is text this operator cannot inspect -- while the grid
    // row it sends them to renders their own header as itself inside its isolate,
    // so the same name reaches the operator in two forms on one screen.
    const shared = `notes${NON_ASCII}`;
    mountStep(
      { ...acceptorTerms, payload: { receive: [{ name: shared }] } },
      ["first_name", "last_name", shared],
      [shared],
    );
    await expect
      .element(
        page.getByText(
          "Your partner's invitation lists a column you are not sending",
        ),
      )
      .toBeInTheDocument();

    const notice = declarationNotice();
    expect(notice.textContent).toContain(sanitizeForDisplay(shared));
    expect(notice.textContent).not.toContain(shared);
    // The column IS in the file, so the notice offers the local widening rather
    // than the absent-column line -- the half of the collision that makes the grid
    // row below a place the operator is actually sent.
    expect(notice.textContent).toContain(WIDENING_OFFER);
    expect(notice.textContent).not.toContain("not a column in this file");

    const rowHeaders = Array.from(
      app.container.querySelectorAll<HTMLElement>('th[scope="row"] bdi'),
    ).map((header) => header.textContent);
    expect(rowHeaders).toContain(shared);
    expect(rowHeaders).not.toContain(sanitizeForDisplay(shared));
  });
});
