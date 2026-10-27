// @ts-check
// A guide's platform or channel switcher. The reader's pick is shared by every
// switcher of the same group, on this page and the next, and kept in
// localStorage; the server render shows the first pane.

import {
  computed,
  defineComponent,
  h,
  nextTick,
  onMounted,
  reactive,
  useId,
} from "vue";

const STORAGE_PREFIX = "alcove-tab:";

/** @type {Record<string, string>} */
const selections = reactive({});

/** @param {string} group */
function readStored(group) {
  try {
    return localStorage.getItem(STORAGE_PREFIX + group);
  } catch {
    return null;
  }
}

/** @param {string} group @param {string} name */
function store(group, name) {
  try {
    localStorage.setItem(STORAGE_PREFIX + group, name);
  } catch {
    // Storage refused (private mode, quota): the pick lasts for this visit.
  }
}

export default defineComponent({
  name: "GuideTabs",
  props: {
    group: { type: String, required: true },
    names: { type: String, required: true },
  },
  setup(props, { slots }) {
    const id = useId();
    const names = computed(() => props.names.split("|"));
    const selected = computed(() => {
      const pick = selections[props.group];
      return pick && names.value.includes(pick) ? pick : names.value[0];
    });

    onMounted(() => {
      if (selections[props.group] !== undefined) return;
      const stored = readStored(props.group);
      if (stored) selections[props.group] = stored;
    });

    /** @param {HTMLElement} tab @param {string} name */
    function choose(tab, name) {
      const top = tab.getBoundingClientRect().top;
      selections[props.group] = name;
      store(props.group, name);
      // Keep the chosen tab where the reader clicked it, even when a switcher
      // above it changes height.
      void nextTick(() => {
        window.scrollBy(0, tab.getBoundingClientRect().top - top);
      });
    }

    /** @param {KeyboardEvent} event */
    function onKeydown(event) {
      if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
      const tab = /** @type {HTMLElement} */ (event.currentTarget);
      const list = /** @type {HTMLElement} */ (tab.parentElement);
      const next = /** @type {HTMLElement} */ (
        event.key === "ArrowRight"
          ? (tab.nextElementSibling ?? list.firstElementChild)
          : (tab.previousElementSibling ?? list.lastElementChild)
      );
      event.preventDefault();
      choose(next, next.dataset.name ?? "");
      next.focus();
    }

    return () =>
      h("div", { class: "guide-tabs", "data-group": props.group }, [
        h(
          "div",
          {
            role: "tablist",
            "aria-label": props.group === "channel" ? "Channel" : "Platform",
          },
          names.value.map((name, index) => {
            const on = name === selected.value;
            return h(
              "button",
              {
                type: "button",
                role: "tab",
                id: `${id}-tab-${index}`,
                "aria-selected": on ? "true" : "false",
                "aria-controls": `${id}-panel-${index}`,
                tabindex: on ? 0 : -1,
                "data-name": name,
                onClick: (/** @type {MouseEvent} */ event) =>
                  choose(
                    /** @type {HTMLElement} */ (event.currentTarget),
                    name,
                  ),
                onKeydown,
              },
              name,
            );
          }),
        ),
        ...names.value.map((name, index) =>
          h(
            "div",
            {
              role: "tabpanel",
              id: `${id}-panel-${index}`,
              "aria-labelledby": `${id}-tab-${index}`,
              "data-name": name,
              hidden: name !== selected.value,
            },
            slots[`pane-${index}`]?.(),
          ),
        ),
      ]);
  },
});
