// Workflow script for /panel, invoked as
// Workflow({scriptPath: '.claude/scripts/panel-workflow.mjs', args: {...}}).
//
// It is a Workflow script BODY, not a module: the harness injects `args`,
// `agent`, and `parallel`, and takes the top-level `return` as the run's result.
// No ES module parser accepts a top-level return, which is why eslint.config.mjs
// excludes this file; .claude/scripts/panel-script.test.mjs compiles it as a
// function body and drives it.

export const meta = {
  name: "panel",
  description:
    "Independent schema-forced panelists on one design question, with an opt-in single deliberation round",
  phases: [{ title: "Panel" }, { title: "Deliberate" }],
};

const SCHEMA = {
  type: "object",
  required: ["position", "rationale", "keyRisk"],
  properties: {
    position: {
      type: "string",
      description: "Your answer to the question in one or two sentences.",
    },
    rationale: {
      type: "string",
      description: "Why, grounded in what you read. Compact prose.",
    },
    keyRisk: {
      type: "string",
      description: "The strongest consideration against your own position.",
    },
  },
};

const REVISED_SCHEMA = {
  type: "object",
  required: [...SCHEMA.required, "changed"],
  properties: {
    ...SCHEMA.properties,
    changed: {
      type: "boolean",
      description: "Whether your position differs from your first one.",
    },
  },
};

// The seats a caller may name. A caller may instead state a lens of its own as
// {name, lens}; a call that names no seats sits DEFAULT_SEATS.
const SEATS = {
  "failure-modes": "correctness and failure modes",
  architecture: "architecture and maintenance cost",
  pragmatics: "operational and cost pragmatics",
  "design-ux":
    "design and user experience -- the user-facing flows, the states a user can reach, the copy, and what the operator sees and does at each step",
};
const DEFAULT_SEATS = ["failure-modes", "architecture", "pragmatics"];

const DELIBERATION_NOTE =
  "A converged deliberation informs the owner and settles nothing: the question goes to the owner with every panelist's first and revised positions.";

// The harness may hand a script its arguments as JSON text rather than as the
// object the caller passed. Any other delivery -- an array, a bare scalar, null,
// nothing at all -- has no named field, and reading one off it yields
// undefined rather than failing, so the round would reach its agents with holes
// where the caller's arguments belong. Resolving fails closed on it instead, and
// `npm run check:workflow-args-resolve` holds every read of `args` in a
// committed Workflow script to the one call below.
function resolveWorkflowArgs(delivered) {
  const expected = "an object of named arguments, or the JSON text of one";
  let resolved = delivered;
  if (typeof delivered === "string") {
    try {
      resolved = JSON.parse(delivered);
    } catch (cause) {
      throw new Error(`args is text that is not JSON; expected ${expected}.`, {
        cause,
      });
    }
  }
  if (
    resolved === null ||
    typeof resolved !== "object" ||
    Array.isArray(resolved)
  ) {
    const got =
      resolved === null
        ? "null"
        : Array.isArray(resolved)
          ? "an array"
          : resolved === undefined
            ? "nothing"
            : `a ${typeof resolved}`;
    throw new Error(`args resolved to ${got}; expected ${expected}.`);
  }
  return resolved;
}

const isText = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

function resolveSeat(seat) {
  if (typeof seat === "string") {
    if (!Object.hasOwn(SEATS, seat)) {
      throw new Error(
        `Unknown seat "${seat}": name one of ${Object.keys(SEATS).join(", ")}, or state a lens as {"name": ..., "lens": ...}.`,
      );
    }
    return { name: seat, lens: SEATS[seat] };
  }
  if (!isObject(seat) || !isText(seat.name) || !isText(seat.lens)) {
    throw new Error(
      `A seat is a seat name or {"name": ..., "lens": ...} with both non-empty; got ${JSON.stringify(seat)}.`,
    );
  }
  if (Object.hasOwn(SEATS, seat.name)) {
    throw new Error(
      `The stated lens "${seat.name}" has the name of a named seat; give it a name of its own.`,
    );
  }
  return { name: seat.name, lens: seat.lens };
}

function resolveSeats(seats) {
  if (seats === undefined) return DEFAULT_SEATS.map(resolveSeat);
  if (!Array.isArray(seats) || seats.length < 2) {
    throw new Error(
      `seats is a list of at least two seats; got ${JSON.stringify(seats)}.`,
    );
  }
  const resolved = seats.map(resolveSeat);
  const names = resolved.map((seat) => seat.name);
  const repeated = names.find((name, i) => names.indexOf(name) !== i);
  if (repeated !== undefined) {
    throw new Error(`The seat "${repeated}" is named twice.`);
  }
  return resolved;
}

function resolveDocs(docs) {
  if (docs === undefined) return [];
  if (!Array.isArray(docs) || !docs.every(isText)) {
    throw new Error(
      `docs is a list of repo-relative paths; got ${JSON.stringify(docs)}.`,
    );
  }
  return docs;
}

const firstAnswer = (answer) =>
  Object.fromEntries(SCHEMA.required.map((key) => [key, answer[key]]));

