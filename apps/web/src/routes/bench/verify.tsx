import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/bench/verify")({
  beforeLoad: () => {
    throw redirect({ to: "/verify", hash: true, replace: true });
  },
});
