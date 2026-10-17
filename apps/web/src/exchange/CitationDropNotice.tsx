import { Alert } from "@mantine/core";
import { IconAlertCircle } from "@tabler/icons-react";

import type { CitationDrop } from "@psi/authoring/advancedInvite";

/**
 * The notice that a rule-set citation -- an imported document's, or the
 * built-in rules' on a draft seeded from them -- is left out of the terms the
 * editor emits; `citationDropFor` supplies the title and the body, which names
 * the cause and, where an edit here reaches it, the way back.
 *
 * One component for the two steps that show it -- Matching keys, where the edit
 * that costs the citation is made, and Review & create, where the terms are
 * confirmed -- so an operator who edits in one and creates from the other
 * cannot meet two wordings of the same fact, and one who works through either
 * step alone still meets it once.
 *
 * It blocks nothing: re-emitting the citation would claim a provenance the rules
 * do not have, so the operator is told what the outgoing document will say rather
 * than stopped from creating it. It is a `note`, not a Problems entry -- every
 * Problems entry holds the create gate shut.
 */
export function CitationDropNotice({ drop }: { drop: CitationDrop }) {
  return (
    <Alert
      role="note"
      color="yellow"
      icon={<IconAlertCircle aria-hidden />}
      title={drop.title}
      mt="md"
    >
      {drop.notice}
    </Alert>
  );
}
