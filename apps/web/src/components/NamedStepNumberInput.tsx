import { IconChevronDown, IconChevronUp } from "@tabler/icons-react";
import { NumberInput, UnstyledButton } from "@mantine/core";
import { useRef } from "react";

import styles from "@styles/app.module.css";

import type { NumberInputHandlers, NumberInputProps } from "@mantine/core";

/**
 * A Mantine NumberInput whose step buttons are named controls ("One more day",
 * "One fewer day") rather than Mantine's own, which are unnamed and hidden from
 * assistive tech. The buttons stay out of the Tab order, as Mantine's are: the
 * arrow keys step the focused field.
 */
export function NamedStepNumberInput({
  stepUnit,
  ...props
}: Omit<NumberInputProps, "rightSection" | "handlersRef"> & {
  /** The singular unit one step adds or removes ("day", "hour"). */
  stepUnit: string;
}) {
  const handlers = useRef<NumberInputHandlers>(undefined);
  const input = useRef<HTMLInputElement>(null);
  const { value, min, max, disabled, readOnly } = props;
  const atMax = typeof value === "number" && max !== undefined && value >= max;
  const atMin = typeof value === "number" && min !== undefined && value <= min;
  const step = (direction: "up" | "down") => {
    if (direction === "up") handlers.current?.increment();
    else handlers.current?.decrement();
    input.current?.focus();
  };
  return (
    <NumberInput
      {...props}
      ref={input}
      handlersRef={handlers}
      rightSection={
        readOnly === true ? undefined : (
          <div className={styles.stepControls}>
            <UnstyledButton
              className={styles.stepControl}
              tabIndex={-1}
              aria-label={`One more ${stepUnit}`}
              disabled={disabled === true || atMax}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => step("up")}
            >
              <IconChevronUp size={14} aria-hidden="true" />
            </UnstyledButton>
            <UnstyledButton
              className={styles.stepControl}
              tabIndex={-1}
              aria-label={`One fewer ${stepUnit}`}
              disabled={disabled === true || atMin}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => step("down")}
            >
              <IconChevronDown size={14} aria-hidden="true" />
            </UnstyledButton>
          </div>
        )
      }
    />
  );
}
