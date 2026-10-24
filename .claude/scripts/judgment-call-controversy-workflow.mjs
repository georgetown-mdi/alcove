// Workflow script for /docket's judgment-call scoring, invoked as
// Workflow({scriptPath: '<repo>/.claude/scripts/judgment-call-controversy-workflow.mjs', args: {...}}).
//
// It is a Workflow script BODY, not a module: the harness injects `args`,
// `agent`, `parallel`, and `pipeline`, and takes the top-level `return` as the
// run's result. No ES module parser accepts a top-level return, which is why
// eslint.config.mjs excludes this file;
// .claude/scripts/judgment-call-controversy-script.test.mjs compiles it as a
// function body and drives it.

export const meta = {
  name: "judgment-call-controversy",
  description:
    "Gather the judgment calls each session took since the last docket, and have two independent lenses judge each one and each line of the session's own closing list for controversy",
  phases: [
    {
      title: "Gather",
      detail: "one Sonnet gatherer per session lists its judgment calls",
    },
    {
      title: "Judge",
      detail:
        "two independent Opus lenses judge each session's calls and the closing list",
    },
  ],
};

const CALLS_SCHEMA = {
  type: "object",
  properties: {
    calls: {
      type: "array",
      description:
        "Every judgment call found for this session; empty array when none.",
      items: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Session letter plus a number, e.g. A3.",
          },
          pr: {
            type: "string",
            description:
              'The PR number, e.g. #2365, or several; "none" for a call tied to no PR.',
          },
          decided: {
            type: "string",
            description: "One plain sentence: what was decided.",
          },
          alternative: {
            type: "string",
            description: "One sentence: the main alternative not taken.",
          },
          userEffect: {
            type: "string",
            description: "One sentence: who it affects and how.",
          },
          source: {
            type: "string",
            description:
              "Where it is stated: PR body section, or file path and phrase.",
          },
        },
        required: [
          "id",
          "pr",
          "decided",
          "alternative",
          "userEffect",
          "source",
        ],
      },
    },
    excludedAsRuled: {
      type: "array",
      description:
        "Choices found that the owner explicitly ruled, one short line each with the ruling cited; empty array when none.",
      items: { type: "string" },
    },
    skippedPrs: {
      type: "array",
      description:
        "PRs skipped as test-only, tooling, dependency bumps or board bookkeeping; empty array when none.",
      items: { type: "string" },
    },
  },
  required: ["calls", "excludedAsRuled", "skippedPrs"],
};

const VERDICTS_SCHEMA = {
  type: "object",
  properties: {
    verdicts: {
      type: "array",
      description: "One verdict per call id you were given, every id included.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          verdict: {
            type: "string",
            enum: ["uncontroversial", "worth-a-look", "controversial"],
          },
          reason: {
            type: "string",
            description: "Two or three sentences, plain language.",
          },
          evidence: {
            type: "string",
            description:
              "The file, ruling, principle or measurement the reason rests on.",
          },
          betterChoice: {
            type: "string",
            description:
              'The choice you would make instead, or "none" when the call stands.',
          },
        },
        required: ["id", "verdict", "reason", "evidence", "betterChoice"],
      },
    },
  },
  required: ["verdicts"],
};

const LENSES = [
  {
    key: "product",
    text: "product and user experience: the owner's product principles (no invented numbers, ship the whole feature, no machinery nobody asked for, warn-and-guide for the operator's own choices), what each user sees and can do, plain copy, and whether a choice adds friction or removes a capability someone needs.",
  },
  {
    key: "trust",
    text: "security, privacy and correctness: what is disclosed and to whom, whether copy or docs state a guarantee the code does not keep, partner-delivered input (where a hard refusal is right), cross-party agreement, compatibility with deployed builds, and consistency with standing rulings and the spec.",
  },
];

const SCORE = { uncontroversial: 0, "worth-a-look": 1, controversial: 2 };

const CLOSING_KEY = "CL";

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

function resolveTextList(value, what) {
  if (!Array.isArray(value) || !value.every(isText)) {
    throw new Error(
      `${what} is a list of non-empty strings; got ${JSON.stringify(value)}.`,
    );
  }
  return value.map((entry) => entry.trim());
}

// A, B, ..., Z, AA, AB, ...: the letter a session's call ids start with.
function sessionKey(index) {
  let key = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    key = String.fromCharCode(65 + ((n - 1) % 26)) + key;
  }
  return key;
}

function resolveSession(session, index) {
  if (!isObject(session) || !isText(session.name)) {
    throw new Error(
      `A session is {"name": ..., "prs": [...], "sources": [...], "notes": ...} with a non-empty name; got ${JSON.stringify(session)}.`,
    );
  }
  const name = session.name.trim();
  const prs = resolveTextList(session.prs, `The prs of session "${name}"`);
  const sources = resolveTextList(
    session.sources,
    `The sources of session "${name}"`,
  );
  if (prs.length === 0 && sources.length === 0) {
    throw new Error(
      `Session "${name}" names no pull request and no source file, so its gatherer would have nothing to read.`,
    );
  }
  if (session.notes !== undefined && typeof session.notes !== "string") {
    throw new Error(
      `The notes of session "${name}" are text; got ${JSON.stringify(session.notes)}.`,
    );
  }
  return {
    key: sessionKey(index),
    name,
    prs,
    sources,
    notes: (session.notes ?? "").trim(),
  };
}

