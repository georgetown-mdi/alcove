/// <reference types="@vitest/browser-playwright/context" />

import { afterEach, expect, test } from "vitest";

import { tabTo } from "./keyboardOnly";

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

test("a control whose focus ring is removed fails the press that leaves it", async () => {
  mount(`
    <style>#bare:focus { outline: none; }</style>
    <button id="start">Start</button>
    <button id="bare">No ring</button>
    <button id="end">End</button>`);
  await expect(tabTo((focused) => focused.id === "end")).rejects.toThrow(
    /"No ring" looks the same focused and unfocused/,
  );
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
