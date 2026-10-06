---
title: "The Web Server's Runtime Role"
---

# The web server's runtime role, and how much framework it needs

_Status: the end state below is reached for the public deployment. Its web app
is a static site with no server of its own, the peer-coordination broker runs as
a service of its own, and the framework's server half -- TanStack Start and its
Nitro build -- is removed. The console profile of the same app is the standing
exception -- its server drives the CLI -- and is recorded here beside it. The
app's own runtime description is in [DESIGN.md](../DESIGN.md#web-application).
See [docs/notes/README.md](README.md)._

## What the public deployment runs

In the public deployment, a web exchange is conducted entirely between the two
browsers. Files are read, the linkage keys derived, the authenticated key
exchange run, and the PSI frames sent peer to peer over WebRTC; nothing leaves
the machine except that exchange's own traffic. What the deployment serves is
the code that does it, as a static site
([hosted-static-build.md](hosted-static-build.md)).

The one runtime service an exchange needs from outside the two browsers is the
peer-coordination (PeerJS) broker, which introduces them to each other and sees
no exchange content -- the rendezvous ids derive from the invitation secret, and
the data channel is confidential against it under DTLS
([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#channel-security)). It is not part of
the web app's deployment: a page dials the broker the build names
([DEPLOYMENT.md](../DEPLOYMENT.md#coordination-server)), and where that
broker runs is recorded in
[webrtc-relay-deployment.md](webrtc-relay-deployment.md).

## The console profile, where the server does run an exchange

The same application also builds as the console -- one party's own machine,
one operator, one exchange at a time -- and there the server's runtime role is a
larger one: it drives that party's `alcove` CLI as a subprocess. The job
API is what does it (`apps/web/server/console/routes/`, specified in
[SERVER_JOB_API.md](../spec/SERVER_JOB_API.md)). A create request composes the
CLI's inputs from a typed intent, the server spawns the run, owns a workdir on
disk, relays the CLI's event stream to the page, and serves the result, the
exchange record and keys, a receipt, and the recurring-run hand-off back from
that workdir. That is file handling, subprocess supervision, and on-disk state
-- none of which the public deployment does.

Which channel goes there is the profile's decision rather than the API's. On a
console build a filedrop or SFTP exchange runs as a server job, while a WebRTC
exchange still runs in the tab exactly as it does on the hosted build
(`apps/web/src/psi/exchangeDriverSelection.ts`). The console does not move the
browser-to-browser exchange onto the server; it adds the channels a browser
cannot open a socket for.

The two profiles do not blur. The job API is dark unless the build is a console
build (`VITE_DEPLOYMENT_PROFILE=console`) and a data root is configured
(`apps/web/src/jobs/gate.ts`), and the public deployment has no server to serve
it from. The single-operator trust boundary the API's design rests on is the
console's alone
([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#single-party-console-trust-boundary)).

## The framework that remains

TanStack entered `apps/web` as a full-stack solution, on the expectation that
the server would take part in coordinating an exchange. It did not: the
protocol is peer to peer, and the coordination that remains is the broker's,
which is a workspace of its own (`packages/peerjs-broker`) with an entry point
that runs it as a standalone service. With the broker gone from the web app's
deployment, the framework's server half had nothing left to do but deliver an
app shell, which a static host delivers as well.

What remains is the client half: the router, form, and query libraries, which
the static site and the console both serve. The router's build-time codegen is
a coupling of the app's own route layer
([apps/web/README.md](../../apps/web/README.md#generated-route-tree)), and
whether to keep these libraries has not been decided.

## The standing constraint

New server-side work in `apps/web` does not deepen framework-specific coupling
where a framework-neutral shape costs the same. That is a tie-breaker, not a
prohibition: it asks for no abstraction layer, no migration, and no work bought
solely to keep an option open.

The console server is what that constraint governs. Its machinery is a set of
plain modules under `apps/web/src/jobs/` that import nothing from the framework
-- the job manager, the CLI driver, the gate, the workdir and the event relay --
and the modules under `apps/web/server/console/routes/` are the adapters that
mount them on the console server's own route table
(`apps/web/server/console/routeTable.ts`), which imports nothing from the
framework either. That is why removing the framework's server half left the
console server unchanged.

## The end state

The public deployment's exchange runs in the browser; its host delivers code
and nothing else, and the broker it dials runs on its own. That end state is the
public deployment's only: the console's server runs the CLI whatever becomes of
the broker, so the same codebase keeps a build whose server has a real runtime
job.

## A second-order consequence

The `crossws` peer conflict that blocked the release SBOM originated entirely in
the framework's server stack, and it went with it: the release step runs
`npm sbom` with no workaround flag
([RELEASES.md](../RELEASES.md#9-generate-and-attach-the-sbom)), and what that
command still omits is recorded in
[DEPENDENCY_PINS.md](../spec/DEPENDENCY_PINS.md#the-release-sboms-hoisting-residual).
