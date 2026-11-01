---
title: "Alcove Console"
---

# The Alcove console

The console is a graphical front end to the containerized `alcove` command-line tool, run on the operator's own machine. One container serves a browser interface on the host's loopback address, and a job API behind it drives the same CLI as a subprocess: an operator authors an exchange, starts it, watches it run, and downloads its result without writing a configuration file or assembling command-line arguments. It runs SFTP, shared-folder (`filedrop`) and WebRTC exchanges, each by starting the CLI; the exchange never runs in the browser tab. Intended readers are the IT staff or analysts who conduct an exchange from a single machine.

It is a prototyping tool: author one exchange, run it with test data and then real data, then move the recurring version to the plain CLI on a schedule (see [Graduating to a scheduled run](#graduating-to-a-scheduled-run)). It holds one exchange at a time, over mounted folders that hold that exchange's configuration, secret, input, and results. It has no authentication of its own, so it must be published only on the host's loopback address (see [Reachable only where you publish it](#reachable-only-where-you-publish-it)); the trust invariant is in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-console-trust-boundary). Where an operator's own layout or credential handling costs them something, the console warns beside the control rather than refusing to run.

This document does not cover the CLI's own commands and configuration files (see [CLI.md](CLI.md)), the field-level meaning of an exchange setting (see [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md)), or the deployment of the services an exchange runs over (see [DEPLOYMENT.md](DEPLOYMENT.md)).

## The image and the console build

The published image, `docker.io/gumdi/alcove` on Docker Hub and `ghcr.io/georgetown-mdi/alcove` on the GitHub Container Registry, is the console: it is built with `VITE_DEPLOYMENT_PROFILE=console`, so its web assets and its server-side job driver are the console halves, and the `-fips` variant is built the same way. You do not build web assets, set the profile, or build an image yourself. The hosted web deployment (`apps/web`, not this image) never runs an exchange server-side: a shared-folder or SFTP exchange there only saves an exchange file for the command-line tool.

## Running the container

Pass `serve` as the first argument to run the console instead of the headless CLI (see [Running the CLI](DEPLOYMENT.md#running-the-cli)). Publish port 3000 to the host loopback. Run it in the foreground and stop it with Ctrl-C when the exchange is done; results stay in the mounted directory.

`serve` starts one Node process that serves the web page and the job API on the same port. It listens on `PORT`, 3000 by default, at the address `HOST` names; the image sets `HOST=0.0.0.0` so that the published port reaches it, and outside a container the server binds `127.0.0.1` unless `HOST` says otherwise. On Ctrl-C it stops a running exchange, waits for its CLI to exit, and then exits. The variables, including the shutdown timeout, are in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#environment-variables).

For a shared-folder exchange, mount your working folder and the shared folder separately:

```sh
docker run --rm -p 127.0.0.1:3000:3000 --env JOB_DATA_ROOT=/data -v "/host/work:/data" --env JOB_RENDEZVOUS_DIR=/shared --env JOB_RENDEZVOUS_NAME=agency-a-agency-b -v "/host/agency-a-agency-b:/shared" docker.io/gumdi/alcove:latest serve
```

The operator drops their input CSVs into `/host/work`; `/host/agency-a-agency-b` is the folder their sync tool shares with the partner.

For an SFTP exchange, which syncs no folder with the partner, leave out the three shared-folder flags: the two `JOB_RENDEZVOUS_` variables and the second `-v`. A shared-folder exchange still runs on the single mount, out of `JOB_DATA_ROOT`, but then whoever syncs that folder gets your input, configuration, and results; the console warns where you choose the transport, with the flags to add to your `docker run` command just before the image name, and when the run starts (see [The input folder](#the-input-folder)).

Inputs can have a mount of their own, which can be read-only. In a Mac or Linux terminal only, where a `\` ends each line, run:

```sh
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  --env JOB_DATA_ROOT=/data/jobs \
  --env JOB_INPUT_DIR=/data/input \
  --env JOB_RENDEZVOUS_DIR=/data/rendezvous \
  --env JOB_RENDEZVOUS_NAME=agency-a-agency-b \
  -v "/host/jobs:/data/jobs" \
  -v "/host/input:/data/input" \
  -v "/host/agency-a-agency-b:/data/rendezvous" \
  docker.io/gumdi/alcove:latest serve
```

A partner-shared mailbox of two folders (see [Split inbound and outbound shared folders](#split-inbound-and-outbound-shared-folders)) mounts and names both. In a Mac or Linux terminal only, where a `\` ends each line, run:

```sh
docker run --rm \
  -p 127.0.0.1:3000:3000 \
  --env JOB_DATA_ROOT=/data/jobs \
  --env JOB_INPUT_DIR=/data/input \
  --env JOB_RENDEZVOUS_DIR=/data/rendezvous-in \
  --env JOB_RENDEZVOUS_OUTBOUND_DIR=/data/rendezvous-out \
  --env JOB_RENDEZVOUS_NAME=agency-b-to-agency-a \
  --env JOB_RENDEZVOUS_OUTBOUND_NAME=agency-a-to-agency-b \
  -v "/host/jobs:/data/jobs" \
  -v "/host/input:/data/input" \
  -v "/host/from-agency-b:/data/rendezvous-in" \
  -v "/host/to-agency-b:/data/rendezvous-out" \
  docker.io/gumdi/alcove:latest serve
```

`JOB_CLI_BINARY` is pre-set in the image. Setting `JOB_DATA_ROOT` turns the job API on; unset, `serve` runs the web UI only. The account the container runs as, and the ownership each mount needs, are in [The user the image runs as](DEPLOYMENT.md#the-user-the-image-runs-as).

## Reachable only where you publish it

The API has no authentication and no token, so it must be reachable only from the operator's own machine. Inside the container the server listens on every interface; what can reach it is decided by how you publish the container's port and by the host firewall.

| Publish binding | Who can reach the API |
| --------------- | --------------------- |
| `-p 127.0.0.1:3000:3000` (the supported default) | The operator's own machine only, on Linux, macOS, and Windows, Docker Desktop included |
| `-p 3000:3000`, without the `127.0.0.1:` prefix | Every interface of the host |
| A reverse proxy in front of the loopback port | Everyone the proxy admits |

The last two are the operator's explicit choice, not a supported console default.

The app also requires the request's `Host` header to name a loopback address (`127.0.0.1`, `localhost`, or `::1`) and refuses any other with `403`, which blocks DNS rebinding of the loopback API from a browser. A reverse-proxy or LAN-name front works only once its hostname is listed in `JOB_ALLOWED_HOSTS` (see [Turning the job API on](#turning-the-job-api-on)).

## Turning the job API on

The job API is **off by default**: it serves no endpoint and spawns no CLI until a data root is set. The app refuses to serve the job routes in a hosted build even with `JOB_DATA_ROOT` set, so only the `console` build profile, which the published image has, can expose it. The variables:

- `JOB_DATA_ROOT` -- the directory under which each job's working files are created. Set it to turn the API on. The input and shared folders default to it, so one mounted directory with only this set runs a full console.
- `JOB_INPUT_DIR` -- the folder the console lists and profiles for this party's input CSVs; the CLI reads the selected file in place (see [The input folder](#the-input-folder)). Falls back to `JOB_DATA_ROOT`.
- `JOB_RENDEZVOUS_DIR` -- the mounted shared folder a shared-folder (`filedrop`) exchange runs over. Falls back to `JOB_DATA_ROOT`; a separate mount is recommended. On a console that also sets `JOB_RENDEZVOUS_OUTBOUND_DIR`, this is the **inbound** folder, the one your partner writes into, and is required.
- `JOB_RENDEZVOUS_OUTBOUND_DIR` -- optional; the **outbound** folder this party writes into, for a split pair (see [Split inbound and outbound shared folders](#split-inbound-and-outbound-shared-folders)). It has no fallback. Set without `JOB_RENDEZVOUS_DIR`, the console reports the missing variable and offers no shared-folder exchange.
- `JOB_RENDEZVOUS_NAME` -- optional; the name of the shared folder as you and your partner know it, which a shared-folder invitation gives as its advisory locator and the accept kit prints. Unset, the console takes the mount point's last segment, so set it when the mount point is named for the container's layout (as `/data/rendezvous` is above, or as a launcher's fixed path is). A value that is not a plain folder name leaves the console with no name: the invitation still holds a locator, and the accept kit prints no folder name.
- `JOB_RENDEZVOUS_OUTBOUND_NAME` -- the same, for the outbound folder. The two names must differ, so set it when the two mounts' last segments coincide (`/mnt/in/alcove` and `/mnt/out/alcove`); until they differ the console offers no shared-folder exchange, naming this variable.
- `JOB_SECRETS_DIR` -- optional; a directory, mounted read-only, that the console browses for a connection's credential file (a password file or an SSH private key) and for the file holding your signing identity. It has no fallback. Unset, the credential picker browses your mounted folder, with a warning, and the signing identity's picker offers no folder. The console writes nothing into this mount, with one exception: a signing identity removed between the console's presence check and its read is created again at that path, which a read-only mount prevents.
- `JOB_SFTP_CREDENTIAL_DIR` -- the container-internal directory a pasted credential is written to. Leave it unset under the image's own account; set it when you run the container with `--user` ([The user the image runs as](DEPLOYMENT.md#the-user-the-image-runs-as)).
- `JOB_IMAGE_REGISTRY` -- optional; the registry the image was downloaded from, `docker.io` or `ghcr.io`, which the commands the console shows for a scheduled run name, so they pull from a registry this machine reaches. The launchers set it to the registry they downloaded from. Unset, or any other value, the console names `docker.io`, and a value it does not read draws a startup warning naming the variable.
- `JOB_IMAGE_DIGEST` -- optional; the digest of the image the console runs, `sha256:` followed by 64 lowercase hex digits, which the partner accept kit prints beside the image on each registry. The launchers set it to their stamped digest. Unset, or any other value, the kit names no digest and points at the release notes for it.
- `JOB_ALLOWED_HOSTS` -- optional; a comma-separated list of extra `Host` header hostnames the API accepts beyond `127.0.0.1`, `localhost`, and `::1`. Set it only to front the console behind a reverse proxy or reach it by a LAN name, listing the hostname the browser sends (the port is ignored). It does not widen reach on its own: the publish binding and the host firewall still decide who can connect.

The resolution rules are normative in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md).

### The input folder

The console lists this party's input CSVs out of `JOB_INPUT_DIR`, or `JOB_DATA_ROOT` when that is unset. It profiles the file you select -- its columns, a bounded per-column sample of values, and per-field coverage -- and the CLI reads that same file in place. No copy is made.

- **The listing is non-recursive.** Mount the directory that holds the CSVs, not a parent. Dot-prefixed files and subdirectories (the per-job working directories) are not shown, nor are `alcove.yaml` and its saved copy, the exported signing certificate, a shared-folder exchange's files, and the credential and signing-identity files your configuration points at.
- **Nothing is written to the input directory** unless you ask for the sample files. Mount it read-only to state that at the mount; the container's account must still be able to read the inputs.
- **Sample files.** **Add sample files to my folder**, under the file list, and **See how it works with example data** on the landing page write `alcove-sample-inviter.csv` and `alcove-sample-partner.csv`, two CSVs of synthetic records. Choose the inviter file to practice; to run both sides, create a WebRTC invitation with the web app's coordination server ([Running a WebRTC exchange](#running-a-webrtc-exchange)) and accept it in the public web app with the partner file. A file already at either name is left as it is. On a read-only mount the console offers them as a download instead.
- **The field separator.** "How your file separates fields" offers the comma, other common separators, and a detect option. The console profiles the file by that choice and states it as [`csv_delimiter`](EXCHANGE_REFERENCE.md#csv_delimiter) in the configuration it composes, or as `--csv-delimiter` for a quick exchange. Changing it re-profiles the file and asks you to confirm the columns again.

A shared-folder exchange runs over `JOB_RENDEZVOUS_DIR`, or `JOB_DATA_ROOT` when that is unset. The sync runs both ways, so on the single-folder layout your input, configuration, and results go to your partner. Give the shared folder a dedicated mount, separate from and not nested with the working directory. The console warns, and still runs, in these cases:

- Where you choose the shared-folder transport on a single-folder console. When creating an invitation it also names the folder as the invitation will give it, which on that layout is the container's mount point.
- At job start, once per shared folder that is the working folder, naming `JOB_RENDEZVOUS_DIR`, and a narrower warning for a shared folder nested inside the working folder.
- At job start, when the shared folder holds an earlier exchange's files, naming them. An exchange refuses to start on such files, which a retain-mode run leaves after finishing normally. Turn on "Clear leftover exchange files before starting" ([Diagnosing a run that misbehaves](#diagnosing-a-run-that-misbehaves)) or delete them on the host. Files that are not an exchange's -- inputs, configuration, results -- raise no warning; the exchange's filename grammar decides which files count.

Every console surface that watches a run shows these warnings. The console escapes each warning and caps its displayed length, so a long one, usually relayed from the CLI, can be shown abbreviated.

### A column name the console cannot record

The console bounds the length of every declared column name. A header past
that bound stops the exchange from starting and the cleaning coverage check
from running over a step that reads that column. Each names the column by its
position, shows the name, and states the bound; the fix is the header row. The
bound is in
[PARSED_INPUT_BOUNDS.md](spec/PARSED_INPUT_BOUNDS.md#application-layer-parsed-input-bounds).

### Split inbound and outbound shared folders

Some deployments bridge two folders: this party reads its partner's files out of an **inbound** folder and writes its own into an **outbound** one. Set both `JOB_RENDEZVOUS_DIR` (inbound) and `JOB_RENDEZVOUS_OUTBOUND_DIR` (outbound), and every shared-folder exchange uses that pair, composing the CLI's `inbound_path`/`outbound_path` ([FILE_SYNC.md](spec/FILE_SYNC.md#split-inboundoutbound-directories)).

- **Both variables are required.** With either missing, the console offers no shared-folder exchange and names the missing variable. `JOB_DATA_ROOT` never stands in for the inbound folder.
- **It requires retain mode.** The console holds the exchange until you choose to keep every exchange file, and the CLI refuses the pair without `--retain-files`. An earlier exchange's files in either folder are ignored, as long as each run writes new file names ([Directory exclusivity](EXCHANGE_REFERENCE.md#directory-exclusivity)).
- **The two folders must differ, and neither may sit inside the other.** The console offers no shared-folder exchange until they do, naming the variable to move.
- **Each folder needs a name, and the names must differ** (`JOB_RENDEZVOUS_OUTBOUND_NAME`).
- **Your partner runs the mirror image.** The accept kit gives them the two-folder commands and routes a partner on a network drive to the Windows launcher ([DEPLOYMENT.md](DEPLOYMENT.md#the-user-the-image-runs-as)).

Both folders are partner-synced: keep them out of the working directory, and keep credential files out of both. The job-start checks run over each folder and name which one a notice is about.

## Opening a configuration from your folder

If you already run this exchange with `alcove` on the command line, choose **Open the configuration in my folder** on the first step. The console reads the `alcove.yaml` in your working folder (`JOB_DATA_ROOT`); nothing is uploaded from your browser, and no container path is shown.

- **The run continues the exchange your configuration set up.** It uses the `.alcove.key` beside `alcove.yaml`, so no invitation is made and your partner runs their side as usual. The secret rotates once the terms are agreed on and is written back to that file; it never reaches your browser.
  - With no readable `.alcove.key` beside it, the console says which problem it is. Put the key file back and open the configuration again, or choose **Create an invitation from these settings** to start a new exchange with the same terms and connection.
  - An SFTP or shared-folder run uses the file as you opened it; if `alcove.yaml` changes afterwards, a warning names the file.
- **Every step starts filled in**: connection, matching terms with your column roles and cleaning steps, file handling, connection tuning, field delimiter, receipts, retention note, and the inactivity limit. A setting the file omits keeps the console's default.
  - Your partner holds the terms your file states. If you change them here, the review step warns you and names the way to change them with your partner: edit `alcove.yaml`, run [`alcove update`](CLI.md#changing-the-terms-of-an-established-partnership), and have your partner run `alcove apply`. Changing your own name draws no warning. No invitation duration is offered.
  - The linkage keys are your file's, so Matching keys does not offer the precision choice ([Choosing the matching keys](WEB_APP.md#choosing-the-matching-keys)).
- **You supply the credential again.** No credential value leaves the console's server, so the connection step opens on your file's sign-in method with the credential empty.
- **A setting the console has no control for is kept unchanged** and named beside the load -- each side's disclosure commitments, prior consent, what it receives, and how it matches. Edit those with `alcove` on the command line.
- **Your file's paths stay yours until you convert them.** The scheduled-run hand-off states your file's shared folder, signing identity, and SFTP credential file references (`@path`) as written; an inline credential is shown as a placeholder. Converting them to the console's own paths is a separate step offered beside the load, which names each setting it replaces.
  - The run always uses the shared folder you mounted.
  - A signed run waits for the conversion when your file names its own `signing.identity_file`, since the console signs only with its own identity. Turn the receipt off to run unsigned, or run the file on the command line.
  - After conversion, the hand-off shows placeholders for the folder, credential files, and signing identity. Close the configuration and open it again to return to your file's paths.
- **The inactivity limit is applied as the command line applies it.** A file stating `authentication.token_max_age_days` opens with **shared secret expires after inactivity** on and **Days of inactivity** set; a run after that many days without a successful run is refused, naming the re-invitation to make.
- **The channel is your file's.** Where this console cannot run it -- a shared-folder exchange with no shared folder mounted -- the notice says so and the review step offers another way.
- **A file the console cannot open is refused whole**, naming the settings as your file spells them. An SFTP file with a `connection.server.provision` block is refused: run it on the command line. A `webrtc` file with a create-mode `provision` block and no `host` is refused until `alcove invite` fills it ([On-demand server provisioning](EXCHANGE_REFERENCE.md#on-demand-server-provisioning)).
- **A `webrtc` configuration runs in place**, as `alcove exchange` runs it. The review step chooses **over WebRTC, run here** and shows the file's coordination server; to change it, edit `connection.server` and open the configuration again. **Start the exchange** first saves any change on the steps into `alcove.yaml`, then runs it with the `.alcove.key` beside it, so the secret rotates in that file and a partner's pin is recorded in `alcove.yaml`. Discarding the run never removes either file.
  - The run contacts what the file names: its coordination server, STUN and TURN servers, its relay registrar where `connection.relay_registrar` names one, and a start-mode provisioning endpoint before each exchange.
  - It relays through its `connection.turn` entries and then `connection.invitation_relay`, each where `connection.allowed_relays` keeps it. The review step shows these but does not edit them. A file naming a registrar adds the step of running `alcove enroll-relay` before the first run ([Registering the relay key at your relay](CLI.md#registering-the-relay-key-at-your-relay)); url-only `turn` entries with no registrar mean the relay's owner registers the key.
  - **Start the exchange** is not offered for a file stating `connection.ice_provision` (the CLI runs none), for a file with no usable `.alcove.key`, or for one naming a signing identity other than the receipts card's. **Create an invitation from these settings** is not offered either, since it would write a new `alcove.yaml`.
  - The save is refused, and nothing runs, when `alcove.yaml` changed since you opened or last saved it, or the console restarted; **Open alcove.yaml again** reloads it. The run does not start if the file is gone, unreadable, or now names another channel.
  - With nothing changed, starting writes nothing and your file keeps its comments and layout. A save that changes the file rewrites it the way `alcove` does, without your comments, key order, or quoting ([EXCHANGE_FILE.md](spec/EXCHANGE_FILE.md#writing-a-configuration-back)), first copying it to `alcove.yaml.previous` unless the console wrote that copy itself. Both files keep the original's permissions but are owned by the console's account. Its `connection` is written back exactly, credentials included; the browser is shown only the coordination server and relay urls. Starting a signed run for a file naming no identity writes the console's container path, which a run outside the container must change.
- **Close it to author from scratch.** **Close this configuration** drops everything it filled in. The field delimiter of a chosen file stays.
- **An exchange whose invitation is created, or whose run has started, takes no configuration.**

The terms, column roles, and cleaning steps are reapplied to whichever input file you pick. Where the file lacks a column the configuration describes, or a column is named both as record identifier and as sent, the columns step holds what your columns support and the notice names the setting. A column your configuration's roles do not name is kept back, as on the command line. The request and what it discloses: [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#loading-a-configuration-from-the-mount).

### When your partner's terms change

The console runs `alcove` with no terminal, so a run whose partner changed its terms stops before any linkage key or data moves, and the run screen shows the change. What is shown, and why the run stops: [CLI.md](CLI.md#when-your-partners-terms-change).

- **For a run of a configuration you opened**, **Apply to alcove.yaml** runs `alcove apply --consent-to-terms` on the kept terms, against the `alcove.yaml` and `.alcove.key` in your folder; choosing Apply is your consent ([Applying an update](CLI.md#applying-an-update)). The command line writes the file and its exit code tells the console whether it applied. **Review the updated terms** then reopens the configuration at the review step.
  - Apply is refused, and nothing is written, when `alcove.yaml` changed after you opened it (for `webrtc`, after the run started), or when the run used terms you changed on these pages. Apply from the command line, or start over.
  - **Start over** leaves `alcove.yaml` as it was; the next run stops the same way until your partner returns to the agreed terms.
- **For any other run** there is no file to apply the change to: agree on the terms with your partner and start over.

The endpoint contract is in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#applying-a-partners-terms-change).

## Quick exchange: no invitation

The lobby's "Skip the invitation" card opens a quick exchange, for when both parties agreed on a server or shared folder out of band. Each operator picks their own input file, confirms the linkage terms and sent columns the CLI infers from it, affirms the trust model below, and the console runs the CLI's [quick exchange](CLI.md#quick-exchange) command. Columns sent are every column whose name Alcove does not recognize as a linkage key or an id column ([inference table](EXCHANGE_REFERENCE.md#input-metadata)); header case, edge whitespace, and `-`, `.` or whitespace between words do not matter, so `First Name` counts as `first_name`, but `Given Name` or `E-mail` is sent. To choose the columns sent, use an invitation instead.

- **Linkage strategy:** `cascade` (default) or `single-pass`, which both parties must choose alike; passed to the hand-off as `--linkage-strategy`.
- **Duplicate matches** ([`deduplicate`](EXCHANGE_REFERENCE.md#linkage_termsdeduplicate)): yours alone, off by default; passed as `--deduplicate`. The step names a combination that could not run (both sides under single-pass).
- **It always uses the keys marked less certain** where your file has first name, last name, and date of birth; the preview marks them `(less certain)` ([Rules marked less certain](EXCHANGE_REFERENCE.md#rules-marked-less-certain)). To leave them out, use an invitation.
- **SFTP and shared-folder channels only.**
- **Trust rests entirely on the transport.** There is no shared secret and no application-layer encryption, so the SSH connection or the shared folder's access controls protect the exchange ([Bootstrapping a shared secret](SECURITY_DESIGN.md#bootstrapping-a-shared-secret)).
- **Each party still writes its own self-attested exchange record.**

The confirm step names your record identifier: the first column whose name Alcove treats as an identifier (such as `id`, `client_id`, or `Client ID`), a record number such as `case_number` only when no id column of another kind follows it. With none, the result's first column is `row_id`, numbering rows from 0 ([The result file](CLI.md#the-result-file)). The intent and argv: [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#the-zero-setup-intent).

## Authoring the SFTP connection

There is no deploy-time provisioner. One SFTP connection is effective at a time, authored in the console: host, username, remote directory, the required host-key fingerprint, and a credential.

- **Credential.** **Choose the credential file** browses `JOB_SECRETS_DIR`, or your mounted folder when no secrets directory is mounted. A typed reference is a path inside the container, such as `@/secrets/sftp-password.txt`. A file reference is resolved only by the CLI child at exchange time and never passes through the web server.
  - A credential file inside `JOB_DATA_ROOT` is allowed with a non-blocking warning, since that folder is written during the exchange and could be synced. To isolate it, mount its folder read-only as the secrets directory (`-v <that folder>:/secrets:ro --env JOB_SECRETS_DIR=/secrets`).
  - A pasted value crosses the loopback API and is written to an internal, owner-only location -- never the data root or the shared folder -- that is wiped at every startup and deleted when the connection is cleared or replaced, or when you open an SFTP invitation on the accept screen.
- **Sign-in method.** A private key takes an optional passphrase reference. A password takes an optional toggle to answer the server's login prompts with it (`--server-keyboard-interactive`). A companion set against the other method is refused at the form.
- **Split directories.** A server with distinct drop and pickup folders takes **separate inbound and outbound directories**, the console's form of `--outbound-path`; the two must differ and need retain mode.
- **Host-key fingerprint.** Always a literal pin; the console never prompts to trust a host key. **Read the fingerprint from the server** fills the field from the key the server presents, without sending a credential. It reads the key over the same network the exchange uses, so compare it with the value the server's operator published before you use it. A quick exchange, which has no shared secret, also asks you to confirm that you checked the fingerprint against a source other than this connection. To stage a rotation, list the old and new fingerprints together. Trust behavior: [SFTP host-key trust](CLI.md#sftp-host-key-trust).
- **Quick exchange limits.** A remote directory that is `/` or has a `.` or `..` part is refused, since the `sftp://` URL cannot state it; a saved connection with such a directory, or with more than one fingerprint, cannot run a quick exchange until edited.

The connection is held in memory until you clear it, open an SFTP invitation on the accept screen, or restart the console. **Try again**, the next invitation, and the next quick exchange reuse it. Opening an SFTP invitation clears it, with any pasted credential, once the invitation decodes and reaches the review step; an invitation refused while decoding leaves it.

The container needs network egress and DNS to the server's host and port; how to confine it to that endpoint is in [Restricting the container's outbound network access](DEPLOYMENT.md#restricting-the-containers-outbound-network-access). The request and validation rules: [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#authoring-the-sftp-connection).

## Running a WebRTC exchange

Choose **over WebRTC, run here** on the review step to have the console's `alcove` connect to your partner, who accepts in the web app or with `alcove accept`. Set the coordination server beside that choice:

- **The address starts empty.** Type a coordination server's `wss://` address, or a web app's `https://` address, from which the console reads `/alcove.json` as `alcove invite` does.
- **Use the Alcove web app's server** fills in `https://psi.data-bridge.org`: your partner accepts there, and both computers contact its coordination server. What it observes: [PRIVACY.md](../PRIVACY.md#what-supporting-services-can-observe).
- **A web app's address gives a link to share**; a coordination server's own address gives the invitation as text only. Neither links to this console.
- **A `ws://` address is allowed, with a warning**, for a server on this machine. The invitation does not record the scheme, so your partner's side connects over `wss://`.
- **A server on this computer or local network is named as such**, since a partner elsewhere cannot reach it.

**A relay is set beside the coordination server.** The console has no Relay server page; opening `/relay` starts a new invitation. **Set a relay** opens fields for TURN servers, a WebSocket relay, and a relay registrar with its exchange id; **Done** closes them, and the line then names the relay with **Change** and **Remove**. With no relay, the run connects directly, and a network that blocks direct connections on either side stops it.

- **TURN:** one `turn:` or `turns:` url per line, such as `turns:relay.example.org:443?transport=tcp` ([`connection.turn`](EXCHANGE_REFERENCE.md#connectionturn)). A url with a user, password, or query parameter other than `transport` is refused; each run presents a credential derived from the shared secret. The run's `alcove.yaml` lists each as a url-only `connection.turn` entry, and the invitation names them for your partner.
- **Registrar:** for a relay running the reference registrar ([infra/relay/README.md](../infra/relay/README.md#the-registrar)), set its `https://` address and an exchange id; the run's `alcove.yaml` names them as [`connection.relay_registrar`](EXCHANGE_REFERENCE.md#connectionrelay_registrar), and each run registers its rotated key. The review step states the enrollment: after **Create the invitation** writes `alcove.yaml` and `.alcove.key`, and before your partner connects, run `alcove enroll-relay` in that folder with the relay-owner token ([Registering the relay key at your relay](CLI.md#registering-the-relay-key-at-your-relay)). With no registrar, the relay's owner registers the key.
- **WebSocket relay:** one `wss://` url, such as `wss://relay.example.org/relay` ([`connection.websocket_relay`](EXCHANGE_REFERENCE.md#connectionwebsocket_relay)), with or without TURN urls. The run dials it as it starts and moves onto it only when no other connection opens ([A WebSocket relay of your own](CLI.md#a-websocket-relay-of-your-own)). It needs the exchange's key enrolled too; a registrar needs a TURN url beside it, so a WebSocket relay set alone is enrolled by its owner.
- Only invitations you create use this relay.

The container needs outbound access to the coordination server, to a STUN server (the command line's default unless set), to each relay and registrar set, and to your partner's computer; the full list is in [Network requirements](DEPLOYMENT.md#network-requirements).

The address and relay are held in memory, without credentials, until you clear them or restart. **Create the invitation** rereads them; if they changed since the page showed them, no invitation is created, and a run whose invitation names another server or relay does not start. Contract: [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#the-coordination-server).

When the run starts, the console writes `alcove.yaml` and `.alcove.key` into your working folder, readable only by the console's account, and runs `alcove exchange` on them. Until your partner connects, `.alcove.key` holds the invitation's shared secret; once they connect, the exchange replaces it and records your partner's pin in `alcove.yaml`, so the same folder runs again with `alcove exchange` ([Graduating to a scheduled run](#graduating-to-a-scheduled-run)).

- **An existing exchange is not overwritten.** With either file already in the working folder, the run does not start. Move both out to start a new exchange.
- **Trying again continues the folder's exchange.** **Keep waiting** and **Try again** run only while `alcove.yaml` is as this invitation's last run left it and `.alcove.key` is either as that run left it or still holds the original secret. A file you swap in while a run is in progress cannot be told apart, and a retry runs over it.
- **A working folder the console cannot write** stops the run before it starts.
- **After a restart, trying again is refused**, since what the files held was recorded in memory. Run the folder with `alcove exchange`, or move the files out.
- **Discarding a run that never reached your partner** removes both files, only if both are exactly as the run wrote them. A run you do not discard leaves both files in the folder, with the invitation's shared secret in `.alcove.key`. **After your partner connected**, nothing is removed, and **Start over with a fresh invitation** is refused until you move them out.
- **An open SFTP or shared-folder configuration withholds this choice**; an open `webrtc` configuration selects it ([Opening a configuration from your folder](#opening-a-configuration-from-your-folder)).

A WebRTC exchange offers no file-handling settings and no check interval.

### Checking the relay

The console can run `alcove doctor relay` ([Checking the relay of a WebRTC exchange](CLI.md#checking-the-relay-of-a-webrtc-exchange)) over the `alcove.yaml` and `.alcove.key` in your working folder, to learn whether the TURN relay a run uses gives this container a relay address, and whether each WebSocket relay a run dials admits it. It is offered:

- **Before a run**, under an open `webrtc` configuration that lists a TURN server.
- **After an attempt that failed or that your partner did not join**, beside **Try again** and **Keep waiting**.

It is never offered while a run is in progress, and the console refuses to start one while an exchange is running over those files or another check is running.

- **Nothing is contacted until you start the check.** **Check the relay** first lists the hosts the check contacts, and the relays the configuration names that it does not contact and why. **Start the check** runs it. If `alcove.yaml` changed since the hosts were shown, the console contacts nothing and says so: review the hosts, then start the check again.
- **The result is in the command line's words**: each check with what it found, what that means, and what to do. Where the relay's registrar refused the key, the console omits the registrar's own answer; run `alcove doctor relay` in the working folder to see it.
- **The WebSocket relay is checked too**, where the configuration names one, and its answer is shown beside the TURN relay's. A configuration whose only relay is a WebSocket relay is offered the check after a failed attempt, not before a run, since the offer before a run follows the configuration's TURN servers.
- **A relay that does not answer is reported after 30 seconds.** A check still running after 45 seconds is stopped, and the console says so.

Contract: [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#checking-the-relay).

### Accepting a WebRTC invitation

A WebRTC invitation from the web app or from `alcove invite` is accepted on the console as `alcove accept` accepts it; the console's `alcove` runs the exchange.

- **The invitation names the coordination server**, shown under **How this console connects**. The console connects over `wss://`, unless it already holds that same `ws://` address as a test server, which it then shows as not encrypted.
- **The invitation's relay is used as `alcove accept` uses it**: its TURN and STUN servers, with a derived credential, and enrollment at its registrar before connecting when the run uses that relay ([the stated limit](spec/PROTOCOL.md#the-invitations-relay-locator)). With no relay named, a network that blocks direct connections stops the exchange.
- **Allowed relays** appear where the invitation names a TURN server or WebSocket relay: **Set Allowed relays** takes one relay host per line, with a port where needed ([`connection.allowed_relays`](EXCHANGE_REFERENCE.md#connectionallowed_relays)). They start unset for every invitation, including after a reload. While set, the terms mark each of the invitation's relays kept or left out; **Continue** takes the list, and a retry over this invitation's files writes it into their `alcove.yaml`, removing `allowed_relays` when the field is empty.
- **Starting the exchange sets the console to that server**, replacing your own coordination server and relay. Invitations you create afterwards use that server but not the invitation's relay, and offer no link until you set a web app's address again.
- **The files go into your working folder**: `alcove.yaml` (with `role: acceptor`, the relay as `invitation_relay`, and any `allowed_relays`) and `.alcove.key`, under the rules in [Running a WebRTC exchange](#running-a-webrtc-exchange).

The consent and columns steps are those of an SFTP or shared-folder invitation, without the file-handling settings, the check interval, or the leftover-file sweep.

## Choosing how the exchange handles its files

Every flow that runs an SFTP or shared-folder exchange offers "How files are handled", collapsed by default. It holds the CLI's file-handling settings:

- **Keep every exchange file** (retain mode, `--retain-files`) leaves the exchange's files as a permanent transcript in the shared folder -- on SFTP the remote directory, on a shared folder the folder your partner also holds. Nothing removes it afterwards. It also turns on timestamped filenames and **Lockless rendezvous**, which it requires.
- **Timestamped filenames** and **Lockless rendezvous** (acknowledgement files instead of a lock file) can each be set alone, for a sync tool that cannot create a file exclusively or pass a deletion on promptly.
- **A name for this side** labels every file this party writes; the two sides must differ, and it needs timestamped filenames.
- **If an unrecognised file appears** sets what happens when a foreign file turns up mid-run. It has no CLI flag, so quick exchange does not offer it.
- **Write files without renaming them** (`--write-without-renaming`) is for a server that does not allow renames; it is safe only where the folder never passes a partly written file to your partner ([Setting `write_without_renaming`](EXCHANGE_REFERENCE.md#setting-write_without_renaming)). Your partner need not set it.

Retain mode and lockless rendezvous must match on both sides; a mismatch stops the exchange when the two sides meet. The console states this when you turn retain mode on and blocks a combination the exchange would reject. With retain mode on, a later exchange can reuse the shared folder: the run ignores the files an earlier one kept, as long as each run writes new file names. A fixed name for this side repeats the same names, so leave it blank or give `peer_id` date and time fields in a configuration file, such as `site-%Y%m%d%H%M%S`. Without retain mode, an exchange starts from a folder holding no exchange files, or clears them first with the sweep below. The settings: [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#sftp-and-shared-folder-options).

## Tuning the connection

"Connection tuning", also collapsed, holds the CLI's connection settings. A blank field takes the default its placeholder shows; the defaults are in [Shared options](EXCHANGE_REFERENCE.md#shared-options) and [SFTP and shared-folder options](EXCHANGE_REFERENCE.md#sftp-and-shared-folder-options).

- **How often to check for your partner's files** -- the poll interval. Not offered for WebRTC.
- **How long to wait for your partner** and **how long to wait for each connection attempt** -- the peer and connect timeouts. The connect timeout is per attempt. Neither may exceed seven days.
- **How many times to retry a failed connection** -- the reconnect budget.
- **When to ignore a partner hello file nobody answered**, and **Never ignore an unanswered hello file** -- the unanswered-hello window, which applies when exchange files are kept. Blank takes this side's partner wait; it may not exceed seven days. Not offered for WebRTC. See [Directory exclusivity](EXCHANGE_REFERENCE.md#directory-exclusivity).
- **Open a new connection for each check** -- SFTP only; for a server that limits how long a connection may stay open. It is this side's choice alone.

Checking more than once a second, and a new connection per check at an interval under a minute, each draw a notice, not a block. These settings pass into the scheduled-run hand-off. Flags: [CLI.md](CLI.md).

## Diagnosing a run that misbehaves

"Diagnostics and recovery", collapsed, applies to the next run only:

- **Record a detailed log of this run** runs the CLI at its most detailed log level and offers the log as a download beside the run's results or failure, and on the reconnect panel. The log can name your partner, the linkage keys, and the columns; treat it like the results. Discarding the run removes it.
- **Clear leftover exchange files before starting** is `--sweep-exchange-files`: before the run meets your partner, the CLI deletes the exchange's own leftovers -- hellos, locks, acknowledgements, messages -- and nothing else. The console asks you to confirm no other session is using the directory. A run that reports its transport close did not finish says so beside its result, and the next run needs this sweep.

A directory holding a **retain-mode transcript** refuses the sweep. The console says so before you start and names the command-line escalation, `--sweep-exchange-files --force-retain-sweep`, which deletes the transcript permanently; it offers no one-click version. The CLI's reason appears in a detailed log.

## Signing a receipt, and noting where the result is filed

"Receipts and record keeping", collapsed, holds two audit settings. Every exchange already writes an unsigned record of what it did. Custody of the signing identity is described in [SECURITY_DESIGN.md](SECURITY_DESIGN.md#custody-and-persistence), and its container mounts in [Mounting the signing identity](DEPLOYMENT.md#mounting-the-signing-identity).

- **What this exchange produces.** "No receipt", or a **signed receipt** (`signing.mode: certificate`): both parties sign the same terms and data-flow facts, so a third party can check the exchange later. **Session-derived** is shown but not selectable; an exchange asking for one is refused.
- **The receipt** is written as `alcove-receipt-<time>.json` with the run's files and offered as a download beside the result, beside a failure (the receipt is written before the result, so it can survive a failed write), and on the reconnect panel. A run that produced none says so. Discarding the run removes it.
- **Where your signing identity is kept** (`signing.identity_file`): your working folder, the default, where the console creates the identity on demand; or a file you pick in the secrets directory. You pick rather than type, and the browser never sees a container path.
  - A picked location is read, never written, except for a file removed between the presence check and the read. Create it once at the command line -- `alcove fingerprint --identity-file /run/signing/alcove-signing-identity.json` -- and mount that directory read-only.
  - Changing the location clears the fingerprint shown.
- **Your fingerprint** runs `alcove fingerprint`, which creates the identity the first time and shows the same value after. Exchange fingerprints with your partner over a trusted channel, not in the invitation's message, and enter theirs in **your partner's fingerprint**.
  - The card and the closed section state what is pinned, or that nothing is.
  - With nothing pinned, the run pins whatever certificate arrives over the invitation's channel and reports it; the card warns that the receipt then attests to whoever sent the invitation, and asks you to compare the value with your partner's `alcove fingerprint`.
  - A pin adopted mid-run is not written back to a configuration in your folder, so enter it before the next exchange. A WebRTC exchange is the exception: its pin is saved to `alcove.yaml`.
  - Once pinned, any other certificate, or none, is refused before a linkage key or data row is sent; the run screen names the check that stopped it.
  - The identity is bound to the name it was created under. If this exchange names you differently, the run is refused; the console names both and the fixes: set **your name** to the bound name, or create a new identity with `alcove fingerprint --force --identity` (the card shows the command under **About your signing identity**), which gives a new fingerprint every partner must re-pin. Where the difference is surrounding space or Unicode form, only the second fix applies.
- **Also write out my public certificate** saves the public half to your working folder for an auditor.
- **A retention note** (`retention_disposition`) says where the result is filed and how long it is kept. It is saved with your records and never sent to your partner.

By default the identity lives in your working folder, so treat that folder as you treat the results: readable only by you, not on shared storage. The console offers no way to replace the identity; `alcove fingerprint --force` at the command line does, with the re-pinning above. Keys and receipt format: [SECURITY_DESIGN.md](SECURITY_DESIGN.md#receipt-signing-identities); configuration keys: [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md#signing).

**A shared-folder exchange is refused while your signing identity file is in a folder your partner syncs**, because the run would hand your partner the private key that signs for you with every partner.

- The refusal applies to shared-folder exchanges only, and only where the identity file is already in a partner-synced folder. An SFTP exchange from the same single mount runs, as does a shared folder beside or below your working folder.
- Creating the identity is refused only while a shared-folder exchange is running out of that same folder.
- To run, give the shared folder its own mount (`JOB_RENDEZVOUS_DIR`), or point **where your signing identity is kept** at the secrets directory; a key left in a synced folder still refuses the run.
- The check reads the mount paths, their resolved real paths, and folder identity, and one fixed file name. A layout bound in again under another name, or a copy of the key under another name, is not seen; the console says beside the signing control what the check covers. A separate mount is what removes the risk.

## Graduating to a scheduled run

Once an exchange works, move the recurring version to the plain CLI on a schedule. The console shows a scheduled-run hand-off: the portable `alcove.yaml` (or the quick exchange command), the command that runs it, cron and Task Scheduler lines, and caveats. Machine-specific paths are placeholders to set on the scheduling machine, or, for an opened and unconverted configuration, that file's own paths. What the scheduling machine needs -- working directory, key file custody and permissions, the cadence its expiry bounds, and what an unattended run refuses -- is in [Scheduling the run](CLI.md#scheduling-the-run).

- **A WebRTC exchange hands you its working folder files.** Copy the `alcove.yaml` and `.alcove.key` as they stand after your last run, set `signing.identity_file` there if it signs, and schedule `alcove exchange` on them.
- **The commands run the published image.** Each runs `docker run --rm` over the folder at `/work`, mounts each other path the configuration names (credential file, shared folder, signing identity) at the same path with `--mount type=bind,src=PATH,dst=PATH`, reads the input by name, appends to `exchange.log`, and ends on `./` as the output folder, so each run writes `alcove-results-<time>.csv`, `alcove-record-<time>.json`, and its receipt without overwriting the last ([The result file](CLI.md#the-result-file)). The Linux and macOS command and cron line add `--user "$(id -u):$(id -g)"`, so the container writes as your own account, and name `/usr/bin/docker`; the command is shown for Windows too, in PowerShell and without `--user`; the same two for rootless Podman take `--userns=keep-id:uid=1000,gid=1000` in place of `--user` and follow them. A cron line for an installed `alcove` is shown too. The Windows command and the Task Scheduler line are PowerShell commands, and mount the folder alone; the caveats name the other paths to mount.
- **Paths the console will not mount.** A bound path holding a comma or double quote, at or under `/work`, the filesystem root, or not written plainly (`.` or `..`, a repeated or trailing slash) drops the Docker commands, leaving the installed-`alcove` ones; the panel names the path. A path holding a line break, control character, or text-direction character drops every command.
- **Other steps run the same image.** Where the console tells you to run `alcove update`, `alcove apply` (with `-it`), or `alcove fingerprint`, it shows the command for each system: `docker run --rm --user "$(id -u):$(id -g)"` over `/path/to/your/working-folder` for Linux and macOS, so the container writes as your own account, as `start-alcove.sh` runs the console (if the console runs as the account built into the image, because you started it with `docker run` and no `--user` or with `start-alcove.sh` from a root login, leave out `--user` so the command writes files as the console does); a PowerShell form for Windows over `C:\path\to\your\working-folder`, without `--user`; and the rootless Podman form, which takes `--userns=keep-id:uid=1000,gid=1000` in place of `--user`. A secrets folder the command names is mounted at `/path/to/your/secrets-folder` inside the container, from `C:\path\to\your\secrets-folder` on Windows.
- **Everything you authored transfers**, including file handling, tuning, receipt and retention settings, and quick exchange's strategy and duplicate-matches choice. The file is written by the same writer `alcove` uses; an opened configuration keeps every setting but not your comments, order, or quoting.
- **It is ready when the run starts**, collapsed while it runs.
- **It never shows the shared secret or a container path.** It points at the on-disk `.alcove.key` to copy, and at the signing identity to copy rather than recreate, since a new identity has a new fingerprint.
- **Its caveats name each path** taken from your configuration to check on the scheduling machine. For a pasted credential where the configuration names a path, it says to save the credential at that path.
- **It warns about a signing setting Alcove would refuse**: an unconverted configuration whose `signing.mode: certificate` lacks the party name or `signing.identity_file` would fail unattended. Set them, or set `signing.mode` to `none`.

Contract: [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#the-recurring-run-hand-off); command-line reference: [CLI.md](CLI.md#recurring-exchange).

## Sending the partner an accept kit

An SFTP or shared-folder exchange puts the partner on the command line, so the console offers a second artifact when it creates the invitation: a printable, plaintext instruction sheet to send with the invitation. It assumes the partner has Docker -- Desktop or Engine -- or can get it, and takes them to the point of accepting: the channel, the rendezvous the invitation names, a `cosign verify` command that checks the image's signature before it runs, the `docker run ... accept` and `exchange` commands, and, on a shared folder, routing a partner whose folder is a Windows network drive or DFS path to the release launchers (Docker cannot see a drive letter).

- An exchange created with retain mode on adds a fixed disclosure of what it leaves behind and where those files persist, and the commands include the setting; on the launcher route it points the partner at the console's file-handling control.
- Lockless rendezvous without retain mode is handled the same two ways, since the partner's side must match it.
- It does not restate the linkage terms: accepting displays them and asks the partner to confirm.
- The sheet contains no secret and no invitation token -- the partner pastes their own copy of the invitation over a placeholder -- so it can travel any way, including on paper.

Its contents and invariants are in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md#the-partner-accept-kit).

## Where a run's files land

Each run gets a folder of its own in your working folder (`JOB_DATA_ROOT`), named by the run's id -- the id the run screen's discard confirm names. The console runs `alcove exchange` with that folder as its output folder, so the files are named as the command line names them, `<time>` being the time of the run's exchange record:

- `alcove-results-<time>.csv` -- the matched result. The download is saved under the same name.
- `alcove-record-<time>.json` and `alcove-record-<time>.keys.json` -- the exchange record and its verification keys, for a run that disclosed, with `alcove-record-<time>.terms.json` holding both parties' agreed terms for `alcove verify-receipt`.
- `.alcove.key` -- the shared secret, for a run that created or accepted an invitation. Your next run needs it, so copy it out before you discard the run (see [Graduating to a scheduled run](#graduating-to-a-scheduled-run)). A run of an opened configuration, and a WebRTC run, use the `.alcove.key` in your working folder instead, which discarding leaves alone.
- `alcove-receipt-<time>.json` -- the signed receipt, for a run that asked for one.
- `run.log` -- the diagnostic log, for a run that recorded one.
- `alcove.yaml` and `input.csv` -- the configuration the console composed (not for a WebRTC run), and your input when you supplied it inline rather than from the input directory.

Discarding a run deletes its folder. When the console can read the folder, the confirm lists which of these files it holds, the shared secret included, so you can copy out what you need. When that check gets no answer, check the folder yourself before discarding.

## Restarting cancels and forgets the exchange

Job state is memory-only, so restarting the server cancels an exchange still running -- rerun it; the protocol cannot resume mid-run -- and forgets it. Its folder stays on disk. Nothing is deleted without you choosing it:

- Reopening the console from the browser that started the exchange shows the folder left behind, by name, with **Keep the folder** and **Discard the folder**.
- **Keep the folder** leaves it for you to copy files out of, and the console stops offering it.
- **Discard the folder** deletes it, after a confirm listing what it holds. If the console cannot delete it, it says so.
- A folder holding nothing but `alcove.yaml` is not offered.
- A folder no browser offers stays until you remove it by hand.

Within one server lifetime, reloading or reopening the console from the same browser finds an exchange still running and picks it back up. Leaving the page does not stop the exchange; only discarding it does.

The endpoint contract, request schema, working-directory layout and file permissions, and gate and startup rules are in [SERVER_JOB_API.md](spec/SERVER_JOB_API.md).

## See also

- [CLI.md](CLI.md) - the command-line tool the console drives, and the reference for a run that has graduated to a schedule
- [DEPLOYMENT.md](DEPLOYMENT.md) - the container image, the account it runs as, network requirements, and restricting the container's outbound network access
- [EXCHANGE_REFERENCE.md](EXCHANGE_REFERENCE.md) - the field-level meaning of every setting the console composes into a configuration
- [SERVER_JOB_API.md](spec/SERVER_JOB_API.md) - the endpoint contract, request schema, working-directory layout, and gate and startup rules behind the console
- [SECURITY_DESIGN.md](SECURITY_DESIGN.md#single-party-console-trust-boundary) - the single-party trust invariant the console rests on
