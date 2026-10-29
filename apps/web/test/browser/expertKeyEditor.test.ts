/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, describe, expect, test } from "vitest";

import { page, userEvent } from "vitest/browser";

import { createElement, useState } from "react";

// Without Mantine's stylesheet the menu dropdown sits in the page flow and the
// icons are unsized, so a key card still expanding pushes "Add a transform"
// below the viewport after the click, and the menu hides its detached dropdown.
import "@mantine/core/styles.css";

import { authoredLinkageFields } from "@alcove/core";

import {
  addKey,
  seedAdvancedInvite,
  updateKeyAt,
} from "@psi/authoring/advancedInvite";
import { REMOVE_ALL_KEYS_STATEMENT } from "@psi/inviterEditor";

import { ExpertKeyEditor } from "@components/ExpertKeyEditor";

import { activate, control } from "./keyboardOnly";
import { restoreMatchMedia, stubReducedMotion } from "./reducedMotion";
import { createAppMount } from "./renderApp";

import type { AdvancedInviteDraft } from "@psi/authoring/advancedInvite";
import type { KeyVerdict } from "@psi/inviterEditor";
import type { LinkageKeyElement } from "@alcove/core";

// A file holding every default linkage column, so the seed keeps the full key set
// -- several collapsed key cards, each its own disclosure.
const ALL_COLUMNS = ["ssn", "ssn4", "first_name", "last_name", "dob"];

// The per-key cards in the expert key editor are collapsible disclosures: the
// toggle's aria-controls points at an always-mounted `<div id="key-body-...">`
// wrapper, not the Mantine Collapse panel, so the reference resolves in every state
// however Mantine mounts the closed panel under a reduced-motion preference (the
// same hardening DisclosureSection and InvitationTerms have). This pins that
// invariant against the accessibility tree once respectReducedMotion is on.

const app = createAppMount();

function render() {
  const { draft } = seedAdvancedInvite("County Health Dept", ALL_COLUMNS);
  const declaredFields = authoredLinkageFields(
    draft.metadata,
    draft.standardization,
  );
  app.render(
    createElement(ExpertKeyEditor, {
      draft,
      declaredFields,
      keyVerdict: (): KeyVerdict => ({ fitness: "satisfiable" }),
      onChange: () => undefined,
      announce: () => undefined,
    }),
  );
}

// The per-key disclosure toggles: their aria-controls ids are the only ones prefixed
// "key-body-", so this selector excludes the comboboxes inside each (collapsed) key
// body, which have their own aria-controls.
function keyToggleIds(): Array<string> {
  return Array.from(
    app.container.querySelectorAll<HTMLElement>('[aria-controls^="key-body-"]'),
  ).map((el) => el.getAttribute("aria-controls")!);
}

afterEach(() => {
  app.unmount();
  restoreMatchMedia();
});

describe("ExpertKeyEditor: per-key disclosures stay resolvable under reduced motion", () => {
  test("every collapsed key toggle's aria-controls resolves to a present, hidden wrapper", async () => {
    stubReducedMotion(true);
    render();

    // The editor renders at least one key card.
    await expect
      .element(page.getByRole("list", { name: "Linkage keys" }))
      .toBeInTheDocument();
    const ids = keyToggleIds();
    expect(ids.length).toBeGreaterThan(0);

    for (const id of ids) {
      const button = app.container.querySelector(`[aria-controls="${id}"]`);
      expect(button?.getAttribute("aria-expanded")).toBe("false");
      // Wait for the post-mount reduced-motion effect to collapse the panel away
      // (unmounted, or kept mounted hidden via React Activity -- both leave the
      // detail out of the accessibility tree).
      await expect
        .poll(() => {
          const panel = document.getElementById(id)
            ?.firstElementChild as HTMLElement | null;
          return panel === null || getComputedStyle(panel).display === "none";
        })
        .toBe(true);
      // ... and the wrapper holding the aria-controls id stays present, so the
      // reference never dangles.
      expect(document.getElementById(id)).not.toBeNull();
    }
  });
});

