// @ts-check
// The default theme, plus the switcher and styles the guides under
// docs/guides/ use (docs/.vitepress/guides.mjs writes their markup).

import DefaultTheme from "vitepress/theme";

import GuideTabs from "./GuideTabs.mjs";
import "./guides.css";

/** @type {import("vitepress").Theme} */
export default {
  extends: DefaultTheme,
  enhanceApp({ app }) {
    app.component("GuideTabs", GuideTabs);
  },
};
