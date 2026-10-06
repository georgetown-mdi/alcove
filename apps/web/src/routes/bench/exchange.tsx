import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/bench/exchange")({
  beforeLoad: () => {
    throw redirect({ to: "/exchange", hash: true, replace: true });
  },
});
