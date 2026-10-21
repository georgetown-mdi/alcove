import { useEffect, useRef } from "react";

/**
 * A ref for the element with id `id`, scrolled into view and focused on mount
 * when the URL fragment names it, so keyboard and screen-reader users land on
 * it too. The element needs `tabIndex={-1}` to take focus. A section that
 * renders after an async load is not in the page when the browser or the
 * router acts on the fragment, so the section scrolls itself.
 */
export function useHashTarget<T extends HTMLElement>(id: string) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (window.location.hash !== `#${id}`) return;
    ref.current?.scrollIntoView();
    ref.current?.focus({ preventScroll: true });
  }, [id]);
  return ref;
}