const input = resolveWorkflowArgs(args);

if (!isText(input.since)) {
  throw new Error(
    `since is the date and time of the last docket, as text; got ${JSON.stringify(input.since)}.`,
  );
}
const since = input.since.trim();

if (!Array.isArray(input.sessions)) {
  throw new Error(
    `sessions is the list of sessions that worked since the last docket, empty when none did; got ${JSON.stringify(input.sessions)}.`,
  );
}
const sessions = input.sessions.map(resolveSession);
const names = sessions.map((session) => session.name);
const repeated = names.find((name, i) => names.indexOf(name) !== i);
if (repeated !== undefined) {
  throw new Error(`The session "${repeated}" is named twice.`);
}

if (input.closingList === undefined) {
  throw new Error(
    "closingList is the session's own closing list, one line per ratification, and an empty list when it has none; it has no default.",
  );
}
const closingList = resolveTextList(input.closingList, "closingList");

if (sessions.length === 0 && closingList.length === 0) {
  throw new Error(
    "There is nothing to judge: sessions and closingList are both empty.",
  );
}

const requiredKeysClause = (schema) =>
  `Populate every property; empty array when none. Your structured result must have every one of these top-level keys: ${schema.required.map((key) => `\`${key}\``).join(", ")}.`;

const gatherPrompt = (
  session,
) => `Read-only task in the alcove repository (cwd: the primary checkout; read a tracked file as staging has it with \`git show origin/staging:<path>\`). Do not edit any file or board item.

Goal: list every JUDGMENT CALL the session "${session.name}" took since the last docket (${since}): ${session.prs.length ? `on these pull requests, ${session.prs.join(", ")}, and in the session's own work outside them` : "in the session's own work, as the files below record it"}. A call recorded before ${since} belongs to an earlier docket; leave it out.

A judgment call is a choice an agent or the orchestrating session made WITHOUT the owner's explicit ruling that changes what users, partners or operators get: behavior, defaults, copy that states a guarantee, refusals or warnings, scope included or deferred, data handling or disclosure, compatibility. NOT a judgment call: pure implementation detail with no user effect; a choice the owner ruled (a "Ruling", "owner ruled", "OWNER:" or verbatim owner quote in the PR body, the board item, or the session's files; check with \`node .claude/scripts/find-rulings.mjs <2-3 subject words>\` when unsure) -- list those under excludedAsRuled instead.

Sources, read all of them:
${session.prs.length ? `- Each PR body and title: \`gh pr view <N> --json title,body\`. Look for sections and phrases like "session calls", "judgment calls", "departures", "chose", "picked", "instead of", "not built", "deferred", "stated limit", "left out".\n` : ""}${session.sources.length ? `- These files, which record the session's work (host-local ones sit under scratch/): ${session.sources.join(", ")}. Search them for the PR numbers and for "SESSION CALLS", "judgment", "DEPARTURES", "settled", "decided", "implementer proposes", "session decision", "Session proposal".\n` : ""}${session.notes ? `${session.notes}\n` : ""}
Skip PRs that are test-only de-flakes, dependency bumps, agent tooling, or board/epic bookkeeping; list them under skippedPrs.

