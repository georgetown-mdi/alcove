---
title: "Alcove Deployment Model and Shared Responsibility"
review_owner: "Alcove maintainers"
last_reviewed: "2026-11-01"
---

# Deployment model and shared responsibility

This document names what the project operates and what the deploying agency operates, separately for the two deployments.

It is not a certification, an attestation, or a contract. It describes how Alcove is built and deployed; the deploying agency remains responsible for its own risk assessment and authorization ([COMPLIANCE.md](COMPLIANCE.md)).

## Alcove is not a hosted service

The deploying agency runs the software and is the sole controller of the data it processes; the project is neither controller, processor, nor business associate for that data, and operates nothing on the agency's behalf. The single exception is the hosted deployment of the web application, bounded in [Hosted web application](#hosted-web-application) below. Nothing in either deployment asks an agency to register, checks a license, calls home for updates, or reports usage.

No personal data is collected, transmitted, or retained by the project on its own behalf. [PRIVACY.md](../PRIVACY.md) is the authority on that answer.

## The two deployments

The split differs by deployment. Read the section for the deployment in question.

One responsibility precedes both and is the same in each: the decision to disclose -- its legal basis, the data sharing agreement behind it, and which columns are designated for disclosure -- together with the risk assessment, the privacy impact assessment, and the authorization that cover it. Alcove conducts the exchange the two parties configured and makes no determination about whether a disclosure is lawful ([COMPLIANCE.md](COMPLIANCE.md#authority-to-operate)).

### Container deployment (CLI and local console)

Both deployments are suitable for real exchanges. This one runs every component on infrastructure you control.

- **The project operates no part of it.** The container runs on hardware the agency controls, connects only to the endpoints the exchange's configuration names ([PRIVACY.md](../PRIVACY.md#container-deployment-cli-and-local-console)), and no component of it reports back.
- **No agency data is transmitted to, stored on, or accessible from project-operated infrastructure** -- an exchange over SFTP or a shared folder touches none, and a WebRTC exchange touches it only where it uses the project's coordination server or relays ([PRIVACY.md](../PRIVACY.md#container-deployment-cli-and-local-console)). Otherwise the project receives no data, no metadata, and no record that an exchange took place.
- **Even the registry the image comes from is not project-operated.** It is a public one ([PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe)).

The local console is part of this deployment rather than a hosted one: it rides in the same container, served over loopback to the operator's own machine ([CONSOLE.md](CONSOLE.md#reachable-only-where-you-publish-it)).

### Hosted web application

- **Status: suitable for real exchanges, including important one-off ones.** The project operates it on a best-effort basis, with no uptime commitment.
- **This is the one deployment where the project operates infrastructure at all**: the coordination server the application connects through, the TURN relay, the WebSocket relay, and the relay registrar, all on one host of the project's own on AWS in `us-west-2`.
- **What that infrastructure receives:** connection metadata, and from the registrar an exchange id and a relay key derived from the shared secret. When an exchange uses the project's relay, and what each service receives and keeps, are in [PRIVACY.md](../PRIVACY.md#hosted-web-application).
- **The inviting user can keep the project's coordination server out.** An exchange uses the coordination server its invitation names. A user who sets their own coordination server in relay settings creates invitations naming it from then on, and both parties of those exchanges contact it rather than the project's ([WEB_APP.md](WEB_APP.md#relay-settings)). Choosing and operating that server, and what it logs, are then the agency's. An invitation already sent keeps the server it named, and a saved exchange keeps its server until its inviter re-invites from it.
- **Third parties serve the pages and answer STUN.** Cloudflare Pages delivers the application code under Cloudflare's own retention, and carries none of the coordination server's traffic. Each release publishes a signed manifest of the files it deploys, to compare against what the site serves while it serves that release; a push to `main` between releases deploys a build no manifest lists ([RELEASES.md](RELEASES.md#hosted-web-application)). A party who cannot trust the host to deliver that code runs the container instead ([DEPLOYMENT.md](DEPLOYMENT.md#docker-deployment)). Google's public STUN server is contacted where neither the browser's relay settings nor the invitation names a STUN server ([PRIVACY.md](../PRIVACY.md#hosted-web-application)).
- **What it does not receive is the exchange:** not its content, the input file, the linkage identifiers, the shared secret, the agreed terms, or any record of what was linked. Matching happens in the browser ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#egress-hardening-and-its-limits)), and the exchange is end-to-end encrypted under the application-layer encryption keyed by the two parties' shared secret ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)).

An agency that deploys the web application on its own infrastructure takes every project-side row of the hosted table below.

## Responsibility split: container deployment

| Area | The Alcove project | The deploying agency |
|------|---------------------|----------------------|
| Infrastructure and network controls | Publishes the container image and documents how to restrict its outbound network access ([DEPLOYMENT.md](DEPLOYMENT.md#restricting-the-containers-outbound-network-access)). Operates no infrastructure an SFTP or shared-folder exchange touches; a WebRTC exchange can use its coordination server and relays ([PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe)). | All of it: the host, the container engine, the network path, egress rules, and the SFTP server or shared folder the two parties rendezvous through. Alcove requires no particular SFTP server and provides none ([DEPLOYMENT.md](DEPLOYMENT.md#sftp-server)). |
| Host and OS hardening | Ships the image running unprivileged as uid 1000, with its program files owned by root ([DEPLOYMENT.md](DEPLOYMENT.md#the-user-the-image-runs-as)). | The host operating system and its patching, the container engine's configuration, and the ownership and permissions of every mounted directory. |
| Identity and access | The exchange's own authentication: a pre-shared secret and an authenticated key exchange for recurring exchanges ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#authentication)), and SFTP host-key verification whose no-pin default is fail-closed ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#transport-layer-authentication)). No accounts, no login, no directory integration. | Who may log into the host and run the container; the SFTP accounts, their per-exchange directory permissions, and a separate account per party ([DEPLOYMENT.md](DEPLOYMENT.md#shared-folder-checklist)); and sending the shared secret and the host-key fingerprint to the partner out of band. |
| Encryption in transit | Wraps every recurring exchange in application-layer AES-256-GCM keyed from the key exchange, with the stated exceptions; a quick exchange relies on the transport alone ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)). | The transport beneath it: the SSH server's configuration and the access controls on a shared folder. Constraining SSH negotiation to approved algorithms is a connection setting the agency applies ([FIPS_SFTP_PROFILE.md](FIPS_SFTP_PROFILE.md)). |
| Encryption at rest | None. Alcove applies owner-only access control rather than encryption: the key file, signing identity, exchange records, and result CSV are written unencrypted at owner-only permissions ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#key-file-security)). | At-rest confidentiality in full -- storage or full-disk encryption on the host and on any backup medium ([COMPLIANCE.md](COMPLIANCE.md#nist-sp-800-53), SC-28). |
| Backup and recovery | Documents that a backed-up shared secret must hold the same owner-only restrictions as the original, and that re-invitation is the recovery when no backup exists ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#backup)). Provides no backup mechanism and holds no copy of anything. | Backing up, restoring, and protecting the key file, signing identity, configuration, input, and results, and the media those backups live on. |
| Data retention and disposal | Retains nothing. In the default mode the exchange deletes each file it has consumed; in retain mode it leaves the whole transcript in the shared folder, and nothing removes it afterwards ([DEPLOYMENT.md](DEPLOYMENT.md#shared-folder-checklist)). | Retention and disposition of the input, the result CSV, the exchange records, and the shared folder's contents, including clearing a retain-mode transcript. The exchange record can hold a self-facing pointer to where the result was filed and under what schedule ([COMPLIANCE.md](COMPLIANCE.md#hipaa-considerations)). |
| Logging and monitoring | Writes operational logs to the container's own output and keeps PII out of them; content is limited to non-sensitive metadata ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#data-handling)). Emits no telemetry and receives no logs. | Collecting, storing, protecting, and monitoring those logs; reviewing output before forwarding it to a third-party logging service; and alerting on a failed or missed exchange. |
| Incident response | Coordinated vulnerability disclosure on the timeline in [SECURITY.md](../SECURITY.md#reporting-a-vulnerability), with advisories and CVE assignment where applicable, and a documented compromise response for a leaked shared secret ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#compromise-response)). | Detection and response in its own environment, executing the compromise response with the partner, any breach notification it owes, and applying patched releases. |
| Patching and supply chain | Signed release tags, Cosign-signed images holding a SLSA build provenance attestation, a CycloneDX SBOM per release ([COMPLIANCE.md](COMPLIANCE.md#release-integrity)), and security patches for the current and previous major release ([SECURITY.md](../SECURITY.md#supported-versions)). | Verifying those signatures before deploying, tracking releases, and scheduling the upgrade ([RELEASES.md](RELEASES.md#verifying-a-release)). |

**The local console adds one operator-side control.** Its job API has no authentication. What it is reachable from is decided by the container's publish binding and the host firewall, both the agency's ([CONSOLE.md](CONSOLE.md#reachable-only-where-you-publish-it)); the trust invariant and what violates it are in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-console-trust-boundary).

## Responsibility split: hosted web application

| Area | The Alcove project | The deploying agency |
|------|---------------------|----------------------|
| Infrastructure and network controls | Operates the coordination server, the TURN relay, the WebSocket relay, the relay's registrar, and the TLS front in front of the coordination server, on one host of its own ([DEPLOYMENT.md](DEPLOYMENT.md#hardening-the-coordination-server)). The application's pages are served by Cloudflare Pages, a third party the project configures rather than operates; Cloudflare keeps its own request records under its own retention. | The network path from its own endpoints, and any egress or proxy controls it applies to them. |
| Host and OS hardening | The hosting platform and the application it serves. | The endpoint the browser runs on -- operating system and browser patching, disk encryption, screen lock. All data handling happens there. |
| Identity and access | No accounts, no registration, no cookies, and no login of any kind. Exchange authentication is the same authenticated key exchange the container runs. | Who may use the device and the browser profile, and sending the invitation -- which contains the secret that authenticates the exchange -- over a trusted channel ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#invitation-contents-and-confidentiality)). |
| Encryption in transit | The application's pages are served over HTTPS by Cloudflare, which terminates that TLS session. The coordination server is served over HTTPS by the project's own TLS front on its host; Cloudflare does not carry that traffic. The exchange itself is end-to-end encrypted under the application-layer encryption keyed by the two parties' shared secret, which neither Cloudflare nor the coordination server holds, over WebRTC DTLS ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#channel-security)). | The network path from its own endpoints to the coordination server and to the partner. Choosing a relay, if it uses one, in the browser's relay settings; every relay an exchange lists learns the party's address ([PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe)). |
| Encryption at rest | No agency data is stored on project infrastructure, so there is nothing there to encrypt. A managed (recurring) exchange persists its record -- including the rotating shared secret -- in browser storage on the operator's own device, where the at-rest posture is weaker than the CLI's owner-only key file: the store has no owner-only mode, and any script running in the origin can read it ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#hosted-at-rest-threat-model-for-managed-exchanges)). | Device-level protection for that storage: full-disk encryption, browser-profile hygiene, and removing the managed exchange when the partnership ends ([MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#removing-a-managed-exchange)). |
| Backup and recovery | Holds no copy of anything to restore. Re-invitation is the documented recovery for a lost or suspect secret. | Everything on the device, and one hazard specific to it: a browser-profile backup, a VM snapshot, or an exported credential file can silently re-arm the secret it captured ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#rollback-at-rest-copies-can-silently-resurrect)). |
| Data retention and disposal | Keeps one log, the system journal of the coordination server's host, which deletes each entry about 90 days after the newest entry in its file: connection metadata, and no exchange content, input data, or record of what was linked. Not claimed: Cloudflare's records of page requests, kept under Cloudflare's own retention. [PRIVACY.md](../PRIVACY.md#hosted-web-application) lists each log's fields and retention. | The input file, the result file, and any managed-exchange record on the device. Removing the managed exchange erases its stored record ([MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#removing-a-managed-exchange)). |
| Logging and monitoring | Operates and monitors the hosted service itself. What the coordination server's log records is in [PRIVACY.md](../PRIVACY.md#hosted-web-application). | Any monitoring of its own exchanges. The project provides no per-agency audit feed and no exchange history. |
| Incident response | The same disclosure process as above, and an incident affecting the hosted service itself. | Incidents in its own environment, including a lost or compromised device holding a managed exchange's secret; treat a captured export or profile copy as a captured token ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#compromise-response)). |
| Patching and supply chain | Maintains and deploys the hosted application; there is no package for the agency to install or patch. No analytics or tracking scripts are served, and the pages load no script, style, or font from a third-party host; Cloudflare Pages, named above, is the one third party in the delivery path. | The browser's own patching, and any extension or endpoint agent running in it. The in-browser data-handling property is a reviewed property of the codebase, not one the browser enforces against an injected script ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#egress-hardening-and-its-limits)). |

## Third-party supporting services

An exchange relies on services operated by one of the parties, by the project, or by a third party, depending on the channel and the deployment. Who operates a service is who answers for it. None of them sees the identifiers used for matching.

| Supporting service | Typically operated by | What it can observe |
|--------------------|----------------------|---------------------|
| Page hosting (Cloudflare) | Cloudflare, which serves the hosted web application's pages through Cloudflare Pages for the project; not present when the agency deploys the web application itself | [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe) |
| Coordination host (AWS) | Amazon Web Services, which provides the infrastructure the project's coordination server, TURN relay, WebSocket relay, relay registrar, and TLS front run on; not present when the agency deploys the coordination server itself | [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe) |
| Peer coordination (signaling) | The project, for the hosted web application, unless the invitation names another server, such as one the inviting user set in relay settings; the agency, if it deploys the web application itself or sets its own server there; or a public third-party service the agency points at | [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe) |
| STUN | A third party: Google's public STUN server where neither the configuration, the browser's relay settings, nor the invitation names a STUN server; otherwise whoever runs the STUN servers they name | [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe) |
| TURN relay | Whoever the agency configures, in the container deployment's connection block or in the browser's own relay setting; commonly a commercial ICE service. The project runs one at `turn.data-bridge.org`, used on the terms in [PRIVACY.md](../PRIVACY.md#hosted-web-application) | [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe) |
| WebSocket relay | Whoever the agency configures, in the container deployment's `connection.websocket_relay` or in the browser's own relay setting; no commercial service runs this relay. The project runs one at `relay.data-bridge.org`, on the same terms as its TURN relay | [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe) |
| Shared SFTP server or shared folder | One of the two parties, or a third party both trust | [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe) |
| Container registry | A public registry the project does not operate | [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe) |

## Recurring questionnaire answers

| A questionnaire asks | The answer, and where it is written down |
|----------------------|------------------------------------------|
| Where is our data hosted? | Where you run it. In the container deployment the project operates nothing and receives nothing. In the hosted web application, the input file is read and matched in the browser, and what leaves the browser is encrypted and sent to the partner; the coordination server the project operates receives neither the input file nor the exchange's content ([The two deployments](#the-two-deployments)). |
| Who at your organization can access our data? | Nobody. The project receives no agency data in either deployment. Between the two partner agencies, what is disclosed is the intersection plus the payload columns each party designated ([SECURITY_DESIGN.md](SECURITY_DESIGN.md#data-handling)). |
| What is your uptime commitment or disaster recovery plan? | The project operates nothing on your behalf in the container deployment, so availability is a property of your own host. The hosted web application is suitable for real exchanges and is operated on a best-effort basis, with no uptime commitment or disaster recovery plan. |
| List your subprocessors. | None for the container deployment; the project processes nothing. For the hosted web application the project engages two: Cloudflare, which serves its pages, and Amazon Web Services (AWS), which provides the infrastructure the coordination server, TURN relay, WebSocket relay, relay registrar, and TLS front run on. What each can observe is in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe). |

FedRAMP, StateRAMP and ATO status, encryption at rest, FIPS 140, and the NIST SP 800-53 mapping are answered in [COMPLIANCE.md](COMPLIANCE.md#where-a-reviewers-usual-questions-are-answered); vulnerability reporting and the patch commitment in [SECURITY.md](../SECURITY.md).

## What this document does not cover

- **Data practices** -- what is collected, transmitted, and retained, and by whom: [PRIVACY.md](../PRIVACY.md) is the authority.
- **Regulatory framings and control mappings** -- NIST SP 800-53, FIPS 140, HIPAA, FERPA, CJIS, IRS 1075, Section 508, export control: [COMPLIANCE.md](COMPLIANCE.md).
- **The threat model and the security controls themselves**: [SECURITY_DESIGN.md](SECURITY_DESIGN.md).
- **How to operate a deployment** -- the container, the console, the SFTP server checklist, and egress restriction: [DEPLOYMENT.md](DEPLOYMENT.md).

## Review and ownership

- **Owner:** the Alcove maintainers. This is a maintainer responsibility rather than a named individual's; use the reporting channels in [SECURITY.md](../SECURITY.md) and [SUPPORT.md](../SUPPORT.md) rather than contacting a person.
- **Last reviewed:** the `last_reviewed` date in the front matter at the top of this document.
- **Cadence:** reviewed on any change that moves the line between what the project operates and what the deploying agency operates, and at least annually regardless of whether anything changed. Every revision and its date are recorded in this repository's version history.

## See also

- [PRIVACY.md](../PRIVACY.md) - what the project collects, transmits, and retains, and what supporting services can observe
- [COMPLIANCE.md](COMPLIANCE.md) - regulatory framings, the NIST 800-53 control mapping, and the FIPS 140 position
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model, authentication design, channel security, and data handling
- [DEPLOYMENT.md](DEPLOYMENT.md) - operating the container, the console, and the supporting services
- [SECURITY.md](../SECURITY.md) - vulnerability reporting, response timeline, and supported versions
