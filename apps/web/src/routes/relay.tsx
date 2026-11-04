import { createFileRoute, redirect } from "@tanstack/react-router";

// Kept so an earlier link to /relay still resolves: it opens a new invitation,
// whose Connection settings set the relays, on every build.
export const Route = createFileRoute("/relay")({
  beforeLoad: () => {
    throw redirect({ to: "/exchange", replace: true });
  },
});
