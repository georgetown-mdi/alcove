---
reader: Everyone
---

# Find the people you have in common. Keep the rest of your records to yourself.

Alcove is open-source software that two organizations each run on their own machine or in their own browser. Choose your app and whether you are inviting or were invited.

| App | You are inviting | You were invited |
| --- | --- | --- |
| **Web app** In your browser, nothing to install. Runs with your partner live, once or on an agreed schedule. | [Invite with the web app](./web-invite.md) | [Accept with the web app](./web-accept.md) |
| **Console** A screen on your own machine, from the Docker image. For trying one exchange before moving it to the command line. | [Invite from the console](./console-invite.md) | [Accept in the console](./console-accept.md) |
| **Command line** A Docker or Podman container, run from cron or the Windows Task Scheduler. For recurring exchanges in a data pipeline. | [Invite a partner](./cli-invite.md) | [Accept an invitation](./cli-accept.md) |

Before anyone creates an invitation, settle with your partner what you match on, what each of you sends and who receives the result: [Agree on terms](./agree-on-terms.md).

## Your partner uses a different app

You and your partner do not have to use the same app. The inviter makes the kind of invitation the partner's app can accept:

| You use | Your partner uses | Who can invite | The invitation to make |
| --- | --- | --- | --- |
| Web app | Web app | Either of you | **Live, in this browser** |
| Web app | Console | Either of you | Web app: **Live, in this browser**. Console: the WebRTC channel. |
| Web app | Command line | Either of you | Web app: **Live, in this browser**; the partner runs `alcove accept` on the link. Command line: [Invite a partner](./cli-invite.md#if-your-partner-uses-the-console-or-the-web-app) on the WebRTC channel. |
| Console | Console | Either of you | Any channel |
| Console | Command line | Either of you | Console: any channel; the partner accepts with `alcove accept` ([Accept an invitation](./cli-accept.md)). Command line: [Invite a partner](./cli-invite.md#if-your-partner-uses-the-console-or-the-web-app) on the WebRTC channel; over SFTP or a shared folder, the console partner usually invites. |
| Command line | Command line | Either of you | Any channel |

> [!NOTE]
> The web app runs only WebRTC exchanges. The web app and the console run only an invitation that names its server, shared folder or coordination server; from the command line, that is one made as [If your partner uses the console or the web app](./cli-invite.md#if-your-partner-uses-the-console-or-the-web-app) shows.

## How an exchange works

1. The inviter creates an invitation: the agreed terms and a one-time secret.
2. The inviter sends it to the partner over a trusted channel, such as encrypted email, as a file or a link.
3. The partner reviews the terms and accepts.
4. You both run the exchange at the same time. Whoever starts first waits for the other: [how long each app waits](./agree-on-terms.md#timing).
5. Each of you keeps your own result, if the terms give you one, and an exchange record. Neither file leaves its owner.

A recurring exchange needs no new invitation: the two of you keep a shared secret that changes after every run.
