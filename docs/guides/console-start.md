---
reader: Anyone running one exchange from a screen on their own computer, inviting or invited
needs: Docker Desktop (or Docker Engine on Linux, or Podman), and a folder for this exchange holding your CSV file
partner: "[Home](./index.md#your-partner-uses-a-different-app), for which app your partner can use"
next: "[Invite from the console](./console-invite.md) or [Accept in the console](./console-accept.md)"
---

# Start the console

Set up and run one exchange from a screen on your own machine, first with test data, then with real data, then move it to the command line on a schedule.

## Start it

### 1. Make a working folder

Make a new folder for this one exchange, such as `C:\Users\you\Documents\alcove-state` or `~/alcove-state`, and put your CSV file in it.
This is your working folder: the console reads your file there and writes each run's results there.
It sees nothing outside this folder.

### 2. Run the start command in that folder

::: tabs platform

== Windows

Start Docker Desktop.
Open PowerShell from the Start menu, go to your folder, and run the command as one line:

```powershell
cd C:\Users\you\Documents\alcove-state
docker run --rm -p 127.0.0.1:3000:3000 --env JOB_DATA_ROOT=/work -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove:latest serve
```

Use PowerShell, not Command Prompt.

== macOS

Start Docker Desktop. Open Terminal, go to your folder, and run:

```sh
cd ~/alcove-state
docker run --rm -p 127.0.0.1:3000:3000 --env JOB_DATA_ROOT=/work -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove:latest serve
```

== Linux

Open a terminal, go to your folder, and run:

```sh
cd ~/alcove-state
docker run --rm -p 127.0.0.1:3000:3000 --user "$(id -u):$(id -g)" --env JOB_SFTP_CREDENTIAL_DIR=/tmp/alcove-sftp-credentials --env JOB_DATA_ROOT=/work -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove:latest serve
```

`--user` runs the console as your own account, so it can write into your folder.

== Podman

Rootless Podman needs the console's user mapped to yours. Go to your folder and run:

```sh
cd ~/alcove-state
podman run --rm --userns=keep-id:uid=1000,gid=1000 -p 127.0.0.1:3000:3000 --env JOB_DATA_ROOT=/work -v "${PWD}:/work" ghcr.io/georgetown-mdi/alcove:latest serve
```

Without `--userns`, the console cannot write into your folder and says "The console could not write the sample files into your folder, which may be mounted read-only."

:::

The first start downloads the image.

You should see: a line ending `Listening on http://0.0.0.0:3000`. That is the address inside the container; you open the one in the next step.

### 3. Open the console

In a browser on the same computer, open `http://127.0.0.1:3000`.

You should see: **Start a private data exchange**, with **Create an invitation** and **Have an invitation? Paste it here**.

> [!WARNING]
> The console has no login. Keep the port published on `127.0.0.1` only, as the command does: publishing it wider exposes the console, and your files, to everyone who can reach that address.

## Your working folder

Keep in it only this exchange's files:

- **Your CSV file.** The console lists the files directly in the folder, not in subfolders.
- **Each run's folder.** The console makes one per run, named by the run's id, such as `aea282aa-f2d3-40fc-b3de-e84c74ceb416`.
- **A WebRTC exchange's `alcove.yaml` and `.alcove.key`**, written straight into the working folder.
- **An SFTP password or key file**, if you keep it here. The console accepts it and warns you, since it writes results into the same folder.

To keep the credential file apart, put it in a folder of its own and add these two options before the image name in the start command. Then choose the file from that folder when you set up the connection.

```text
-v "C:\Users\you\Documents\alcove-secrets:/secrets:ro" --env JOB_SECRETS_DIR=/secrets
```

On macOS or Linux, write the folder as `/path/to/alcove-secrets`.

What else to add depends on how you and your partner exchange:

::: tabs channel

== SFTP

Nothing. The start command above is enough. The console needs to reach the SFTP server's address and port from this computer.

== Shared folder

Add the folder your sync tool shares with your partner as a second folder, with the name you both know it by. Put these options before the image name:

```text
--env JOB_RENDEZVOUS_DIR=/shared --env JOB_RENDEZVOUS_NAME=state-county -v "C:\path\to\shared-folder:/shared"
```

On macOS or Linux, write the folder as `/path/to/shared-folder`.
Without them, the console uses your working folder as the shared folder, and whoever syncs it gets your input, configuration and results.

== WebRTC

Nothing. The console needs to reach the coordination server, such as the Alcove web app's at `https://psi.data-bridge.org`.

:::

## Practice with sample data

On the start page, choose **See how it works with example data**.
It writes two files of made-up records into your working folder, then opens the invite screen:

| File | Records | Who uses it |
| --- | --- | --- |
| `alcove-sample-inviter.csv` | 100 | The party who invites |
| `alcove-sample-partner.csv` | 200 | The party who accepts |

A partner on the console chooses the same link in their own console; it writes both files each time.
A partner on the command line or in the web app has no sample link: send them the file they need from your working folder. The records are made up.
If you are accepting, go back to `http://127.0.0.1:3000` after it opens the invite screen, and paste the invitation there.
The invite screen also offers **Add sample files to my folder**, which writes the same two files. The accept screens offer no sample link.

Then follow [Invite from the console](./console-invite.md) or [Accept in the console](./console-accept.md) with these files.

## Then go live

After the practice run:

### 1. Each of you: clear the practice run

On its result screen, choose **Set up another exchange** and confirm. That deletes the practice run's folder.

### 2. Each of you: put your real CSV in the working folder

Keep the same folder and start command.

### 3. Each of you: move alcove.yaml and .alcove.key out of the working folder, for WebRTC

The console does not start a WebRTC exchange while either file is there.

### 4. Create a new invitation from the real file

Whoever invites creates it; the other accepts it as before.
The practice invitation's terms are sealed to the sample file.

## Stop or restart the console

To stop the console, press Ctrl-C in the window where you started it.

> [!WARNING]
> Stopping the console stops an exchange that is running, and the restarted console forgets it. Run it again with your partner. An invitation that was still waiting cannot be accepted any more: create a new one.

Each run's folder stays in your working folder.
When you start the console again and open it in the same browser, it shows **Files from an exchange before a restart**, naming the folder, with **Keep the folder** and **Discard the folder**.
**Keep the folder** leaves it for you to copy files out; **Discard the folder** deletes it.

A WebRTC exchange's `alcove.yaml` and `.alcove.key` stay in your working folder. Move both out before you start a new WebRTC exchange.
An SFTP connection you set up is forgotten when the console stops; set it up again.

More detail: [What the console keeps after a restart](../CONSOLE.md#restarting-cancels-and-forgets-the-exchange), [Every setting the console takes at start](../CONSOLE.md#turning-the-job-api-on).

## Use the launcher for a network folder

Docker cannot mount a mapped drive (`Z:\Exchange`) or a network path (`\\fileserver\exchange`).
If your working folder or shared folder is on one, use the launcher instead of the command. It asks for your folders, checks them, starts the console and opens it in your browser.

Download it from the assets of the latest Alcove release ([Where the releases are](../index.md#releases)): `Start-Alcove.ps1` with `Setup-AlcoveFileDrop.ps1` beside it on Windows, or `start-alcove.sh` on macOS or Linux.
Only a release copy runs.

::: tabs platform

== Windows

```powershell
powershell -ExecutionPolicy Bypass -File .\Start-Alcove.ps1
```

== macOS

```sh
bash start-alcove.sh
```

== Linux

```sh
bash start-alcove.sh
```

:::

More detail: [What the launcher sets up for a network folder](../DEPLOYMENT.md#the-user-the-image-runs-as).
