/**
 * The rule for the two build variables naming a default relay,
 * `VITE_DEFAULT_RELAY_TURN_URL` and `VITE_DEFAULT_RELAY_REGISTRAR_URL`, shared
 * by the client's configuration (`./clientConfig.ts`) and the build's own
 * refusal (`vite.config.ts`), so a value the page would refuse at load also
 * stops the build.
 */

import { RelayRegistrarSchema, TurnUrlSchema } from "@alcove/core";

/** The default relay a build names, read from its two build variables. */
export interface DefaultRelaySetting {
  turnUrl: string;
  registrarUrl: string;
}

/** One refused default relay variable, by its unprefixed name. */
export interface DefaultRelayConfigProblem {
  variable: "DEFAULT_RELAY_TURN_URL" | "DEFAULT_RELAY_REGISTRAR_URL";
  message: string;
}

const PAIRING =
  "set both VITE_DEFAULT_RELAY_TURN_URL and VITE_DEFAULT_RELAY_REGISTRAR_URL, " +
  "or neither";

/**
 * The trimmed registrar build variable as the origin core's registrar rule
 * parses it to, or `""` when the value is unset or the rule refuses it.
 */
export function defaultRelayRegistrarOrigin(registrarUrl: string): string {
  if (registrarUrl === "") return "";
  // The registrar schema checks a url beside an exchange id; the id here is a
  // placeholder, since each run derives its own.
  const parsed = RelayRegistrarSchema.safeParse({
    url: registrarUrl,
    exchangeId: "default-relay",
  });
  return parsed.success ? parsed.data.url : "";
}

/**
 * What is wrong with the two trimmed values, empty when nothing is: each set
 * value must be one `turn:` / `turns:` url and an `https://` url naming only a
 * host and an optional port, and the two are set together or not at all.
 */
export function defaultRelayConfigProblems(
  turnUrl: string,
  registrarUrl: string,
): Array<DefaultRelayConfigProblem> {
  const problems: Array<DefaultRelayConfigProblem> = [];
  if (turnUrl !== "" && !TurnUrlSchema.safeParse(turnUrl).success)
    problems.push({
      variable: "DEFAULT_RELAY_TURN_URL",
      message: "must be one turn: or turns: url",
    });
  if (registrarUrl !== "" && defaultRelayRegistrarOrigin(registrarUrl) === "")
    problems.push({
      variable: "DEFAULT_RELAY_REGISTRAR_URL",
      message:
        "must be an https:// url naming only a host and an optional port " +
        "from 1 to 65535, for example https://registrar.example.org",
    });
  if ((turnUrl === "") !== (registrarUrl === ""))
    problems.push({
      variable:
        turnUrl === ""
          ? "DEFAULT_RELAY_TURN_URL"
          : "DEFAULT_RELAY_REGISTRAR_URL",
      message: `is not set; ${PAIRING}`,
    });
  return problems;
}
