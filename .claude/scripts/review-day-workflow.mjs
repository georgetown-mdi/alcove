// Workflow script for the review day, invoked once per workflow of slices as
// Workflow({scriptPath: '<repo>/.claude/scripts/review-day-workflow.mjs',
// args: {day, wf, jobs: [{id, lens}]}}).
//
// It is a Workflow script BODY, not a module: the harness injects `args`,
// `agent`, and `pipeline`, and takes the top-level `return` as the run's
// result. eslint.config.mjs excludes it for that reason, and
// .claude/scripts/review-day-script.test.mjs compiles it as a function body.

export const meta = {
  name: "review-day",
  description:
    "Review the slices of one review-day workflow by lens, verify each slice that has findings, then triage the workflow",
  phases: [
    {
      title: "Review",
      detail: "one Opus reviewer per slice, writes its findings file",
    },
    {
      title: "Verify",
      detail:
        "one verifier per slice with findings (Opus for lens 2, Sonnet otherwise)",
    },
    { title: "Triage", detail: "one Opus triage agent over the workflow" },
  ],
};

const REVIEW_SCHEMA = {
  type: "object",
  required: ["file", "total", "majorOrWorse", "blocked"],
  properties: {
    file: { type: "string" },
    total: { type: "number" },
    majorOrWorse: { type: "number" },
    blocked: { type: "string" },
  },
};
const VERIFY_SCHEMA = {
  type: "object",
  required: [
    "file",
    "confirmed",
    "narrowed",
    "refuted",
    "unverifiable",
    "blocked",
  ],
  properties: {
    file: { type: "string" },
    confirmed: { type: "number" },
    narrowed: { type: "number" },
    refuted: { type: "number" },
    unverifiable: { type: "number" },
    blocked: { type: "string" },
  },
};
const TRIAGE_SCHEMA = {
  type: "object",
  required: ["file", "summary"],
  properties: {
    file: { type: "string" },
    summary: {
      type: "string",
      description:
        "at most about 600 tokens: counts by disposition, batches (name, size, security or not), docket entries one line each, targeted-pass list",
    },
  },
};

// The harness may hand a script its arguments as JSON text rather than as the
// object the caller passed; any other delivery has no named field. Resolving
// fails closed on it, and `npm run check:workflow-args-resolve` holds every
// read of `args` to the one call below.
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

const input = resolveWorkflowArgs(args);

const isText = (value) => typeof value === "string" && value.trim().length > 0;

// Absolute because every agent writes under it, and an agent's working
// directory is not the caller's.
if (!isText(input.day) || !input.day.trim().startsWith("/")) {
  throw new Error(
    `day must be the absolute path of the review day's directory; got ${JSON.stringify(input.day)}.`,
  );
}
if (!isText(input.wf)) {
  throw new Error(
    `wf must name the workflow, such as "W1"; got ${JSON.stringify(input.wf)}.`,
  );
}
if (!Array.isArray(input.jobs) || input.jobs.length === 0) {
  throw new Error(
    `jobs must be a non-empty array of {id, lens} slices; got ${JSON.stringify(input.jobs)}.`,
  );
}
const LENSES = [1, 2, 3, 4];
const jobs = input.jobs.map((job) => {
  if (job === null || typeof job !== "object" || !isText(job.id)) {
    throw new Error(
      `every job needs a non-empty string id; got ${JSON.stringify(job)}.`,
    );
  }
  if (!LENSES.includes(job.lens)) {
    throw new Error(
      `job ${job.id} needs a lens of 1, 2, 3 or 4; got ${JSON.stringify(job.lens)}.`,
    );
  }
  return { id: job.id.trim(), lens: job.lens };
});
// Results are matched to their slice by id, and each slice writes a file named
// for it, so two slices sharing an id would overwrite each other.
const repeated = jobs.find(
  (job, index) => jobs.findIndex((other) => other.id === job.id) !== index,
);
if (repeated) {
  throw new Error(`job id ${repeated.id} appears more than once.`);
}

const day = input.day.trim().replace(/\/+$/, "");
const wf = input.wf.trim();
const W = `${day}/${wf}`;

const BRIEFS = ".claude/review-day";

const requiredKeysClause = (schema) =>
  `Your structured result must have every one of these top-level keys: ${schema.required.map((key) => `\`${key}\``).join(", ")}.`;

const reviewPrompt = (job) =>
  `Review day, slice ${job.id}, lens ${job.lens}. The day directory is ${day}. Read ${BRIEFS}/reviewer-brief.md in the repository (its Shared section in full, then Lens ${job.lens}) and the ${job.id} entry in ${day}/SLICES.md, and follow them. Finding prefix: ${job.id}. Write your one output file to ${W}/${job.id}.md. Run every command in the foreground. Return your file path, the total number of findings, the number at major or above, and anything that blocked you (empty string if nothing).

${requiredKeysClause(REVIEW_SCHEMA)}`;

const verifyPrompt = (job) =>
  `Review day: verify the findings in ${W}/${job.id}.md, raised under lens ${job.lens}. The day directory is ${day}. Read ${BRIEFS}/verifier-brief.md in the repository first and follow it. Write your one output file to ${W}/${job.id}.verify.md. Run every command in the foreground. Return your file path, the count of each verdict, and anything that blocked you (empty string if nothing).

${requiredKeysClause(VERIFY_SCHEMA)}`;

const review = (job) =>
  agent(reviewPrompt(job), {
    label: `review:${job.id}`,
    phase: "Review",
    schema: REVIEW_SCHEMA,
    model: "opus",
    effort: "high",
  });

// A slice whose reviewer returned nothing has no findings file to verify, and
// one with no findings has nothing to verify; neither seats a verifier.
const verify = (reviewed, job) => {
  if (!reviewed) return null;
  if (reviewed.total === 0) {
    return {
      file: "",
      confirmed: 0,
      narrowed: 0,
      refuted: 0,
      unverifiable: 0,
      blocked: "no findings",
    };
  }
  return job.lens === 2
    ? agent(verifyPrompt(job), {
        label: `verify:${job.id}`,
        phase: "Verify",
        schema: VERIFY_SCHEMA,
        model: "opus",
        effort: "high",
      })
    : agent(verifyPrompt(job), {
        label: `verify:${job.id}`,
        phase: "Verify",
        schema: VERIFY_SCHEMA,
        model: "sonnet",
        effort: "high",
      });
};

const perSlice = await pipeline(
  jobs,
  (job) => review(job),
  async (reviewed, job) => ({
    id: job.id,
    review: reviewed,
    verify: await verify(reviewed, job),
  }),
);

const slices = jobs.map((job) => {
  const done = perSlice.find((entry) => entry && entry.id === job.id);
  return {
    id: job.id,
    lens: job.lens,
    review: done ? done.review : null,
    verify: done ? done.verify : null,
  };
});

const sliceList = jobs.map((job) => `${job.id} (lens ${job.lens})`).join(", ");
const triage = await agent(
  `Triage workflow ${wf} of the review day. The day directory is ${day}; $W = ${W}. Slices: ${sliceList}. Findings files are $W/<slice>.md and verdict files $W/<slice>.verify.md (a slice with no findings has no verdict file). Read ${BRIEFS}/triage-brief.md in the repository and follow it. Run every command in the foreground. Return the TRIAGE.md path and a summary of at most about 600 tokens.

${requiredKeysClause(TRIAGE_SCHEMA)}`,
  {
    label: `triage:${wf}`,
    phase: "Triage",
    schema: TRIAGE_SCHEMA,
    model: "opus",
    effort: "high",
  },
);

return { day, wf, slices, triage };
