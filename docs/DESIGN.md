---
title: "Alcove"
author: "Vincent Dorie"
---

# Overview

The goal of this project is to facilitate secure inter-agency data sharing of administrative records. This is accomplished by executing a privacy-preserving record linkage (PPRL) protocol based on private set intersection (PSI). A base implementation of PSI executes a cryptographic protocol between two parties who each have lists of strings and reveals to one or both parties the elements they have in common. Two parties can use it repeatedly to identify which of several statistical linkage keys they share, generating an association map between each party's matched elements, and can then exchange additional data elements for their common members. Alternatively, the parties can run a private set intersection cardinality (PSI-C) protocol to learn only the number of members they have in common (qualified in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#count-only-exchanges-and-the-pre-agreement-assumption)). PSI-C is a selectable algorithm alongside PSI; the count-only shape rules it runs under are specified in [PROTOCOL.md](spec/PROTOCOL.md).

Alcove works in a browser without additional software, and data flows only through the channel the exchange uses. A containerized command line application performs the same functions and integrates with an organization's own infrastructure.

This document covers the project overview, architecture, exchange specification summary, and high-level user journey. It does not cover the PSI protocol details (see [PROTOCOL.md](spec/PROTOCOL.md)), the threat model and authentication design (see [SECURITY_DESIGN.md](SECURITY_DESIGN.md)), network communication and supporting services (see [COMMUNICATION.md](COMMUNICATION.md)), or the CLI command reference (see [CLI.md](CLI.md)). Intended readers are program officers, evaluators, and new contributors.

# Exchange specification

The parameters necessary to execute an exchange are written into JSON or YAML documents supplied to an application. The components of an exchange specification include: the linkage terms which describes what will be exchanged and how, connection information which describes where the exchange will take place, metadata that describes the fields and their roles, and data cleaning transformations which provide convenience for low-tech users. See [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) for the full reference covering all fields, types, constraints, and examples for each of these four components.

# Architecture

The linkage protocol, exchange agreements, and communication layer described in this document are built into a single library whose functionality is exposed to users through three applications: a public web application delivered in the browser, a command line application, and a local console that puts a browser-based management interface in front of the command line application.

Exchange parameters set in the web application can be exported and handed to IT staff, who automate the exchange with the command line application.

## Core library

The core library includes the base PSI function, linkage term verification, input ingestion and cleaning, linkage key generation, and the execution of the linkage algorithms over PSI. The library also generates a [self-attested exchange record](spec/EXCHANGE_RECORD.md) at the end of each exchange -- a local, unsigned record of what was exchanged that a party can retain for its own disclosure records. Certificate-backed signing of that record into a third-party-verifiable receipt is an opt-in mode, selected through the configuration's `signing` block and checked with `alcove verify-receipt` (see [Receipt signing identities](SECURITY_DESIGN.md#receipt-signing-identities)). The various libraries that are run-time dependent, such as communication channels and cryptography, are abstracted over and need to be supplied by specific applications.

## Command line application

