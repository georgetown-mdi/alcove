/**
 * The rule for the build variables naming a default relay,
 * `VITE_DEFAULT_RELAY_TURN_URL`, `VITE_DEFAULT_RELAY_REGISTRAR_URL`,
 * `VITE_DEFAULT_RELAY_WEBSOCKET_URL` and `VITE_DEFAULT_RELAY_MODE`, shared by
 * the client's configuration (`./clientConfig.ts`) and the build's own refusal
 * (`vite.config.ts`), so a value the page would refuse at load also stops the
 * build.
 */

import {
  RelayRegistrarSchema,
  TurnUrlSchema,
  webSocketRelayUrlSchema,
} from "@alcove/core";

/** The default relay a build names, read from its build variables. */
export interface DefaultRelaySetting {
  turnUrl: string;
  registrarUrl: string;
  /**
   * The `wss://` url of the default WebSocket relay, which reads the key
   * table the registrar enrolls into; absent when the build names none.
   */
  websocketUrl?: string;
}

/**
 * How a build offers its default relay (`VITE_DEFAULT_RELAY_MODE`): `opt-in`,
 * the default, switched off until this browser's user turns it on; `on`, in
 * every browser exchange.
 */
export type DefaultRelayMode = "opt-in" | "on";

/** One refused default relay variable, by its unprefixed name. */
export interface DefaultRelayConfigProblem {
  variable:
    | "DEFAULT_RELAY_TURN_URL"
    | "DEFAULT_RELAY_REGISTRAR_URL"
    | "DEFAULT_RELAY_WEBSOCKET_URL"
    | "DEFAULT_RELAY_MODE";
  message: string;
}

/**
 * The mode the trimmed `VITE_DEFAULT_RELAY_MODE` names, `opt-in` where it is
 * blank, or `undefined` where it names no mode.
 */
export function defaultRelayModeOf(
  value: string,
): DefaultRelayMode | undefined {
  if (value === "" || value === "opt-in") return "opt-in";
  return value === "on" ? "on" : undefined;
}

const PAIRING =
  "set both VITE_DEFAULT_RELAY_TURN_URL and VITE_DEFAULT_RELAY_REGISTRAR_URL, " +
  "or neither";

const WebSocketUrlSchema = webSocketRelayUrlSchema(
  "VITE_DEFAULT_RELAY_WEBSOCKET_URL",
);

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
 * What is wrong with the trimmed values, empty when nothing is: each set
 * value must be one `turn:` / `turns:` url, an `https://` url naming only a
 * host and an optional port, and a `wss://` url; the first two are set
 * together or not at all, and the third only beside them, since the
 * WebSocket relay admits only the keys that registrar enrolls. The mode, set
 * or not, must be `opt-in` or `on`.
 */
export function defaultRelayConfigProblems(
  turnUrl: string,
  registrarUrl: string,
  websocketUrl = "",
  mode = "",
): Array<DefaultRelayConfigProblem> {
  const problems: Array<DefaultRelayConfigProblem> = [];
  if (defaultRelayModeOf(mode) === undefined)
    problems.push({
      variable: "DEFAULT_RELAY_MODE",
      message: "must be opt-in or on",
    });
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
  if (websocketUrl !== "") {
    if (!WebSocketUrlSchema.safeParse(websocketUrl).success)
      problems.push({
        variable: "DEFAULT_RELAY_WEBSOCKET_URL",
        message:
          "must be one wss:// url naming a host, an optional port and the " +
          "relay's path, with no user, query or fragment, for example " +
          "wss://relay.example.org/relay",
      });
    if (turnUrl === "" || registrarUrl === "")
      problems.push({
        variable: "DEFAULT_RELAY_WEBSOCKET_URL",
        message:
          "is set without the default relay; set it only beside " +
          "VITE_DEFAULT_RELAY_TURN_URL and VITE_DEFAULT_RELAY_REGISTRAR_URL",
      });
  }
  return problems;
}
