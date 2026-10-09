---
title: "Privacy Statement"
review_owner: "Alcove maintainers"
last_reviewed: "2026-10-08"
---

# Privacy statement

Alcove is open-source software that lets two partner agencies find the records they have in common without revealing the records they do not share. This statement describes what the project itself collects, transmits, and retains, and what the supporting services an exchange relies on can observe. It is written for the agency security, compliance, and privacy reviewers who ask for a privacy policy by name.

**Owner:** the Alcove maintainers. See [Review and ownership](#review-and-ownership).

This is not a privacy notice for your agency's own data subjects, and it is not a Privacy Impact Assessment (PIA). A PIA is completed per deployment and turns on facts only the deploying agency holds -- the system owner, the authority for collection, the populations involved, and the retention schedule. This statement and [docs/COMPLIANCE.md](docs/COMPLIANCE.md) are the source material an agency uses to complete one.

## The project's role

- **Alcove is software you run, not a service run on your behalf.** The one exception is the hosted deployment of the web application, covered below.
- **The deploying agency is the sole controller of the data it processes.** The project is not a controller, processor, or business associate for that data. It never receives it.
- **The project collects, transmits, and retains no personal data on its own behalf**, in either deployment. There are no accounts, no registration, no license check, no update ping, no usage analytics, and no telemetry.
- **What the two parties disclose to each other is governed by their data sharing agreement**, not by this project. Alcove enforces the protocol; the agreement decides what may be exchanged under it.

The statements in this document about what Alcove connects to have a mechanical backstop: a repository check (`npm run check:egress-claims`) fails the build when the shipped source trees gain a URL literal naming a host under one of the schemes it reads -- `http`, `https`, and the STUN and TURN schemes -- outside a reviewed allowlist. A content delivery network, analytics snippet, or update ping added in that form is caught before it can falsify this document. The check is a backstop rather than a proof of no egress, and it is narrower than the claims it guards: a literal under another scheme (a `wss://` beacon), one added to build configuration outside the scanned trees, a host assembled at runtime, a URL an author spelled around the check by splitting or encoding it, and a connection made inside a dependency are all outside its reach. Its limits are in [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#egress-hardening-and-its-limits).

## Two deployments

The answers below differ by deployment. Read the section matching what you are deploying. The operational counterpart to this section -- who operates each part of a deployment, area by area -- is in [docs/SHARED_RESPONSIBILITY.md](docs/SHARED_RESPONSIBILITY.md).

### Container deployment (CLI and local console)

This is the deployment supported for production use.

- **What the project operates: nothing.** The container runs on your machine or in your infrastructure. No component of it reports to the project.
- **What it connects to:** only the SFTP server or shared directory you configure for the exchange, or for a WebRTC exchange the coordination server, STUN and TURN servers, and relay registrar its configuration names (see [What supporting services can observe](#what-supporting-services-can-observe)). One more request is made when you invite at a web app's address (`alcove invite https://...`): the CLI reads that app's public `/alcove.json` file, once, to learn which coordination server the app uses. The request sends nothing about the exchange; the app's host sees the request and your IP address, as for any page load. The container makes no other network connection.
- **The local console** is served by that same container to your own machine over loopback and is not reachable beyond that host. It is a local interface to the CLI, not a hosted service. It runs SFTP and shared-directory exchanges only, by starting the CLI in the container, so it connects to nothing beyond what the CLI connects to for those channels. It does not run browser-to-browser or other WebRTC exchanges.
- **What the project can observe about your exchanges: nothing.** It receives no data, no metadata, and no record that an exchange occurred.
- **Distribution is the one third-party touch.** Pulling the container image from a public registry tells that registry's operator that the pull happened, as with any container image. The project does not operate the registry and receives only whatever aggregate pull counts the registry publishes to image owners.

### Hosted web application

- **Status: evaluation and demonstration.** The hosted deployment is not recommended for production exchanges of real records. Use the container deployment for those.
- **Where data is handled: entirely in your browser.** Cloudflare Pages delivers the application code. Your input file is read, matched, and written locally and is never uploaded. This is a reviewed property of the codebase rather than a browser-enforced one; the limits of that claim against an injected script are stated in [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#egress-hardening-and-its-limits).
- **What the project operates, and what it can therefore observe** (verified 2026-10-07 on the Cloudflare account, the AWS account and the host):
  - **No server for the application's pages.** The pages are static files served by Cloudflare Pages with no server-side code, and the project keeps no log of page loads. Cloudflare's own records of those requests are covered below.
  - **The peer-coordination server** at `signal.data-bridge.org`, which brokers the browser-to-browser connection: it handles the derived rendezvous identifiers, connection timing, and client IP addresses. It relays opaque setup messages only and never sees data-channel content (see [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#channel-security)). It runs on a host of the project's own behind a TLS front the project also runs, and Cloudflare does not carry its traffic. The host is infrastructure from Amazon Web Services (AWS), a third party that hosts the server and its TLS front, can observe the host's network metadata, holds its disk, and sees no exchange content.
- **The project keeps one log: that host's system journal.** It stays on the host; nothing copies it elsewhere. Each entry is deleted within 91 days of being written: the host's configuration deletes archived journal files after 90 days and archives the active file daily. The journal also has a size limit, which can only delete entries sooner. It holds:
  - **The TLS front's access log:** for each request, the time, the client IP address, the method, the request path without its query string, the status, the Upgrade header, the bytes sent, and the duration. No user agent. Because the query string is not recorded, a signaling connection's line holds no rendezvous identifier and no client token.
  - **Earlier access log lines with the full request:** lines written before 14:00 UTC on 2026-10-07 also hold the query string, which carries the rendezvous identifier and the client token beside the client IP address. They are deleted on the same 91-day bound, by 2027-01-06 at the latest.
  - **The TLS front's error log:** warnings and errors; a request line in one can carry the query string, rendezvous identifier included.
  - **The coordination server's own output:** start-up and service lines, with no client IP address and no rendezvous identifier.
  - **The project's TURN relay at `turn.data-bridge.org`,** which runs on the same host and is used only by a party whose relay setting or connection configuration names it. Its lines hold a client's IP address and port when a connection fails, and the credential's username when authentication fails. The username is an expiry time and a fixed label; it identifies no party and no exchange ([docs/notes/webrtc-relay-deployment.md](docs/notes/webrtc-relay-deployment.md#what-the-relay-sees)).
  - **The host's own system lines,** including the SSH server's, which can hold the address of a machine that connected to it.
- **Cloudflare, a third party, serves the pages** at `psi.data-bridge.org` and `staging.data-bridge.org` and keeps its own records under its own retention, not the project's:
  - **Measured on the account:** the zone has no Logpush job, and the Pages project has no server-side functions, stores no log, and has Cloudflare Web Analytics turned off.
  - **Request analytics:** Cloudflare documents that its HTTP request analytics "retain at least 31 days of data" for a zone on the Free plan, which this one is. That is a minimum; Cloudflare states no maximum, and does not state which fields of each request it stores for a Free plan zone.
  - **Raw request logs:** Cloudflare documents that "By default, your HTTP request logs are not retained", and that when retention is turned on they can be retrieved going back at least 3 and up to 7 days. Whether it is turned on for this zone has not been checked.
  - **Not established:** what Cloudflare keeps for a request made straight to the project's `alcove-link.pages.dev` address, which does not pass through the zone, and how long Cloudflare keeps its own internal edge logs.
  - **Not carried by Cloudflare:** `signal.data-bridge.org` and `turn.data-bridge.org` are DNS-only names in the zone. Cloudflare answers DNS lookups for them and carries none of their traffic.
- **What it does not do:** no accounts, no cookies, no analytics or third-party tracking scripts, and no script, style, or font loaded from a third-party host. The application makes no request to any host other than the supporting services named below.
- **What it stores stays on your device.** A managed (recurring) exchange keeps its record -- the partnership label, the agreed column shape, the rendezvous locator, the schedule, the run outcomes, the rotating shared secret, and the address of any relay registrar you enroll it at -- in browser storage. None of it is sent to a server; an exchange you enroll at your relay's registrar sends that registrar the relay key derived from the current secret after each run, as the supporting-services table below describes. Deleting the managed exchange removes it (see [docs/MANAGED_EXCHANGE.md](docs/MANAGED_EXCHANGE.md#deleting-a-managed-exchange)). The at-rest threat model for that stored secret is in [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges).

## What supporting services can observe

An exchange relies on services that are operated by one of the parties, by the project, or by a third party, depending on the channel and the deployment. None of them sees the identifiers used for matching: those never leave the party that holds them. The full channel analysis is in [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#channel-security).

| Service | Typically operated by | What it can observe |
|---------|----------------------|---------------------|
| Page hosting (Cloudflare) | Cloudflare, which serves the hosted web application's pages through Cloudflare Pages for the project; not present if you deploy the web application yourself | Every request for the hosted application's pages: your client IP address, the requested path, timing, and the pages it serves. It carries none of the coordination server's or the TURN relay's traffic, and never data-channel content: the WebRTC session runs browser to browser under DTLS it does not terminate. It keeps request records under its own retention ([Hosted web application](#hosted-web-application)). |
| Peer coordination (signaling) | The project, for the hosted web application; you, if you deploy the web application yourself; or a public third-party service if you point at one | Rendezvous identifiers, connection timing, and client IP addresses. Never data-channel content: the two browsers run an authenticated key exchange directly and the server relays only opaque setup messages. The hosted deployment's access log records each connection's client IP address and timing, not its rendezvous identifier. [Hosted web application](#hosted-web-application) lists every log the server keeps and how long each is kept. |
| STUN | A third party. The hosted web application is configured by default with one public STUN server, `stun.l.google.com:19302` (Google-operated) | The client IP address that queried it, and nothing further. STUN is used to discover a public address before the connection is established. |
| TURN relay | Whoever you configure; commonly a commercial ICE service, or a relay one party operates and names in its browser's own settings or in the invitation | Each party's network address, whether or not any traffic is relayed: the browser reserves an address on the relay while gathering candidates, before it knows if the direct path will work. When traffic is relayed, also the traffic volume between the two endpoints. It forwards encrypted DTLS packets without terminating the session, so it cannot read content. The reference relay deployment deletes each journal entry within 91 days (see [Retention](docs/notes/webrtc-relay-deployment.md#retention-and-who-reads-it)). |
| TURN relay registrar | The party that operates the relay, when its configuration names the registrar (`connection.relay_registrar`) or a saved exchange in the web application is enrolled there; contacted by the CLI and by the web application's saved exchanges, never by a one-shot browser exchange | The exchange id the operator chose, the relay key derived from the exchange's current shared secret -- which the relay holds to accept credentials -- the client IP address, and the time of each registration. Never the shared secret or anything else about the exchange. |
| Shared SFTP server or file drop | One of the two parties, or a third party both trust | The exchange's files. What those files reveal depends on the exchange -- see below. |

The SFTP and file-drop case is the one that turns on how the exchange is set up:

- **A recurring, authenticated exchange** wraps the exchange in application-layer encryption keyed from the two parties' shared secret, so the server operator sees ciphertext and file timing rather than the exchange's contents. The rendezvous files, the key-exchange handshake frames that establish the key the wrap uses, and the abort marker a failing party leaves for its partner sit outside that wrap and are its stated exceptions; none of them holds exchange data or the identifiers used for matching (see [docs/COMPLIANCE.md's SC-8 row](docs/COMPLIANCE.md#nist-sp-800-53)).
- **A zero-setup exchange** carries no such key and relies on the transport alone -- SSH in transit, and the server's own access controls at rest. The server operator can read the files that pass through it, which include the payload values disclosed for matched rows. Where the server is outside both parties' control, prefer an authenticated exchange.

## What Alcove retains on your systems

- **The shared secret** in the key file is the only persistent credential; it is stored owner-only and rotates after every successful exchange (see [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#key-file-security)).
- **The output file** pairs your own row identifiers with the matched partner records and the columns the partner disclosed. The identifiers used for matching are not part of it. Its retention and disposition are yours to govern.
- **The exchange record** each party writes is a local, self-attested log of what it disclosed and carries no protected values (see [docs/spec/EXCHANGE_RECORD.md](docs/spec/EXCHANGE_RECORD.md)).
- **Logs contain no PII.** Operational logging is limited to non-sensitive metadata.

The complete data-handling account is in [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md#data-handling).

## Requests from data subjects

The project holds no personal data and cannot respond to access, correction, or deletion requests. Direct them to the agency that operates the deployment, which is the controller of the data it processed.

## Reporting a privacy concern

- If the concern is not security-sensitive, open a [GitHub issue](https://github.com/georgetown-mdi/alcove/issues) tagged `compliance`.
- If it is security-sensitive -- anything that could expose data -- follow the private reporting process in [SECURITY.md](SECURITY.md) instead. Do not open a public issue.

## Review and ownership

- **Owner:** the Alcove maintainers. Privacy review is a maintainer responsibility rather than a named individual's; use the reporting channels above rather than contacting a person.
- **Last reviewed:** the `last_reviewed` date in the front matter at the top of this document.
- **Cadence:** this statement is reviewed on any change that affects what Alcove collects, transmits, or retains, and at least annually regardless of whether anything changed. Every revision and its date are recorded in this repository's version history.

## See also

- [docs/COMPLIANCE.md](docs/COMPLIANCE.md) - regulatory framings, data classification, and the considerations a privacy review should cover
- [docs/SHARED_RESPONSIBILITY.md](docs/SHARED_RESPONSIBILITY.md) - the deployment model and what the project operates versus what the deploying agency operates
- [docs/SECURITY_DESIGN.md](docs/SECURITY_DESIGN.md) - threat model, data handling, channel security, and the at-rest model for managed exchanges
- [SECURITY.md](SECURITY.md) - vulnerability reporting and supported versions
- [SUPPORT.md](SUPPORT.md) - where to direct other questions
