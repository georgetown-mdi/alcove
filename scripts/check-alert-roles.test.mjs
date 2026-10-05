import { describe, expect, it } from "vitest";

import { parseFile, sourceModules } from "./lib/typeScriptSources.mjs";
import {
  QUIET_ERROR_ALERTS,
  ROLE_HELPER,
  WEB_SOURCE_DIR,
  alertRoleFailures,
  errorAlertsInSource,
  errorAlerts,
  exportsFunction,
} from "./check-alert-roles.mjs";

const FILE = "apps/web/src/fixture.tsx";

const problemsIn = (jsx) =>
  errorAlertsInSource(
    FILE,
    `export function Shown({ color }: { color: string }) { return ${jsx}; }`,
  ).map(({ problem }) => problem);

describe("errorAlerts", () => {
  it("passes a red Alert set to alert or status", () => {
    expect(problemsIn(`<Alert color="red" role="alert" title="x" />`)).toEqual([
      undefined,
    ]);
    expect(problemsIn(`<Alert color="red" role="status" title="x" />`)).toEqual(
      [undefined],
    );
  });

  it("reports a red Alert that sets no role", () => {
    expect(problemsIn(`<Alert color="red" title="x">Failed</Alert>`)).toEqual([
      "sets no role",
    ]);
  });

  it("reports a red Alert set to a role that is not announced", () => {
    expect(
      problemsIn(`<Alert color="red" role="presentation" title="x" />`),
    ).toEqual(['sets role="presentation"']);
    expect(problemsIn(`<Alert role="note" color={"red"} title="x" />`)).toEqual(
      ['sets role="note"'],
    );
  });

  it("passes alertRoleFor given the Alert's own runtime color", () => {
    expect(
      problemsIn(`<Alert color={color} role={alertRoleFor(color)} />`),
    ).toEqual([undefined]);
    expect(
      problemsIn(`<Alert color="red" role={alertRoleFor("red")} />`),
    ).toEqual([undefined]);
  });

  it("reports a runtime color with no role, or alertRoleFor of another color", () => {
    expect(problemsIn(`<Alert color={color} title="x" />`)).toEqual([
      "sets no role",
    ]);
    expect(
      problemsIn(`<Alert color={color} role={alertRoleFor("yellow")} />`),
    ).toEqual(['passes "yellow" to alertRoleFor but its color is color']);
  });

  it("passes over an Alert of a literal color other than red, or none", () => {
    expect(
      problemsIn(
        `<><Alert color="yellow" role="presentation" /><Alert title="x" /></>`,
      ),
    ).toEqual([]);
  });

  it("reports a spread that could hold the color or role", () => {
    expect(problemsIn(`<Alert {...props} title="x" />`)).toEqual([
      "spreads props, so its color and role cannot be read",
    ]);
    expect(
      problemsIn(`<Alert {...props} color="red" role="alert" title="x" />`),
    ).toEqual([undefined]);
  });

  it("does not read an Alert in a comment or a string", () => {
    expect(
      problemsIn(
        `(<p>{/* <Alert color="red" /> */}{'<Alert color="red" />'}</p>)`,
      ),
    ).toEqual([]);
  });

  it("names the enclosing component and the title as written", () => {
    expect(
      errorAlertsInSource(
        FILE,
        `const Card = () => <Alert color="red" title={REFUSED} />;`,
      ),
    ).toEqual([
      {
        line: 1,
        component: "Card",
        title: "{REFUSED}",
        problem: "sets no role",
      },
    ]);
  });
});

describe("alertRoleFailures", () => {
  const quiet = errorAlertsInSource(
    FILE,
    `function Verdict() { return <Alert color="red" role="presentation" title={verdict.title} />; }`,
  );
  const entry = {
    file: FILE,
    component: "Verdict",
    title: "{verdict.title}",
    reason: "a polite region below voices it",
  };

  it("excuses a site its exception entry names", () => {
    expect(alertRoleFailures([{ file: FILE, alerts: quiet }], [entry])).toEqual(
      [],
    );
  });

  it("reports the site without the entry, and the entry without the site", () => {
    const [unexcused] = alertRoleFailures([{ file: FILE, alerts: quiet }], []);
    expect(unexcused).toMatch(
      /fixture\.tsx:1: the red Alert titled \{verdict\.title\} in Verdict sets role="presentation"/,
    );
    const [stale] = alertRoleFailures([{ file: FILE, alerts: [] }], [entry]);
    expect(stale).toMatch(/QUIET_ERROR_ALERTS names .* Verdict/);
  });
});

describe("the web source tree", () => {
  it("has every red Alert announced or documented as quiet", () => {
    const scanned = sourceModules(WEB_SOURCE_DIR)
      .filter((file) => file.endsWith(".tsx"))
      .map((file) => ({ file, alerts: errorAlerts(parseFile(file)) }));
    expect(scanned.some(({ alerts }) => alerts.length > 0)).toBe(true);
    expect(alertRoleFailures(scanned)).toEqual([]);
    expect(QUIET_ERROR_ALERTS.length).toBeGreaterThan(0);
  });

  it("still exports the role helper the check accepts by name", () => {
    expect(exportsFunction(parseFile(ROLE_HELPER.file), ROLE_HELPER.name)).toBe(
      true,
    );
  });
});