describe("ExpertKeyEditor: Remove all keys", () => {
  /** The editor over a live draft, recording what it announces. */
  function Harness({
    initial,
    announced,
  }: {
    initial: AdvancedInviteDraft;
    announced: Array<string>;
  }) {
    const [draft, setDraft] = useState(initial);
    return createElement(ExpertKeyEditor, {
      draft,
      declaredFields: authoredLinkageFields(
        draft.metadata,
        draft.standardization,
      ),
      keyVerdict: (): KeyVerdict => ({ fitness: "satisfiable" }),
      onChange: setDraft,
      announce: (message: string) => announced.push(message),
    });
  }

  const keyCards = () =>
    Array.from(
      page.getByRole("list", { name: "Linkage keys" }).element().children,
    );

  const confirm = () => page.getByRole("dialog", { name: "Remove all keys?" });

  test("empties a list of built-in keys in one action, announces it, and keeps focus in the editor", async () => {
    const { draft } = seedAdvancedInvite("County Health Dept", ALL_COLUMNS);
    const announced: Array<string> = [];
    app.render(createElement(Harness, { initial: draft, announced }));

    const removeAll = page.getByRole("button", { name: "Remove all keys" });
    await expect.element(removeAll).toBeEnabled();
    await expect.element(removeAll).not.toHaveAttribute("aria-haspopup");
    expect(keyCards().length).toBe(draft.keys.length);
    expect(draft.keys.length).toBeGreaterThan(1);

    await activate(control("button", "Remove all keys"));

    await expect.poll(keyCards).toHaveLength(0);
    expect(confirm().query()).toBeNull();
    await expect.element(removeAll).toBeDisabled();
    expect(announced).toEqual(["Removed all keys."]);
    await expect
      .element(page.getByRole("button", { name: "Add a key" }))
      .toHaveFocus();
  });

  test("asks first once a key is added, and Cancel keeps every key", async () => {
    const { draft: seeded } = seedAdvancedInvite(
      "County Health Dept",
      ALL_COLUMNS,
    );
    const draft = addKey(seeded, "first_name");
    const announced: Array<string> = [];
    app.render(createElement(Harness, { initial: draft, announced }));

    const removeAll = page.getByRole("button", { name: "Remove all keys" });
    await expect.element(removeAll).toHaveAttribute("aria-haspopup", "dialog");
    await userEvent.click(removeAll);

    await expect
      .element(confirm())
      .toMatchTextContent(REMOVE_ALL_KEYS_STATEMENT);
    await confirm().getByRole("button", { name: "Cancel" }).click();

    await expect.element(confirm()).not.toBeInTheDocument();
    expect(keyCards()).toHaveLength(draft.keys.length);
    expect(announced).toEqual([]);
  });

  test("asks first once a built-in key is changed, then empties the list, announces it, and keeps focus in the editor", async () => {
    const { draft: seeded } = seedAdvancedInvite(
      "County Health Dept",
      ALL_COLUMNS,
    );
    const draft = updateKeyAt(seeded, 0, (key) => ({
      ...key,
      name: `${key.name} (mine)`,
    }));
    const announced: Array<string> = [];
    app.render(createElement(Harness, { initial: draft, announced }));

    const removeAll = page.getByRole("button", { name: "Remove all keys" });
    await userEvent.click(removeAll);
    await expect.element(confirm()).toBeInTheDocument();
    expect(keyCards()).toHaveLength(draft.keys.length);
    expect(announced).toEqual([]);

    await confirm().getByRole("button", { name: "Remove all keys" }).click();

    await expect.poll(keyCards).toHaveLength(0);
    await expect.element(confirm()).not.toBeInTheDocument();
    await expect.element(removeAll).toBeDisabled();
    expect(announced).toEqual(["Removed all keys."]);
    await expect
      .element(page.getByRole("button", { name: "Add a key" }))
      .toHaveFocus();
  });

  test("is disabled on an empty list", async () => {
    const { draft } = seedAdvancedInvite("County Health Dept", ALL_COLUMNS);
    app.render(
      createElement(Harness, {
        initial: { ...draft, keys: [] },
        announced: [],
      }),
    );

    await expect
      .element(page.getByRole("button", { name: "Remove all keys" }))
      .toBeDisabled();
    await expect
      .element(page.getByRole("button", { name: "Add a key" }))
      .toBeEnabled();
  });
});

