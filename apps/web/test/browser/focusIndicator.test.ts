/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";

import { activate, tabTo } from "./keyboardOnly";

// The focus indicator check every keyboard-only journey runs at each Tab press
// (keyboardOnly.ts, tabTo), held against controls that do and do not change
// when they take focus.

const fixture = document.createElement("div");

afterEach(() => {
  fixture.remove();
  fixture.innerHTML = "";
});

function mount(html: string): void {
  fixture.innerHTML = html;
  document.body.appendChild(fixture);
  (fixture.querySelector("#start") as HTMLElement).focus();
}

test("a control whose focus ring is removed fails the press that reaches it", async () => {
  mount(`
    <style>#bare:focus { outline: none; }</style>
    <button id="start">Start</button>
    <button id="bare">No ring</button>
    <button id="end">End</button>`);
  await expect(tabTo((focused) => focused.id === "end")).rejects.toThrow(
    /"No ring" looks the same focused and unfocused/,
  );
});

// A journey activates the control tabTo stops on, which then loses focus to
// script or is never followed by another Tab: it is checked as focus arrives.
test("a control activated right after Tab reaches it is checked", async () => {
  mount(`
    <style>#bare:focus { outline: none; }</style>
    <button id="start">Start</button>
    <button id="bare">No ring</button>
    <h1 id="heading" tabindex="-1">Next step</h1>`);
  fixture
    .querySelector("#bare")
    ?.addEventListener("click", () =>
      (fixture.querySelector("#heading") as HTMLElement).focus(),
    );
  await expect(activate((focused) => focused.id === "bare")).rejects.toThrow(
    /"No ring" looks the same focused and unfocused/,
  );
  expect(document.activeElement?.id).toBe("bare");
});

test("a Shift+Tab stop is checked against its look before the press", async () => {
  mount(`
    <style>#bare:focus { outline: none; }</style>
    <button id="bare">No ring</button>
    <button id="start">Start</button>`);
  await expect(
    tabTo((focused) => focused.id === "bare", { backward: true }),
  ).rejects.toThrow(/"No ring" looks the same focused and unfocused/);
});

test("the browser's own focus ring passes", async () => {
  mount(`
    <button id="start">Start</button>
    <button id="ringed">Default ring</button>
    <button id="end">End</button>`);
  await tabTo((focused) => focused.id === "end");
  expect(document.activeElement?.id).toBe("end");
});

test("a border change on focus passes", async () => {
  mount(`
    <style>
      #bordered { border: 1px solid gray; }
      #bordered:focus { outline: none; border-color: blue; }
    </style>
    <button id="start">Start</button>
    <input id="bordered" aria-label="Bordered">
    <button id="end">End</button>`);
  await tabTo((focused) => focused.id === "end");
  expect(document.activeElement?.id).toBe("end");
});
