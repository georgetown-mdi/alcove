/**
 * Layout checks for the WCAG 2.1 criteria about content surviving a narrow
 * viewport (1.4.10 Reflow) and user text spacing (1.4.12), run in the real
 * browser over a rendered surface.
 */

/** The text-spacing overrides WCAG 1.4.12 names, as a stylesheet a user
 * stylesheet or bookmarklet would apply. */
export const WCAG_TEXT_SPACING_CSS = `
  * {
    line-height: 1.5 !important;
    letter-spacing: 0.12em !important;
    word-spacing: 0.16em !important;
  }
  p { margin-bottom: 2em !important; }
`;

function describe(element: Element, detail: string): string {
  const tag = element.tagName.toLowerCase();
  const text = element.textContent.trim().slice(0, 50);
  return `<${tag}> ${detail} "${text}"`;
}

function scrollsHorizontally(element: Element): boolean {
  const overflowX = getComputedStyle(element).overflowX;
  return overflowX === "auto" || overflowX === "scroll";
}

function clips(element: Element): boolean {
  const style = getComputedStyle(element);
  return [style.overflowX, style.overflowY].some(
    (overflow) => overflow === "hidden" || overflow === "clip",
  );
}

/**
 * Content the reader loses under `root`: the page scrolling sideways, an
 * element past the viewport's left or right edge, or an element that clips
 * its own text. An element inside a block that scrolls on its own (a code
 * block's long line) is reachable by that block's scroll, so is not lost.
 */
export function lostContent(root: Element): Array<string> {
  const lost: Array<string> = [];
  const viewportWidth = document.documentElement.clientWidth;
  if (document.documentElement.scrollWidth > viewportWidth)
    lost.push(
      `the page scrolls sideways: ${document.documentElement.scrollWidth} px of content in ${viewportWidth} px`,
    );
  for (const element of root.querySelectorAll("*")) {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue;
    let ancestor = element.parentElement;
    let insideScroller = false;
    while (ancestor !== null && ancestor !== root) {
      if (scrollsHorizontally(ancestor)) insideScroller = true;
      ancestor = ancestor.parentElement;
    }
    if (insideScroller) continue;
    if (rect.right > viewportWidth + 0.5 || rect.left < -0.5)
      lost.push(
        describe(
          element,
          `spans ${Math.round(rect.left)} to ${Math.round(rect.right)} px`,
        ),
      );
    if (
      clips(element) &&
      element.textContent.trim() !== "" &&
      (element.scrollHeight > element.clientHeight + 1 ||
        element.scrollWidth > element.clientWidth + 1)
    )
      lost.push(
        describe(
          element,
          `clips ${element.scrollWidth}x${element.scrollHeight} px of content to ${element.clientWidth}x${element.clientHeight}`,
        ),
      );
  }
  return lost;
}
