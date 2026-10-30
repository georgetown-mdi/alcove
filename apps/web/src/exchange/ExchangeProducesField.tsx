import { Anchor, NativeSelect, Radio } from "@mantine/core";

import { AlgorithmSchema } from "@alcove/core";

import { isConsoleBuild } from "@utils/clientConfig";

import {
  COUNT_ONLY_CHOICE_CAVEAT,
  MATCHING_METHOD_LABEL,
  MATCHING_METHOD_LABELS,
  RESULTS_DIRECTION_LABELS,
} from "@psi/formatting";

import { CONSOLE_ALGORITHM_GUIDE_URL } from "./userGuide";

import type { Algorithm } from "@alcove/core";
import type { OutputDirection } from "@psi/authoring/advancedInvite";

const ALGORITHMS: ReadonlyArray<Algorithm> = ["psi", "psi-c"];

const DIRECTIONS: ReadonlyArray<OutputDirection> = [
  "both",
  "inviter",
  "partner",
];

/**
 * The "What the exchange produces" choices that open Step 2: the matching
 * method, then who receives the matched results. They come before the column
 * choices because a count-only method and the result direction both constrain
 * what those columns may do, and they are grouped as the partner's consent
 * review groups them, under the same heading. On the console the count-only
 * choice links to the configuration key it is written into, for the operator
 * who moves the exchange to the command line.
 */
export function ExchangeProducesField({
  algorithm,
  onAlgorithm,
  direction,
  onDirection,
}: {
  algorithm: Algorithm;
  onAlgorithm: (algorithm: Algorithm) => void;
  direction: OutputDirection;
  onDirection: (direction: OutputDirection) => void;
}) {
  const countOnlyDescription = isConsoleBuild() ? (
    <>
      {COUNT_ONLY_CHOICE_CAVEAT}{" "}
      <Anchor
        inherit
        href={CONSOLE_ALGORITHM_GUIDE_URL}
        target="_blank"
        rel="noreferrer"
      >
        In a configuration file, this is algorithm: psi-c.
      </Anchor>
    </>
  ) : (
    COUNT_ONLY_CHOICE_CAVEAT
  );
  return (
    <>
      <h2>What the exchange produces</h2>
      <Radio.Group
        label={MATCHING_METHOD_LABEL}
        description="Reveal the matched identifiers, or only the count."
        value={algorithm}
        // Parsed rather than trusted so a Radio value literal drifting from
        // the enum throws loudly instead of typechecking clean.
        onChange={(value) => onAlgorithm(AlgorithmSchema.parse(value))}
      >
        {ALGORITHMS.map((value) => (
          <Radio
            key={value}
            value={value}
            label={MATCHING_METHOD_LABELS[value]}
            description={value === "psi-c" ? countOnlyDescription : undefined}
            mt="xs"
          />
        ))}
      </Radio.Group>
      <NativeSelect
        label="Who receives the matched results"
        description="The party who receives no results still contributes records to the match."
        value={direction}
        data={DIRECTIONS.map((value) => ({
          value,
          label: RESULTS_DIRECTION_LABELS[value],
        }))}
        onChange={(event) =>
          onDirection(event.currentTarget.value as OutputDirection)
        }
        mt="md"
      />
    </>
  );
}
