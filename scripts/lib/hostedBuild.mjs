// Where the hosted web build lands: check-deploy-trigger-graph.mjs builds and
// reads it, and run-checks.mjs clears it before a check that builds it runs.

/** The build output the deploy uploads. */
export const BUILD_OUTPUT = "apps/web/dist/hosted";
