import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/bench/")({
  beforeLoad: () => {
    // hash: true keeps the current location's fragment through the redirect
    // (router buildLocation reads currentLocation.hash), so the fragment stays
    // out of the server request and out of logs.
    throw redirect({ to: "/", hash: true, replace: true });
  },
});