describe("ExpertKeyEditor: a key element's split", () => {
  const KEY_NAME = "Last name";

  /** The editor over a live one-key draft, reporting each draft it emits. */
  function Harness({
    initial,
    onDraft,
  }: {
    initial: AdvancedInviteDraft;
    onDraft: (draft: AdvancedInviteDraft) => void;
  }) {
    const [draft, setDraft] = useState(initial);
    return createElement(ExpertKeyEditor, {
      draft,
      declaredFields: authoredLinkageFields(
        draft.metadata,
        draft.standardization,
      ),
      keyVerdict: (): KeyVerdict => ({ fitness: "satisfiable" }),
      onChange: (next: AdvancedInviteDraft) => {
        setDraft(next);
        onDraft(next);
      },
      announce: () => undefined,
    });
  }

  /** The editor over one key on `last_name` whose element transform is
   * `transform`, its card expanded. */
  async function renderedKey(
    linkageStrategy: AdvancedInviteDraft["linkageStrategy"],
    transform: LinkageKeyElement["transform"],
    onDraft: (draft: AdvancedInviteDraft) => void = () => undefined,
  ): Promise<void> {
    const { draft } = seedAdvancedInvite("County Health Dept", ALL_COLUMNS);
    app.render(
      createElement(Harness, {
        initial: {
          ...draft,
          linkageStrategy,
          keys: [
            {
              key: {
                name: KEY_NAME,
                elements: [{ field: "last_name", transform }],
              },
              enabled: true,
            },
          ],
        },
        onDraft,
      }),
    );
    const toggle = page.getByRole("button", { name: KEY_NAME, exact: true });
    await userEvent.click(toggle);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    // Wait until the card body has finished opening. A click while it still
    // grows scrolls the clipped body to bring its control into view; the body
    // unwinds that scroll as it opens, moving the control, so the press and the
    // release can land on different elements and no click fires.
    const panel = document.getElementById(
      toggle.element().getAttribute("aria-controls")!,
    )!.firstElementChild as HTMLElement;
    await expect
      .element(panel)
      .toSatisfy(
        (el: HTMLElement) =>
          el.clientHeight > 0 && el.clientHeight === el.scrollHeight,
      );
  }

  test.each(["cascade", "single-pass"] as const)(
    "an element's transform menu offers Split on and no other raw pattern under %s",
    async (linkageStrategy) => {
      await renderedKey(linkageStrategy, undefined);

      await userEvent.click(
        page.getByRole("button", { name: "Add a transform" }),
      );
      await expect
        .element(page.getByRole("menuitem", { name: "Split on" }))
        .toBeInTheDocument();
      expect(
        page.getByRole("menuitem", { name: "Filter (regex)" }).elements(),
      ).toHaveLength(0);
    },
  );

  test("an element's split edits in place, leaving the rest of its transform", async () => {
    let emitted: AdvancedInviteDraft | undefined;
    await renderedKey(
      "cascade",
      [
        { function: "to_upper_case" },
        {
          function: "split_on",
          params: { delimiter: "-", includeOriginal: true },
        },
      ],
      (next) => {
        emitted = next;
      },
    );

    await userEvent.fill(
      page.getByRole("textbox", { name: "Delimiter pattern" }),
      "_",
    );
    await expect
      .poll(() => emitted?.keys[0].key.elements[0].transform)
      .toEqual([
        { function: "to_upper_case" },
        {
          function: "split_on",
          params: { delimiter: "_", includeOriginal: true },
        },
      ]);
  });
});

describe("ExpertKeyEditor: the per-key badges", () => {
  test("name what the file supplies, the missing column, and a dropping cleaning", async () => {
    const { draft } = seedAdvancedInvite("County Health Dept", ALL_COLUMNS);
    const verdicts: Array<KeyVerdict> = [
      { fitness: "unsatisfiable", missingField: "phone_number" },
      { fitness: "dead" },
    ];
    app.render(
      createElement(ExpertKeyEditor, {
        draft,
        declaredFields: authoredLinkageFields(
          draft.metadata,
          draft.standardization,
        ),
        keyVerdict: (index: number): KeyVerdict =>
          verdicts[index] ?? { fitness: "satisfiable" },
        onChange: () => undefined,
        announce: () => undefined,
      }),
    );

    await expect
      .element(
        page.getByRole("img", {
          name: "Your file has no column for phone_number",
        }),
      )
      .toMatchTextContent("no column for phone_number");
    await expect
      .element(
        page.getByRole("img", {
          name: "This key's cleaning drops every value; review the transform",
        }),
      )
      .toMatchTextContent("cleaning drops every value");
    await expect
      .element(
        page
          .getByRole("img", {
            name: "Your file supplies every field this key uses",
          })
          .first(),
      )
      .toMatchTextContent("your file supplies it");
  });
});