The command line application enables the automation of all exchange operations and can be integrated into data transformations. Recurring exchanges are run by external schedulers or orchestrators ([Scheduling the run](CLI.md#scheduling-the-run)). The application is distributed as a Docker image with a default working directory of `/work`; users mount their exchange directory there so that configuration, credentials, and data files are all accessible within the container.

## Web application

The web application is the browser-based, install-free entry point for conducting an exchange. When this browser holds recurring (managed) exchanges, the home route is the operator's list of them, from which one is run again without a new invitation. Otherwise, including in a browser that cannot store recurring exchanges, home is the start page for setting up or accepting a one-off exchange. The recurring-exchange list is always reachable at its own route, whose empty state offers setting one up, accepting a recurring invitation, or restoring one from a backup file. Verifying a receipt and starting with built-in synthetic sample data are secondary entries on the start page. Files are read and processed in the browser; nothing leaves the machine except the protocol traffic of an exchange the operator has consented to.

Starting an exchange walks the inviter through a short flow: choose your data file, decide how records are matched and which columns are shared, then review and create the invitation. Data cleaning, the matching keys, and an optional legal agreement can be set within the flow; their defaults are derived from the chosen file. Creating the invitation produces a single-use deep link to send to the partner out of band; the inviter then waits for the partner to connect and watches the exchange run. For WebRTC the exchange runs between the two browsers over a peer-to-peer connection. For the file-based transports (SFTP, shared folder), which the browser cannot drive, the flow produces a downloadable exchange file that the command line application runs.

Accepting an invitation opens the partner's deep link and walks the acceptor through reviewing the invitation's terms, consenting to them (an explicit acknowledgement and a typed name, with the inviter's legal agreement shown when one is attached), confirming which of the acceptor's own columns take part, and running the exchange. The invitation's secret travels in the link's URL fragment and is never sent to a server; the two parties meet through the PeerJS coordination server the web application is built to use, deriving their peer identifiers from that shared secret.

Verifying a receipt checks a completed exchange's self-attested record against its verification keys, entirely in the browser, so a party can confirm its own disclosure record without uploading anything.

## Web console

The web console is a browser-based management interface for the command line application, served on the operator's own machine and not shared beyond that host. It writes the configuration and supplies the arguments, and conducts a single SFTP, shared-folder, or WebRTC exchange by invoking the CLI as a subprocess: from an invitation the operator authors or accepts, or, when both parties already agreed on a server out of band, from a "Quick exchange" with no invitation and terms inferred from each party's own file (see [CONSOLE.md](CONSOLE.md)). Running the exchange directly in the console's server process is planned and not built.

The console works on one mounted working directory at a time, holding that one exchange's configuration, secret, input, and results. It is not a directory of saved connections, a scheduler or recurring-exchange manager (recurring exchanges live in the web application, and the command line application is scheduled from the command line), a manager of many exchanges at once, or a network service that fronts the operator behind an access-control perimeter. The published Docker image runs the console when started with `serve`. How it is enabled and deployed is in [CONSOLE.md](CONSOLE.md), the single-operator trust invariant and what violates it in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-console-trust-boundary), and the server-side job API's wire contract in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md).

# User journey

A user should be able to *invite* someone to conduct an exchange, *accept* an extended invitation, and *exchange* data for previously arranged details. The bare minimum necessary to conduct an exchange is an *input* file and a *location*, although most exchanges will also use a *shared secret* and want to save the *output*. Linkage terms, connection details, metadata, and data cleaning transformations form further exchange parameters.

For the rest of this section we describe use cases as in the command line application. The application provides eleven explicit subcommands - `init`, `invite`, `accept`, `update` and `apply` (which change an established partnership's linkage terms without a new shared secret), `exchange`, `enroll-relay` (which enrolls an exchange's relay key at the registrar of the relay this party operates), `fingerprint` (which shows this party's signing-certificate fingerprint), `verify-receipt` (which checks a stored exchange record or signed receipt), `probe-host-key` (which reads an SFTP server's host-key fingerprint), and `doctor` (which checks a network shared folder before an exchange is attempted) - alongside a quick exchange mode in which both parties run the same command against a shared server without specifying a subcommand. The full command inventory and behavior is in [CLI.md](CLI.md). Web application versions implement the same functionality with an appropriate graphical user interface and use browser storage instead of the file system.

A typical first exchange of a recurring relationship begins with one party generating an invitation with `alcove invite` and securely transmitting it to their partner out-of-band. The partner accepts with `alcove accept`, which establishes the shared configuration and key on both sides. Both parties then run `alcove exchange` to conduct the data exchange. Subsequent exchanges use `alcove exchange` with the stored configuration and shared secret, requiring no further coordination. After any successful exchange the shared secret is rotated. As a one-step alternative, parties can run `invite` and `accept` with a server URL as an argument, in which case acceptance leads to immediately conducting an exchange, unless `--no-run` is given or the configuration does not send a column the invitation requests, when it writes the configuration and stops.

Two invitation flows are supported: an offline flow where no server is involved and a server-coordinated flow where a server address is used for coordination and is given to both parties. In the server-coordinated flow, setup and exchange happen in one step: the inviter waits for the acceptor to respond, and both parties exchange immediately on acceptance.

| Intent | Invocation |
|---|---|
| Quick exchange (both parties) | `alcove URL input.csv` |
| Generate a config file for editing | `alcove init [URL] [input.csv]` |
| Start a recurring exchange relationship (offline) | `alcove invite --identity IDENTITY [input.csv]`, then share the invitation out-of-band |
| Start a recurring exchange relationship and exchange (server-coordinated) | `alcove invite --identity IDENTITY URL input.csv`, then share the invitation; the exchange runs on acceptance |
| Accept an offline invitation | `alcove accept --identity IDENTITY INVITATION [input.csv]` |
| Accept a WebRTC invitation and exchange | `alcove accept --identity IDENTITY INVITATION input.csv` |
| Accept a server-coordinated invitation and exchange | `alcove accept --identity IDENTITY URL INVITATION input.csv` |
| Recurring exchange | `alcove exchange input.csv` |
| Quick exchange, establish recurring relationship (both parties) | `alcove --save URL input.csv` |
| Re-establish after lost secret | Delete key file on both sides; re-run `alcove invite` and `alcove accept` |

If only one party uses `--save` during a quick exchange, no shared secret is established; see [Bootstrapping a shared secret](SECURITY_DESIGN.md#bootstrapping-a-shared-secret) for the full set of outcomes.

For full documentation of each subcommand, configuration files, invitations, and recovery procedures, see [CLI.md](CLI.md).

# Possible extensions

## Multiple potential matches

The deterministic cascade requires that each linkage key be precise enough to produce only definitive matches. This rules out pairing algorithms that score or threshold matches across multiple keys. Doing so requires running PSI on keys that may produce non-definitive matches, revealing information about individuals who are not in the final intersection.

Threshold and weighted scoring approaches could be supported without this privacy cost using secure multi-party computation (MPC) to evaluate match scores over encrypted data, never exposing intermediate per-key match results. This would substantially increase protocol complexity and is left as a potential future extension.

## Brute force protection

As mentioned in the threat model, brute-force attacks are possible for simple keys. At some point, controls may be implemented that prevent the algorithm from running if the input is a relatively large portion of the potential universe of possible values.

## SSH as a replacement for SFTP

Communication over SFTP requires polling for messages, which adds latency. Where both parties can reach a shared SSH server, SSH channels - bidirectional byte streams that need no polling - could replace it: the parties would establish order through the server's SFTP subsystem, or through a shell primitive such as `mkdir` where remote commands are permitted, then pass messages over SSH channels. Such a transport must satisfy the message-delivery contract in [COMMUNICATION.md](COMMUNICATION.md#message-delivery-and-teardown).

This is not pursued: on real data sets latency is not the bulk of the time, and polling faster trips servers' attack prevention. A CLI exchange that needs no polling runs over WebRTC.

## WebSocket relay

A WebSocket relay is built. It carries a WebRTC exchange for two parties whose network blocks the WebRTC connection and TURN but passes a WebSocket on port 443: each party opens one `wss://` connection to the relay, which pairs the two connections of one exchange and forwards their messages. The relay terminates TLS and reads the WebSocket frames; the application-layer encryption both applications apply keeps the exchange's contents from it, apart from the key-exchange handshake frames that set that encryption up. When a run uses the relay and what admits a party are in [COMMUNICATION.md](COMMUNICATION.md#websocket-relay), and what its operator can observe in [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe).

## Other applications

The hosted web application is an installable progressive web app: it ships a web manifest and an app-shell service worker, so once installed its shell and recurring-exchange list render with no network. Installation gives an unattended recurring exchange a runtime to run in ([Installing the app](MANAGED_EXCHANGE.md#installing-the-app)).

# License and disclaimer

Alcove is free, open-source software released under the [Apache License, Version 2.0](../LICENSE.md) and will remain available at no cost. It is provided "as-is," without warranty of any kind, express or implied, including without limitation any warranties of merchantability, fitness for a particular purpose, or non-infringement. The full warranty disclaimer and limitation of liability appear in sections 7 and 8 of the Apache License.

Agencies evaluating Alcove for operational use are responsible for their own risk assessments, authority-to-operate (ATO) determinations, and compliance reviews under applicable federal, state, or local regulations. The project documentation -- including this document, [SECURITY_DESIGN.md](SECURITY_DESIGN.md), [PROTOCOL.md](spec/PROTOCOL.md), and [COMPLIANCE.md](COMPLIANCE.md) -- is intended to support those reviews, not to substitute for them.

# See also

- [PROTOCOL.md](spec/PROTOCOL.md) - PSI and PSI-C algorithm details and post-linkage steps
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md) - threat model, authentication design, and channel security
- [COMMUNICATION.md](COMMUNICATION.md) - communication channels and supporting services
- [CLI.md](CLI.md) - full CLI command reference and configuration guide
- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - complete exchange reference
- [COMPLIANCE.md](COMPLIANCE.md) - regulatory framings, data classification, and compliance considerations
