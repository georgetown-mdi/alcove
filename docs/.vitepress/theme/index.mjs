// @ts-check
// The default theme for the reference pages, and the guide layout for the
// guides under docs/guides/ (docs/.vitepress/guides.mjs writes their markup).
// The guide fonts are served from the site itself.

import "@fontsource-variable/inconsolata/wght.css";
import "@fontsource-variable/public-sans/wght.css";
import "@fontsource-variable/public-sans/wght-italic.css";
import "@fontsource-variable/source-serif-4/opsz.css";
import { useData } from "vitepress";
import DefaultTheme from "vitepress/theme";
import { defineComponent, h } from "vue";

import GuideLayout from "./GuideLayout.mjs";
import GuideTabs from "./GuideTabs.mjs";
import "./guides.css";

const Layout = defineComponent({
  name: "AlcoveLayout",
  setup() {
    const { frontmatter } = useData();
    return () =>
      frontmatter.value.guide ? h(GuideLayout) : h(DefaultTheme.Layout);
  },
});

/** @type {import("vitepress").Theme} */
export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }) {
    app.component("GuideTabs", GuideTabs);
  },
};
