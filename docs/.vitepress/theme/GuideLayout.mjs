// @ts-check
// The layout of the guides under docs/guides/: a top bar, the rail of guide
// pages, the page on its sheet and the page ledger beside it. The menus list
// the guides and, under About, one link to the documentation; docs/.vitepress/guides.mjs writes the page markup and the
// ledger's HTML, and config.mjs passes the menu as `themeConfig.guideSections`.

import { Content, useData, useRouter } from "vitepress";
import { computed, defineComponent, h } from "vue";

/**
 * @typedef {{ title: string, link: string, stem: string }} GuidePage
 * @typedef {{ group: string, topNav: boolean, pages: GuidePage[] }} GuideSection
 */

/** The link to the reference documentation, listed last in the About group. */
const DOCUMENTATION_LINK = { title: "Documentation", link: "/docs/" };

/** @param {GuideSection} section */
function hasDocumentationLink(section) {
  return section.group === "About";
}

/** @param {string} href @param {string} text */
function externalLink(href, text) {
  return h("a", { href, target: "_blank", rel: "noopener" }, text);
}

export default defineComponent({
  name: "GuideLayout",
  setup() {
    const { frontmatter, theme } = useData();
    const router = useRouter();
    const guide = computed(() => frontmatter.value.guide);
    /** @type {import("vue").ComputedRef<GuideSection[]>} */
    const sections = computed(() => theme.value.guideSections ?? []);
    function topBar() {
      return h("header", { class: "top" }, [
        h("div", { class: "band stripe" }),
        h("div", { class: "inner" }, [
          h("a", { class: "wordmark", href: "/" }, [
            h("span", { class: "mark" }),
            "Alcove",
          ]),
          h(
            "nav",
            { class: "topnav", "aria-label": "Sections" },
            sections.value
              .filter((section) => section.topNav)
              .map((section) =>
                h(
                  "a",
                  {
                    href: section.pages[0].link,
                    "aria-current":
                      section.group === guide.value.group ? "true" : "false",
                  },
                  section.group,
                ),
              ),
          ),
          h("span", { class: "spacer" }),
          h(
            "a",
            {
              class: "btn fill",
              href: theme.value.webAppUrl,
              target: "_blank",
              rel: "noopener",
            },
            "Open the web app",
          ),
        ]),
      ]);
    }

    function rail() {
      return h(
        "aside",
        { class: "rail", "aria-label": "Pages" },
        sections.value.map((section) =>
          h("div", { class: "group" }, [
            h("h2", section.group),
            h("ul", [
              ...section.pages.map((page) =>
                h("li", [
                  h(
                    "a",
                    {
                      href: page.link,
                      "aria-current":
                        page.stem === guide.value.stem ? "page" : "false",
                    },
                    page.title,
                  ),
                ]),
              ),
              ...(hasDocumentationLink(section)
                ? [
                    h("li", [
                      h(
                        "a",
                        {
                          href: DOCUMENTATION_LINK.link,
                          "aria-current": "false",
                        },
                        DOCUMENTATION_LINK.title,
                      ),
                    ]),
                  ]
                : []),
            ]),
          ]),
        ),
      );
    }

    function picker() {
      return h("div", { class: "picker" }, [
        h("label", { class: "eyebrow", for: "guide-page-picker" }, "Page"),
        " ",
        h(
          "select",
          {
            id: "guide-page-picker",
            onChange: (/** @type {Event} */ event) => {
              const select = /** @type {HTMLSelectElement} */ (event.target);
              void router.go(select.value);
            },
          },
          sections.value.map((section) =>
            h(
              "optgroup",
              { label: section.group },
              [
                ...section.pages.map((page) =>
                  h(
                    "option",
                    {
                      value: page.link,
                      selected: page.stem === guide.value.stem,
                    },
                    page.title,
                  ),
                ),
                ...(hasDocumentationLink(section)
                  ? [
                      h(
                        "option",
                        { value: DOCUMENTATION_LINK.link, selected: false },
                        DOCUMENTATION_LINK.title,
                      ),
                    ]
                  : []),
              ],
            ),
          ),
        ),
      ]);
    }

    function footer() {
      const REPOSITORY_URL = theme.value.repositoryUrl;
      return h("footer", { class: "foot" }, [
        h(
          "span",
          "Alcove is built at Georgetown University's Massive Data Institute.",
        ),
        h("a", { href: "/about" }, "About"),
        externalLink(REPOSITORY_URL, "GitHub"),
        externalLink(`${REPOSITORY_URL}/blob/main/CHANGELOG.md`, "Changelog"),
        externalLink(
          `${REPOSITORY_URL}/blob/main/LICENSE.md`,
          "Apache License 2.0",
        ),
      ]);
    }

    return () => {
      const ledger = guide.value.ledger;
      return h("div", { class: "guide-site" }, [
        topBar(),
        h("div", { class: ledger ? "frame" : "frame wide" }, [
          rail(),
          h("main", { class: "sheet" }, [
            picker(),
            h(Content, {
              class: ["doc", guide.value.stem === "about" ? "about" : ""],
            }),
            footer(),
          ]),
          ledger
            ? h("aside", {
                class: "ledger-col",
                "aria-label": "This page",
                innerHTML: ledger,
              })
            : null,
        ]),
      ]);
    };
  },
});
