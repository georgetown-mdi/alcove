---
title: "Security Incident Response Runbook"
review_owner: "Alcove maintainers"
last_reviewed: "2026-11-07"
---

# Security incident response runbook

This is the responder's side of [SECURITY.md](../SECURITY.md), in the order the work happens: from a report arriving to an advisory published. SECURITY.md is the authority on scope, timelines, and disclosure terms. Release mechanics are in [RELEASES.md](RELEASES.md), and the threat model and control descriptions in [SECURITY_DESIGN.md](SECURITY_DESIGN.md).

An incident on a service the project runs for the hosted web application -- a compromised host or credential, a deploy that serves unintended code, or a service that keeps more than documented -- takes its own path, [Incidents on a project-run service](#incidents-on-a-project-run-service).

Two roles appear throughout:

- **The maintainer** holds commit access and a release signing key, and does the technical work.
- **The co-owner** is the organization's other owner, and holds the second release signing key. When the maintainer is unavailable, the co-owner covers intake and reporter communication, and can ship a fix; see [When the maintainer is unavailable](#when-the-maintainer-is-unavailable). On an incident on a project-run service, the co-owner acts when the maintainer cannot; see [Who acts](#who-acts).

A leaked shared secret between two exchange partners is not handled here: the partners run [SECURITY_DESIGN.md#compromise-response](SECURITY_DESIGN.md#compromise-response) themselves, and it needs nothing from this project.

## Preconditions

Confirm these once a year alongside the [tabletop exercise](#exercise-record).

**The intake path is open.** [SECURITY.md](../SECURITY.md#reporting-a-vulnerability) names GitHub private vulnerability reporting as the primary way in and the maintainer's email as the fallback. For a report that arrives by email, open a draft security advisory on receipt and continue there. The GitHub path is a repository setting:

```sh
gh api repos/georgetown-mdi/alcove/private-vulnerability-reporting
```

The answer must be `{"enabled":true}`. If it is not, enable private vulnerability reporting in the repository's security settings.

**Release credentials are reachable.** Either of two people can ship a hotfix. The maintainer and the co-owner each hold an SSH signing key listed in `allowed_signers` ([RELEASES.md#source-integrity](RELEASES.md#source-integrity)), and each one's GitHub account is on the bypass list of the "Protect release tags" ruleset ([RELEASES.md#7-tag-the-release](RELEASES.md#7-tag-the-release)), so either can push a signed release tag. Confirm both. The registry logins belong to the release workflow: the ghcr.io push uses the workflow's own token, and the Docker Hub copy uses a personal access token created on the `vdorie` account, stored in the `Release` environment's secrets, which only a release tag can reach. That token expires on 2027-10-30, and once it lapses the Docker Hub copy fails in every release until it is replaced ([RELEASES.md#the-docker-hub-copy](RELEASES.md#the-docker-hub-copy)). The release jobs also log in to Docker Hub with a read-only pull token that expires too, and once it lapses the login step fails in every job that has it, a release included ([RELEASES.md#8-build-and-publish-the-container-image-ci](RELEASES.md#8-build-and-publish-the-container-image-ci)).

**Someone besides the maintainer sees a report arrive.** Confirm the co-owner holds an account with admin access to the repository and that its security notifications reach them.

## 1. Receive and acknowledge

Target: within 5 business days ([SECURITY.md#response-timeline](../SECURITY.md#response-timeline)).

- Reply in the private report thread. Acknowledge receipt, state that a triage verdict follows within 15 business days, and ask for anything missing from the reporter checklist in [SECURITY.md](../SECURITY.md#reporting-a-vulnerability): affected component, version, transport channel, and a reproduction.
- Keep it private. No public issue, no pushed branch, and no commit message, pull-request title, or CHANGELOG line naming the mechanism before the advisory publishes. This repository is public and its history does not redact.
- Record the dates in the report thread as you go: received, acknowledged, confirmed or declined, fix merged, release published, advisory published. An assessment asks for them afterwards.
- Set two reminders from the confirmation date: one at 90 days, the published fix-or-advisory target, and one two weeks ahead of it.

## 2. Triage and call severity

Target: confirmed or declined within 15 business days.

Reproduce before deciding anything. If the report is not reproducible, say so in the thread and ask for the missing conditions rather than declining silently.

**Is it in scope?** [SECURITY.md#scope](../SECURITY.md#scope) lists what is in and what is out. A flaw in the PSI primitive itself goes upstream to OpenMined/PSI, with a note back to us so the vendored copy gets updated. When declining, name the scope line the report falls outside and where the reporter should take it instead. The list is a reporter-facing summary, not the boundary of what gets fixed: a report describing a real defect in a control this project documents is triaged even when the list does not name that control, and the scope question goes to the maintainer rather than back to the reporter as a decline.

**How severe?** Anchor the call in what Alcove claims:

- **Critical or High** -- a result revealing more than the agreed intersection, authentication bypass or partner impersonation, shared-secret or key-file exposure, or record data exposed in plaintext on a path documented as confidential.
- **Moderate** -- a documented control that fails open without being fully bypassed, or an exposure that needs an unlikely configuration.
- **Low** -- disclosure of non-record metadata, or a denial of service against a party's own run.

Two documented limitations decide a recurring class of report. Quick exchanges have no application-layer AEAD by design and rely on transport encryption alone ([SECURITY_DESIGN.md#channel-security](SECURITY_DESIGN.md#channel-security)), and an adversary who has already compromised the host running Alcove is out of scope. When declining on either basis, say which one.

Score the severity with CVSS in the draft advisory (step 5), not in the thread, so the number the reporter is told is the number that publishes.

## 3. Determine affected versions

Patches cover the current major release and the previous major ([SECURITY.md#supported-versions](../SECURITY.md#supported-versions)). Applying that rule to a concrete report:

- Released versions are the signed `vX.Y.Z` tags, not `staging`. Check the flaw against the tag:

  ```sh
  git fetch --tags
  git tag --list 'v*'
  git log --oneline vX.Y.Z -- <path of the affected file>
  ```

- A flaw that exists only on `staging` and in no tag needs a fix, not an advisory: no released artifact contains it. Tell the reporter that is the verdict and that the fix ships with the next release.
- While the released line is `0.x`, there is no previous major to patch. The current release is the only supported version. 0.x does not become the previous major when 1.0 ships: it receives no patches, and the previous-major row first binds at 2.0. An empty row is not a claim that older releases are covered.
- Write down the affected range and the fixing version as soon as they are known. Both go into the advisory verbatim, and into the reporter's next update.

## 4. Fix privately, then release

The release mechanics are [RELEASES.md#hotfix-releases](RELEASES.md#hotfix-releases): a fix to the latest release ships as the next release, cut from `staging` by the ordinary release checklist, and a fix to an older release line is a PATCH release branched from that line's tag and tagged without merging. Follow it as written. This step adds the disclosure sequencing around it.

- Develop out of public view: GitHub's temporary private fork from the report thread, or a local branch. Do not push the branch to the public repository.
- Write a regression test that fails without the fix.
- **Opening the pull request is the disclosure.** A fix diff on a public repository shows anyone reading it what the flaw was, whatever the PR text says. Open it when you are ready to merge, tag, release, and publish the advisory in one sitting, not days ahead of the release. An older-line hotfix opens its pull request only after the release, so for it pushing the tag is the disclosure.
- Until the advisory publishes, the pull request body and the commit message describe the fix, not the attack.
- The CHANGELOG entry goes in a `### Security` subsection ([RELEASES.md#3-update-changelogmd](RELEASES.md#3-update-changelogmd)). It names the impact and the fixed version, and it can be written at publication time rather than in the private fork.
- If a supported previous major is affected, apply the fix there too, by its own hotfix, before publishing anything ([RELEASES.md#hotfix-releases](RELEASES.md#hotfix-releases)).
- A security release skips none of the ordinary gates: the [image vulnerability scan](RELEASES.md#image-vulnerability-scan) still gates the push, and the release still produces a signed image, a provenance attestation, and an SBOM.

## 5. Draft the advisory and request a CVE

The advisory and the CVE both run through the repository's Security tab, under Advisories. GitHub is a CNA, so the CVE request goes there and nowhere else.

1. **Draft it from the report.** Starting the draft from the private report thread keeps the reporter, and their credit, attached through to publication.
2. **Fill in the substance**: a title naming the component and the impact; a description covering impact, affected versions, the fixed version, and a workaround for anyone who cannot upgrade immediately; the CVSS vector; and a CWE if one fits.
3. **Affected products.** That section is built around package ecosystems, and Alcove publishes no registry package -- the released artifacts are a signed container image and the tagged source ([RELEASES.md#release-artifacts](RELEASES.md#release-artifacts)). Put the affected and fixed versions in the description as well, where they are readable regardless of what the form accepts. This form has not yet been used for a real advisory: confirm this step at first use and correct it here afterwards.
4. **Request the CVE ID** from the draft before publishing. The identifier is assigned to the draft and travels with it to publication.
5. **Credit the reporter** by the name or handle they use, unless they asked for anonymity ([SECURITY.md#disclosure-policy](../SECURITY.md#disclosure-policy)).
6. **Share the draft with the reporter** for accuracy before publishing.
7. **Publish once the patched release is downloadable.**

## 6. Reporter communication

Every milestone below is a message the reporter should not have to ask for.

| Milestone            | Target                        | What the reporter is told                                                     |
| -------------------- | ----------------------------- | ----------------------------------------------------------------------------- |
| Acknowledgement      | 5 business days from receipt  | The report arrived, who is handling it, and when the verdict follows           |
| Triage verdict       | 15 business days from receipt | Confirmed or declined, with the severity call, or the scope line behind a decline |
| Fix plan             | With the verdict, if confirmed | The affected versions, the intended fixing version, and a target date          |
| Slip                 | Before the date passes         | The new date and the reason                                                   |
| Draft advisory       | Before publication            | The text, the credit line as it will read, and a chance to correct both        |
| Publication          | Same day                      | The advisory link, the CVE, and the released version with the fix          |

The 90-day window in [SECURITY.md](../SECURITY.md#response-timeline) runs from confirmation, and reporters are asked to hold disclosure until the advisory or that date, whichever is first. If the window is going to be missed, raise it with the reporter well before it elapses and agree on what happens next.

## 7. Close out

- Confirm the published state: advisory live with its CVE, release notes and CHANGELOG holding the security entry, patched image published and signed.
- Thank the reporter and close the thread.
- Correct this runbook wherever it was wrong or unclear, within the same week.
- If the incident exposed a gap in a control rather than a single defect, that is follow-up work in its own right; raise it with the maintainer rather than leaving it in the closed thread.

## When the maintainer is unavailable

This section is for the co-owner. The co-owner holds the second release signing key, so a fix can ship on this path, by the [co-owner hotfix](#co-owner-hotfix) below. The rest of it is communication.

In order:

1. **Acknowledge within 5 business days**, in the private thread, using the template below. Acknowledging is not confirming: it commits to nothing about whether the report is valid.
2. **Keep the report private.** Do not open an issue, do not describe it to anyone outside the organization, and do not repeat its content in any public channel.
3. **Reach the maintainer** through the routes the organization keeps for this, and get an expected return date.
4. **Tell the reporter what is actually true** as soon as the 15-business-day triage target looks unreachable: the technical owner is unavailable, here is the date they return, here is when a verdict follows.
5. **Bring in technical help only if waiting is not viable** -- the report suggests active exploitation, or the absence will outrun the 90-day window. Use someone the organization already trusts with a private disclosure, and scope them to assessing severity, not to shipping a fix.
6. **Do not** tag or publish a release, publish an advisory, or request a CVE, except by the [co-owner hotfix](#co-owner-hotfix).

Acknowledgement template:

```text
Thank you for reporting this privately, and for following our disclosure policy.

I am acknowledging receipt on behalf of the project. Our technical maintainer is
unavailable until <date>; I am not able to assess the technical detail myself, so
the triage verdict will come from them and I expect it by <date>.

The report stays private with us in the meantime. If anything changes on your end
-- including evidence that the issue is being exploited -- please tell me here and
I will escalate immediately.
```

### Co-owner hotfix

The co-owner can ship a fix without the maintainer when waiting is not viable, as step 5 above defines it. Follow [RELEASES.md#hotfix-releases](RELEASES.md#hotfix-releases) for the fix and the release steps, except that the review before merging is waived on this path: say so in the pull request. Opening that pull request, or for an older-line hotfix pushing its tag, is the disclosure, so merge, tag, release and publish the advisory in one sitting, as [4. Fix privately, then release](#4-fix-privately-then-release) and [5. Draft the advisory and request a CVE](#5-draft-the-advisory-and-request-a-cve) set out. At the tag step, sign the tag with your own SSH key, whose fingerprint is listed in [RELEASES.md#source-integrity](RELEASES.md#source-integrity), with git set to sign with it in that clone (`git config gpg.format ssh` and `git config user.signingkey <path to the key>`), and push it: the release workflow runs on that push and needs no approval from the maintainer.

## Incidents on a project-run service

This path is for an incident on a service the project runs for the hosted web application, not for a flaw reported in the software. It sets no response time: the project runs these services on a best-effort basis, with no uptime commitment ([SHARED_RESPONSIBILITY.md](SHARED_RESPONSIBILITY.md#hosted-web-application)).

The services, and where each one's deploy path is documented:

- **The pages.** Cloudflare Pages serves the hosted web application at `psi.data-bridge.org`, its `staging` previews at `staging.data-bridge.org`, the demo site at `demo.data-bridge.org`, and the project site at `data-bridge.org`. Each is uploaded by a workflow ([DEPLOYMENT.md](DEPLOYMENT.md#deploying-to-cloudflare-pages), [The project site](DEPLOYMENT.md#the-project-site)).
- **The relay host.** One AWS instance in `us-west-2` runs the coordination server, the TURN relay, the WebSocket relay, the relay registrar, and the 443 front and TLS front before them ([DEPLOYMENT.md](DEPLOYMENT.md#the-projects-hosted-web-deployment)). It takes each new commit of `main` through [the host pull](../infra/host-pull/README.md).

What each service sees and keeps is stated in [PRIVACY.md](../PRIVACY.md#hosted-web-application).

### What counts as one

- **A compromised host or credential.** Someone else has run code on the relay host, or holds a credential that deploys or administers a service: the Pages deploy token, a secret the relay host holds, or an account that administers the Cloudflare account or the AWS account.
- **A deploy that serves unintended code.** A service serves a build that no deploy workflow made from a commit on its branch: a served file that does not match its build's signed manifest ([RELEASES.md](RELEASES.md#hosted-web-application)), or a Pages upload that no workflow run made.
- **A service that logs or keeps more than documented.** It records something PRIVACY.md does not list for it, or keeps it longer than PRIVACY.md states.

A flaw in the software these services run is a vulnerability, handled from [step 1](#1-receive-and-acknowledge). When a build serving it has to come down before the fix ships, the rollback below applies to it as well.

### Who acts

The maintainer acts first. When the maintainer cannot, the co-owner takes the same steps, and on this path may publish the incident's advisory and the note in SECURITY.md. Step 6 of [When the maintainer is unavailable](#when-the-maintainer-is-unavailable) governs the vulnerability path, not this one.

Each step needs an account or access, named in [The access each step needs](#the-access-each-step-needs); this runbook does not record who holds it.

Open a draft GitHub security advisory from the repository's Security tab at the start, and record the dates in it as you go: noticed, stopped or rolled back, users told. Publishing the same advisory is how users are told ([Tell users](#tell-users)).

### Stop or roll back the pages

The pages are rolled back, not stopped: no deploy path takes a Pages project offline, and the OpenTofu root refuses to remove one (`prevent_destroy`, [infra/hosted/README.md](../infra/hosted/README.md#what-it-describes)).

After a deploy-token incident, rotate the token first ([Rotate a leaked credential](#rotate-a-leaked-credential)), then roll back and delete deployments as below.

1. **Roll production back to the last deploy with a signed manifest.** Re-run the `pages_deploy.yaml` run on `main` that deployed the last build known good. The re-run deploys that run's build to production, the demo site's with it, and publishes that build's signed manifest ([RELEASES.md](RELEASES.md#the-manifest-of-a-main-deploy)). A `release.yaml` run does not serve here: it uploads only while `main` holds no commit its tag's commit lacks ([DEPLOYMENT.md](DEPLOYMENT.md#deploying-to-cloudflare-pages)), so once `main` has moved past the tag, its re-run deploys nothing. Where GitHub no longer offers that run's re-run, revert the cause on `staging` and promote `main`: the push deploys a build of the reverted commit, with a signed manifest of its own.
2. **Take the cause out of `main`.** The next push to `main` deploys its tip, so after a re-run the cause is reverted on `staging` before the next promotion. Until the revert is on `main`, push no release tag: `release.yaml` redeploys production from a tag on the newest release line whose commit `main` has not moved past ([DEPLOYMENT.md](DEPLOYMENT.md#deploying-to-cloudflare-pages)).
3. **Roll back the staging previews and the project site** by reverting the cause on `staging`, and for the project site promoting `main`: a push redeploys each ([DEPLOYMENT.md](DEPLOYMENT.md#deploying-to-cloudflare-pages), [The project site](DEPLOYMENT.md#the-project-site)). Neither has a signed manifest, so neither has a signed deploy to roll back to.
4. **Delete the deployments that serve the affected build.** Every upload stays served at its own address, `<hash>.<project>.pages.dev`, after a later one replaces it, so a rollback alone leaves the affected build reachable there. From a checkout, with the locked deploy tool and a token in `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set:

   ```sh
   cd .github/wrangler && npm ci
   npx wrangler pages deployment list --project-name <project>
   npx wrangler pages deployment delete <deployment-id> --project-name <project>
   ```

   Which deployments are affected:

   - After a deploy-token incident, every deployment created since the token may have leaked, other than those the rollback creates. Delete them all: an upload's commit hash is whatever the uploader passes, so it does not tell a forged upload from a workflow's.
   - After any other incident, the commit hash each deployment lists is the guide: it is the commit a workflow upload records (`--commit-hash`).

   `--force` deletes one that still has an alias. Repeat for each Pages project the affected build reached.

### Stop or roll back the relay host

- **Stop it** by stopping the instance, in the EC2 console or with `aws ec2 stop-instances --instance-ids <the host's instance id> --region us-west-2`. That stops the coordination server, the TURN relay, the WebSocket relay, and the registrar together. While it is stopped, an exchange that needs the project's coordination server or relays cannot connect.
- **Roll it back** by reverting the cause on `staging` and promoting `main`. Once the tip's push-triggered runs have passed and its core build is on the `broker-core-build` prerelease, run the pull by hand in a Session Manager session on the host, `systemctl start alcove-host-pull.service`, and read its outcome in `/var/lib/alcove-host-pull/status` ([the host pull](../infra/host-pull/README.md#outcomes)). The pull verifies that commit's signed core build before it installs it. A host that was stopped is started first, and runs the affected commit until the pull finishes.
- **There is no redeploy of an earlier signed build.** The prerelease holds the build of the latest commit on `main` alone ([RELEASES.md](RELEASES.md#the-broker-core-build)), so the host's rollback is the revert, deployed with the next signed build.
- **Replace a compromised host rather than cleaning it.** Launch a new instance from [`infra/relay/aws/provision.md`](../infra/relay/aws/provision.md), install it as [`infra/relay/README.md`](../infra/relay/README.md#order-of-operations) and [`infra/broker/README.md`](../infra/broker/README.md#install) describe, install [the host pull](../infra/host-pull/README.md#install), which neither install script installs and which the rollback above needs, and move the elastic address to it. Replace every secret the old host held, each one [What is not tracked](../infra/relay/README.md#what-is-not-tracked) lists: the TURN static secret, the registrar token, the DNS provider credential, and the certificates' keys. Also revoke each certificate the old host held, through the ACME client (with lego, the default, `lego certificates revoke --path <ACME directory> --email <ACME email> --cert.name <certificate name> --reason 1`, for each of the old host's ACME directories, `/etc/alcove-relay/acme` and `/etc/alcove-broker/acme`): the intruder holds its key, and a certificate stays valid until it expires.

### Rotate a leaked credential

- **The Pages deploy token.** One `CLOUDFLARE_API_TOKEN` is set on both the `Production` and `Staging` environments, and its grant covers every Pages project on the account, production included, so a token incident rotates both. Create a new token at the scope [DEPLOYMENT.md](DEPLOYMENT.md#deploying-to-cloudflare-pages) states, set it on both environments, and delete the old token in Cloudflare. Then roll back and delete deployments as [the pages steps](#stop-or-roll-back-the-pages) set out for a token incident.
- **The OpenTofu tokens and the state credentials** are the maintainer's, outside the repository ([infra/hosted/README.md](../infra/hosted/README.md#state-and-credentials)). Replace them in Cloudflare and AWS. The co-owner takes this step only with the access [the table](#the-access-each-step-needs) names for it.
- **A secret the relay host holds** goes with the host: replace the host as above.

### Remove what a service kept

For a service that kept more than documented, first stop it or roll back the build that added the record. Then delete from the host what it kept beyond what PRIVACY.md states, and state in PRIVACY.md what was kept, over which window, and when it was deleted, as its [Hosted web application](../PRIVACY.md#hosted-web-application) section does for earlier log lines.

### Tell users

The project has no accounts and no list of users, so it tells them in three places:

1. **A GitHub security advisory**: the draft opened at the start ([Who acts](#who-acts)), completed and published from the repository's Security tab as [step 5](#5-draft-the-advisory-and-request-a-cve) describes. It names the service, what happened, the window from its start to the stop or rollback, what the service could have seen or served in that window by PRIVACY.md, and what a user should do. A CVE is requested only when the cause is a vulnerability in the software.
2. **A dated note in [SECURITY.md](../SECURITY.md)**, under a heading for hosted-service incidents that the first note adds, linking the advisory. It is merged into `staging` and reaches readers when `main` is promoted.
3. **A notice on the hosted site, in the same deploy as the fix, when the pages are intact.** The pages are intact when a deploy can again be trusted to serve what the workflows built; after a deploy-token incident, that is once the token is rotated. The web application has no notice component, so the notice is a change to it, merged into `staging` with the revert where there is one, and promoted with it. A re-run of an older run deploys an existing build and cannot include the notice, which ships with the revert that follows.

### The access each step needs

| Step | The account or access it needs |
| ---- | ------------------------------ |
| Re-run a deploy run | Write access to the repository, to re-run a workflow run |
| Revert and promote, and the note in SECURITY.md | The rights to merge into `staging` and promote `main` |
| Delete Pages deployments | A Cloudflare API token holding Account -> Cloudflare Pages -> Edit on the project's account, created by a member of that account |
| Stop the relay host | An AWS principal in the project's AWS account allowed to stop the host's instance |
| Run the pull by hand, or delete records on the host | A Session Manager session on the host, which is administered through SSM ([provision.md](../infra/relay/aws/provision.md#the-instance-role)) |
| Replace the relay host | An AWS principal allowed to launch an instance and move the elastic address, and the DNS provider's credential for the zone |
| Rotate the Pages deploy token | Membership of the Cloudflare account to create and delete the token, and admin access to the repository to set environment secrets |
| Replace the OpenTofu tokens and the state credentials | Membership of the Cloudflare account to create and delete the two tokens, and an AWS principal allowed to replace the state principal's credentials |
| Publish the advisory | A repository role that can publish a security advisory |

## Exercise record

This runbook is walked once a year against a simulated report, and again after any change to the release or disclosure process that would alter the sequence. Each gap an exercise finds is fixed here, or referred to the maintainer when the fix is not a documentation change.

The [path for an incident on a project-run service](#incidents-on-a-project-run-service) has not yet been walked. The next exercise walks it as well as the report path, against a simulated incident on one of those services.

| Date       | Scenario                                                            | Result                                              |
| ---------- | ------------------------------------------------------------------- | --------------------------------------------------- |
| 2026-08-15 | Simulated high-severity at-rest exposure report against a release   | 7 findings: 3 fixed here, 4 referred to the maintainer |

### 2026-08-15

**Scenario (simulated).** A researcher privately reports that on Windows the CLI writes the result CSV with an inherited ACL granting a second local account read access, so any user of that machine can read the linked records. This scenario is invented for the exercise and describes no defect in Alcove: the owner-only write path it imagines failing is specified in [CREDENTIAL_STORAGE.md](spec/CREDENTIAL_STORAGE.md). It was chosen because it is confirmable, platform-scoped, and severe enough to reach publication, so the walk covers every step rather than ending at a decline.

**Walked.** Steps 1 through 7 in order, against the repository as it stood on the exercise date: intake and acknowledgement, the severity call (High -- record data readable by a non-owner on the same host), affected versions (`v0.1.0`, the only signed release tag; no previous major exists on a `0.x` line), the hotfix path (branch from `v0.1.0`, fix, `v0.1.1`), advisory drafting and CVE request, and the reporter messages at each milestone.

**Findings fixed in this runbook:**

1. The supported-version rule does not resolve on a pre-1.0 line: with only `0.x` released, the previous-major row is empty and reads either as "nothing is supported" or as "everything older is". Step 3 states how to apply the rule until 1.0.
2. Following the hotfix procedure literally opens a public pull request with the fix diff, potentially days before the advisory publishes. The procedure is about mechanics and says nothing about when the fix becomes public. Step 4 states the sequencing, and the hotfix section points at it.
3. The advisory form's affected-products fields assume a package ecosystem, and this project publishes none, so an advisory drafted from it can end up without a machine-readable affected range. Step 5 records putting the versions in the description, and marks the form's behavior as unconfirmed until a real advisory is drafted.

**Findings referred to the maintainer:**

4. GitHub private vulnerability reporting -- the only intake path SECURITY.md names -- read as disabled when checked on the exercise date, so a reporter following the policy would find no way to file. The precondition check above exists so this is caught yearly rather than by a reporter.
5. No fallback intake channel is published anywhere in the repository. A reporter who cannot use the GitHub path, or who arrives while it is off, has nowhere to go but a public issue.
6. The release signing key is single-custody, and it is the only thing that gates a hotfix. That is what makes the maintainer-unavailable path communication-only, and whether it is accepted or mitigated is a decision for the owners rather than for this runbook.
7. The scope list in SECURITY.md covers the protocol, transport confidentiality, and credential parsing, but not the at-rest permissions of the artifacts Alcove writes -- the very class this exercise simulated. The interim reading is in step 2; whether the published list should name it is the maintainer's call.

Finding 6 was resolved after the exercise by a second holder: the co-owner holds a release signing key and can ship a fix ([Co-owner hotfix](#co-owner-hotfix)).
