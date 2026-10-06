/** The environment variable naming the loopback port of the standalone
 * signaling broker the dev server's `/api/` proxy forwards to. Set by
 * scripts/dev.mjs and the test dev-server setup; read by vite.config.ts. */
export const DEV_SIGNALING_PORT_ENV = "ALCOVE_DEV_SIGNALING_PORT";