Be specific and faithful to the source; one call per choice; no more than 30 calls (if more, keep the ones with the largest user effect and say in the last call's source how many you left out). Ids: "${session.key}1", "${session.key}2", and so on.

${requiredKeysClause(CALLS_SCHEMA)}`;

const judgePrompt = (
  lens,
  calls,
  batch,
) => `Read-only task in the alcove repository (cwd: the primary checkout; read a tracked file as staging has it with \`git show origin/staging:<path>\`). Do not edit any file or board item.

You are one of several independent reviewers. Judge whether each judgment call below is CONTROVERSIAL: would a careful maintainer who holds the owner's standing principles likely have chosen differently, or want to have been asked? Your lens: ${lens}

Ground every verdict: read \`.claude/product-principles.md\` and the CLAUDE.md "Applications" section first; for each call read the code or doc it concerns at the current checkout, or for a pull request not merged yet its diff (\`gh pr diff <N>\`), and run \`node .claude/scripts/find-rulings.mjs <2-3 subject words>\` when a ruling may bear on it. A call that conforms to a standing ruling or a documented default is uncontroversial; a call that departs from one is at least worth-a-look, and you name the ruling in your reason. Prefer "uncontroversial" unless you can name the concrete user or product consequence and the better choice; use "controversial" only when you would argue for the other choice; "worth-a-look" when reasonable people could split.

Calls (${batch}):
${JSON.stringify(calls, null, 1)}

Return one verdict for every id.

${requiredKeysClause(VERDICTS_SCHEMA)}`;

const judge = (calls, batch, label) =>
  parallel(
    LENSES.map(
      (lens) => () =>
        agent(judgePrompt(lens.text, calls, batch), {
          label: `judge:${label}:${lens.key}`,
          phase: "Judge",
          schema: VERDICTS_SCHEMA,
          model: "opus",
          effort: "high",
        }).then((result) => ({
          lens: lens.key,
          verdicts: result ? result.verdicts : null,
        })),
    ),
  );

const problems = [];
const salvage =
  "its analysis usually survives in the rejected attempts: read subagents/workflows/<runId>/agent-<id>.jsonl for this run.";

// A line is left out only when every lens returned a verdict on it and every
// one is uncontroversial; a line a lens left unscored is presented.
const isStanding = (row) =>
  LENSES.every((lens) => row.verdicts[lens.key]?.verdict === "uncontroversial");

function score(calls, judged, batch) {
  if (calls.length === 0) return { presented: [], standing: [] };
  const verdictsByLens = {};
  for (const lens of LENSES) {
    const entry = (judged || []).find((j) => j && j.lens === lens.key);
    const verdicts =
      entry && Array.isArray(entry.verdicts) ? entry.verdicts : null;
    if (!verdicts) {
      problems.push(
        `${batch}: the ${lens.key} lens returned no structured result, so every line is presented; ${salvage}`,
      );
    }
    verdictsByLens[lens.key] = verdicts;
  }
  const rows = calls.map((call) => {
    const verdicts = {};
    for (const lens of LENSES) {
      const list = verdictsByLens[lens.key];
      verdicts[lens.key] =
        (list && list.find((v) => v && v.id === call.id)) || null;
    }
    const scored = Object.values(verdicts).filter(Boolean);
    return {
      ...call,
      score: scored.reduce((sum, v) => sum + (SCORE[v.verdict] ?? 0), 0),
      verdicts,
    };
  });
  for (const lens of LENSES) {
    if (!verdictsByLens[lens.key]) continue;
    const missing = rows
      .filter((row) => row.verdicts[lens.key] === null)
      .map((row) => row.id);
    if (missing.length > 0) {
      problems.push(
        `${batch}: the ${lens.key} lens returned no verdict for ${missing.join(", ")}, so those lines are presented.`,
      );
    }
  }
  return {
    presented: rows
      .filter((row) => !isStanding(row))
      .sort((a, b) => b.score - a.score),
    standing: rows.filter(isStanding),
  };
}

const gathered = sessions.length
  ? await pipeline(
      sessions,
      (session) =>
        agent(gatherPrompt(session), {
          label: `gather:${session.key}`,
          phase: "Gather",
          schema: CALLS_SCHEMA,
          model: "sonnet",
          effort: "medium",
        }),
      async (found, session) => ({
        key: session.key,
        found,
        judged:
          found && found.calls.length > 0
            ? await judge(found.calls, `session "${session.name}"`, session.key)
            : [],
      }),
    )
  : [];

const sessionResults = sessions.map((session) => {
  const batch = `Session "${session.name}"`;
  const result = gathered.find((entry) => entry && entry.key === session.key);
  const found = result && result.found;
  if (!found) {
    problems.push(
      `${batch}: the gatherer returned no structured result, so none of its calls were judged; ${salvage}`,
    );
    return {
      name: session.name,
      key: session.key,
      presented: [],
      standing: [],
      excludedAsRuled: [],
      skippedPrs: [],
    };
  }
  return {
    name: session.name,
    key: session.key,
    ...score(found.calls, result.judged, batch),
    excludedAsRuled: found.excludedAsRuled || [],
    skippedPrs: found.skippedPrs || [],
  };
});

const closingCalls = closingList.map((line, i) => ({
  id: `${CLOSING_KEY}${i + 1}`,
  line,
}));
const closingResult = closingCalls.length
  ? score(
      closingCalls,
      await judge(
        closingCalls,
        "the orchestrating session's own closing list: each line is a judgment it took and asks the owner to ratify",
        CLOSING_KEY,
      ),
      "The closing list",
    )
  : { presented: [], standing: [] };

const all = [...sessionResults, closingResult];
return {
  since,
  sessions: sessionResults,
  closingList: closingResult,
  counts: {
    judged: all.reduce(
      (sum, r) => sum + r.presented.length + r.standing.length,
      0,
    ),
    presented: all.reduce((sum, r) => sum + r.presented.length, 0),
    standing: all.reduce((sum, r) => sum + r.standing.length, 0),
    excludedAsRuled: sessionResults.reduce(
      (sum, r) => sum + r.excludedAsRuled.length,
      0,
    ),
  },
  problems,
};
