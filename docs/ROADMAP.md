---
title: "Alcove Roadmap"
---

# Alcove roadmap

This document lists planned work, grouped by the release in which it is targeted. Major functionality that has already shipped is summarized in [CHANGELOG.md](../CHANGELOG.md), not here. Project overview and architecture are in [DESIGN.md](DESIGN.md).

Targeting is aspirational; the maintainers do not commit to a release date for any item below.

## Pre-1.0

Work required before the 1.0 release.


## Version 1.1

- A Voluntary Product Accessibility Template (VPAT) for the web application, built on the [accessibility self-assessment](ACCESSIBILITY.md)
- PSI-Sum
- Browser SFTP in the public web application, after 1.0 unless there is time before it (the first-party relay it needs is built; the browser client is not)
- Provisioning of supporting services (peer coordination, STUN/TURN, SFTP, WebSocket-to-TCP proxy)
- Reference configurations and deployment guides for each supporting service; the section pointers in [DEPLOYMENT.md](DEPLOYMENT.md) will be replaced with concrete guidance
- Metadata classification

## Possible later work

Captured in [DESIGN.md#possible-extensions](DESIGN.md#possible-extensions). These are research directions rather than committed work:

- Threshold and weighted scoring via secure multi-party computation
- Brute-force protection through input-size controls
- Post-quantum hybrid key establishment and dual signing, an open decision recorded only in [key-establishment-fips-boundary.md](notes/key-establishment-fips-boundary.md#post-quantum-horizon), not in DESIGN.md
- Electron desktop distribution of the web application. The progressive-web-app half is built: the hosted application is installable and its shell renders offline (see [MANAGED_EXCHANGE.md](MANAGED_EXCHANGE.md#installing-the-app))

## See also

- [CHANGELOG.md](../CHANGELOG.md) - major functionality that has already shipped
- [DESIGN.md](DESIGN.md) - project overview and architecture
- [SECURITY.md](../SECURITY.md) - supported versions and end-of-life policy