// A deliberation call passes back the first round's result verbatim. Anything
// else -- a deliberation's own result above all -- is refused, so a
// deliberation cannot be chained into a second one.
function resolveFirstRound(first) {
  if (
    !isObject(first) ||
    first.round !== "first" ||
    !isText(first.question) ||
    !Array.isArray(first.seats) ||
    !Array.isArray(first.positions)
  ) {
    throw new Error(
      "deliberate takes the first round's result exactly as the panel returned it.",
    );
  }
  const seats = resolveSeats(
    first.seats.map((seat) =>
      isObject(seat) && Object.hasOwn(SEATS, seat.name) ? seat.name : seat,
    ),
  );
  const names = seats.map((seat) => seat.name);
  const answered = new Set();
  for (const answer of first.positions) {
    if (
      !isObject(answer) ||
      !names.includes(answer.seat) ||
      answered.has(answer.seat) ||
      !SCHEMA.required.every((key) => typeof answer[key] === "string")
    ) {
      throw new Error(
        `deliberate holds a position that is not one of the first round's: ${JSON.stringify(answer)}.`,
      );
    }
    answered.add(answer.seat);
  }
  if (answered.size < 2) {
    throw new Error(
      "A deliberation needs at least two first positions; take the question to the owner as it stands.",
    );
  }
  return {
    question: first.question,
    docs: resolveDocs(first.docs),
    seats,
    positions: first.positions.map((answer) => ({
      seat: answer.seat,
      ...firstAnswer(answer),
    })),
  };
}

const input = resolveWorkflowArgs(args);

const deliberating = input.deliberate !== undefined;
if (
  deliberating &&
  ["question", "docs", "seats"].some((key) => input[key] !== undefined)
) {
  throw new Error(
    "A deliberation call passes deliberate alone: its question, docs, and seats come from the first round's result.",
  );
}
if (!deliberating && !isText(input.question)) {
  throw new Error("question is the non-empty text of the panel's question.");
}
const panel = deliberating
  ? resolveFirstRound(input.deliberate)
  : {
      question: input.question,
      docs: resolveDocs(input.docs),
      seats: resolveSeats(input.seats),
    };

const docsClause = panel.docs.length
  ? `Read these first for context: ${panel.docs.map((d) => "/tmp/panel-base/" + d).join(", ")}.\n\n`
  : "";

const requiredKeysClause = (schema) =>
  `Your structured result must have every one of these top-level keys: ${schema.required.map((key) => `\`${key}\``).join(", ")}.`;

const briefing = (
  lens,
) => `You are an independent expert panelist. Read ONLY under /tmp/panel-base, a clean checkout of the project's mainline: do not read, cd into, or search /workspace, and do not run builds or tests (the tree has no node_modules). You are one of several panelists and must not coordinate; answer from your own read.

${docsClause}Weigh the question primarily through this lens: ${lens}. Then answer it directly -- an answer, not a survey of options.

The question:
${panel.question}`;

const lensOf = (name) => panel.seats.find((seat) => seat.name === name).lens;

if (!deliberating) {
  const answers = await parallel(
    panel.seats.map(
      (seat) => () =>
        agent(`${briefing(seat.lens)}\n\n${requiredKeysClause(SCHEMA)}`, {
          label: `panelist: ${seat.name}`,
          phase: "Panel",
          schema: SCHEMA,
          model: "opus",
        }),
    ),
  );
  return {
    round: "first",
    question: panel.question,
    docs: panel.docs,
    seats: panel.seats,
    positions: panel.seats.flatMap((seat, i) =>
      answers[i] ? [{ seat: seat.name, ...firstAnswer(answers[i]) }] : [],
    ),
  };
}

const revisionPrompt = (own) => `${briefing(lensOf(own.seat))}

This is the panel's one deliberation round. Every panelist first answered on its own, and the panelists did not converge. Your first answer was:
${JSON.stringify(firstAnswer(own), null, 1)}

The other panelists' first answers, each with the lens it was weighed through:
${JSON.stringify(
  panel.positions
    .filter((other) => other.seat !== own.seat)
    .map((other) => ({ lens: lensOf(other.seat), ...firstAnswer(other) })),
  null,
  1,
)}

Reconsider once, still through your own lens. Keep your position where their answers do not move you and revise it where one does; do not split the difference between positions. This is your last answer on the question.

${requiredKeysClause(REVISED_SCHEMA)}`;

const revisions = await parallel(
  panel.positions.map(
    (own) => () =>
      agent(revisionPrompt(own), {
        label: `panelist: ${own.seat} (deliberation)`,
        phase: "Deliberate",
        schema: REVISED_SCHEMA,
        model: "opus",
      }),
  ),
);

return {
  round: "deliberation",
  note: DELIBERATION_NOTE,
  question: panel.question,
  docs: panel.docs,
  seats: panel.seats,
  panelists: panel.positions.map((own, i) => ({
    seat: own.seat,
    first: firstAnswer(own),
    revised: revisions[i] ?? null,
  })),
};
