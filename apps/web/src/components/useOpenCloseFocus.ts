import { useEffect, useRef } from "react";

/**
 * Focus for a setting shown as one line until the user opens it: the field
 * takes focus once it opens, and the line's action once it closes. A handler
 * that opens or closes the setting calls `focusFieldNext` or
 * `focusActionNext` first; the move happens after the render that shows it.
 */
export function useOpenCloseFocus<TField extends HTMLElement>() {
  const focusNext = useRef<"field" | "action" | undefined>(undefined);
  const fieldRef = useRef<TField>(null);
  const actionRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const target = focusNext.current;
    if (target === undefined) return;
    focusNext.current = undefined;
    (target === "field" ? fieldRef.current : actionRef.current)?.focus();
  });
  return {
    fieldRef,
    actionRef,
    focusFieldNext: () => {
      focusNext.current = "field";
    },
    focusActionNext: () => {
      focusNext.current = "action";
    },
  };
}
