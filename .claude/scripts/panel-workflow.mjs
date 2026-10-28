// Workflow script for /panel, invoked as
// Workflow({scriptPath: '.claude/scripts/panel-workflow.mjs', args: {...}}).
//
// It is a Workflow script BODY, not a module: the harness injects `args`,
// `agent`, and `parallel`, and takes the top-level `return` as the run's result.
// No ES module parser accepts a top-level return, which is why eslint.config.mjs
// excludes this file; .claude/scripts/panel-script.test.mjs compiles it as a
// function body and drives it.
//
// It is also the briefing a deliberating panel's first round reads:
// panel-relay.mjs runs this body with an `agent` that only records each
// prompt, so the chair's panelists get the same text this script's do.

export const meta = {
  name: "panel",
  description:
    "Independent schema-forced panelists on one design question, one round",
  phases: [{ title: "Panel" }],
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

// The seats a caller may name. A caller may instead state a lens of its own as
// {name, lens}; a call that names no seats is refused.
const SEATS = {
  "failure-modes": "correctness and failure modes",
  architecture: "architecture and maintenance cost",
  pragmatics: "operational and cost pragmatics",
  "design-ux":
    "design and user experience -- the user-facing flows, the states a user can reach, the copy, and what the operator sees and does at each step",
};

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
  if (!Array.isArray(seats) || seats.length < 2) {
    throw new Error(
      `seats is a list of at least two seats, each chosen for a dimension of the question, with no default; got ${JSON.stringify(seats)}.`,
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

// The clean checkout the panelists read, made by the caller under a fresh
// `mktemp -d` directory so two panels in flight never share one.
function resolveBase(base) {
  if (!isText(base) || !base.startsWith("/") || base.endsWith("/")) {
    throw new Error(
      `base is the absolute path of the panel's clean checkout, with no trailing slash; got ${JSON.stringify(base)}.`,
    );
  }
  return base;
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

const input = resolveWorkflowArgs(args);

if (!isText(input.question)) {
  throw new Error("question is the non-empty text of the panel's question.");
}
const panel = {
  question: input.question,
  base: resolveBase(input.base),
  docs: resolveDocs(input.docs),
  seats: resolveSeats(input.seats),
};

const docsClause = panel.docs.length
  ? `Read these first for context: ${panel.docs.map((d) => `${panel.base}/${d}`).join(", ")}.\n\n`
  : "";

const requiredKeysClause = (schema) =>
  `Your structured result must have every one of these top-level keys: ${schema.required.map((key) => `\`${key}\``).join(", ")}.`;

const briefing = (
  lens,
) => `You are an independent expert panelist. Read ONLY under ${panel.base}, a clean checkout of the project's mainline: do not read, cd into, or search /workspace, and do not run builds or tests (the tree has no node_modules). You are one of several panelists and must not coordinate; answer from your own read.

${docsClause}Weigh the question primarily through this lens: ${lens}. Then answer it directly -- an answer, not a survey of options.

The question:
${panel.question}`;

const answers = await parallel(
  panel.seats.map(
    (seat) => () =>
      agent(`${briefing(seat.lens)}\n\n${requiredKeysClause(SCHEMA)}`, {
        label: `panelist: ${seat.name}`,
        phase: "Panel",
        schema: SCHEMA,
        model: "opus",
        effort: "high",
      }),
  ),
);
return {
  round: "first",
  question: panel.question,
  base: panel.base,
  docs: panel.docs,
  seats: panel.seats,
  positions: panel.seats.flatMap((seat, i) =>
    answers[i] ? [{ seat: seat.name, ...firstAnswer(answers[i]) }] : [],
  ),
};
