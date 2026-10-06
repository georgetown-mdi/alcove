import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/bench/accept")({
  beforeLoad: () => {
    // hash: true keeps the current location's fragment (the token) unchanged
    // through the redirect to the primary /accept route.
    throw redirect({ to: "/accept", hash: true, replace: true });
  },
});
