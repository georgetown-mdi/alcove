---
title: "Alcove"
---

# Alcove

Alcove is open-source software that lets two organizations find the people they have in common, and optionally exchange data about them, without either one revealing anything about the records the other does not have.
It performs privacy-preserving record linkage (PPRL) with a cryptographic protocol called private set intersection (PSI).

## Three ways to use Alcove

All three run the same protocol, so you and your partner do not have to pick the same one.

- **The web app**, at [psi.data-bridge.org](https://psi.data-bridge.org/).
  Nothing to install: your file is read and matched inside your browser, which exchanges directly with your partner's.
  Best for a first or occasional exchange, and it can run the same exchange again on a schedule.
  Read [Using the web app](WEB_APP.md) and [Recurring exchanges in the browser](MANAGED_EXCHANGE.md).
- **The command line app**, a Docker image.
  It exchanges through an SFTP server, a shared folder, or with a partner's browser, and runs from cron or the Windows Task Scheduler.
  Best for recurring exchanges and for IT teams fitting linkage into a data pipeline.
  Read [the command line guide](CLI.md) and [the exchange configuration reference](EXCHANGE_REFERENCE.md).
- **The console**, the same Docker image serving a guided screen on your own machine.
  It writes the configuration and runs one exchange for you, so you can try an exchange with test data before moving it to the command line.
  Read [the console guide](CONSOLE.md).

How many records each one handles, and roughly how long an exchange takes: [How large an exchange can be](WEB_APP.md#how-large-an-exchange-can-be).

## User guides

- [Documentation index](README.md), with a reading guide for each role: analysts, invited partners, program officers, security reviewers, compliance officers and IT staff.
- [Deployment](DEPLOYMENT.md), for IT staff hosting Alcove or its supporting services.
- [Shared responsibility](SHARED_RESPONSIBILITY.md), where an agency security review starts.
- [Security design](SECURITY_DESIGN.md), [compliance](COMPLIANCE.md) and [privacy](../PRIVACY.md).

## Releases

- [Changelog](../CHANGELOG.md): what Alcove does, and what changes in each release.
- [Releases on GitHub](https://github.com/georgetown-mdi/alcove/releases): the published versions.
- [Releases](RELEASES.md): the versioning policy, the container images each release publishes, and how to verify them.
- [Roadmap](ROADMAP.md): what is planned next.

## Security

- [Security policy](../SECURITY.md): which versions receive fixes, and how to report a vulnerability.
  Do not report a vulnerability in a public issue: use GitHub's private vulnerability reporting, as the policy describes.
- [Incident response](INCIDENT_RESPONSE.md): how a reported vulnerability is handled.

## Governance and contributing

- [Contributing](../CONTRIBUTING.md): how to build and test Alcove, the conventions a change follows, and how pull requests are reviewed.
- [Support](../SUPPORT.md): where to ask a question or report a bug.
- The governance documents: the [security policy](../SECURITY.md), [privacy](../PRIVACY.md), [incident response](INCIDENT_RESPONSE.md), [security design](SECURITY_DESIGN.md), [compliance](COMPLIANCE.md) and [shared responsibility](SHARED_RESPONSIBILITY.md).
- The source code is on [GitHub](https://github.com/georgetown-mdi/alcove).

## License

Alcove is licensed under the [Apache License 2.0](../LICENSE.md).
