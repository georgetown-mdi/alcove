import { envSchema } from "env-schema";

import type { EnvSchemaOpt, JSONSchemaType } from "env-schema";

import type { LogLevel } from "loglevel";

interface Env {
  PORT: number;
  LOG_LEVEL: keyof LogLevel;
}

const schema: JSONSchemaType<Env> = {
  type: "object",
  required: ["PORT"],
  properties: {
    PORT: {
      type: "number",
      default: 3000,
    },
    LOG_LEVEL: {
      type: "string",
      default: "INFO",
    },
  },
};

/** The server's environment settings, read from the environment at each call. */
export function loadServerConfig(configOptions: EnvSchemaOpt<Env> = {}): Env {
  return envSchema({
    ...configOptions,
    schema: configOptions.schema ?? schema,
  });
}
