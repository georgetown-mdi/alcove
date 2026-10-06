# Alcove

Alcove: Open Source Encrypted Matching and Sharing

Alcove is an open-source tool that lets two organizations find the records (individuals) they have in common with the option of exchanging data about those shared records, without either organization revealing anything about the records they do not share. It performs privacy-preserving record linkage (PPRL) using a cryptographic protocol called private set intersection (PSI).

## Three ways to use Alcove

Pick the one that matches who you are. All three run the same protocol, so the two parties do not have to pick the same one.

1. **You have a spreadsheet and a browser.** Open [https://psi.data-bridge.org](https://psi.data-bridge.org). Nothing to install: your files are read and matched inside your browser, which exchanges directly with your partner's. Best for first-time and occasional exchanges. See [Web app](#web-app).
2. **You run Docker and want a guided screen for an exchange over your own SFTP server.** Start the console from the directory holding your input file, then visit [http://127.0.0.1:3000](http://127.0.0.1:3000):
   ```sh
   docker run --rm -p 127.0.0.1:3000:3000 --env JOB_DATA_ROOT=/work -v "$PWD":/work ghcr.io/georgetown-mdi/alcove:latest serve
   ```
   On Windows, use the Windows form in the [Web Console Quickstart](#web-console-quickstart).
   For an exchange through a shared folder, add the folder as the [Web Console Quickstart](#web-console-quickstart) shows.
3. **You automate exchanges from the command line.** Run the containerized command line app against an SFTP server, a shared folder, or a partner's browser:
   ```sh
   docker run -it --rm --mount type=bind,src="$PWD",dst=/work ghcr.io/georgetown-mdi/alcove:latest sftp://SFTP_USER@SFTP_HOST/SFTP_PATH --server-password=@PASSWORD_FILE INPUT_FILE OUTPUT_FOLDER
   ```
   Best for recurring or scheduled exchanges and for IT teams fitting linkage into a data pipeline. See the [CLI App Quickstart](#cli-app-quickstart).

How many records each one handles, and roughly how long an exchange takes: [How large an exchange can be](docs/WEB_APP.md#how-large-an-exchange-can-be).

To run the web app from source instead, see [apps/web/README.md](apps/web/README.md).

## Key features

- **Match without disclosure.** Each party keeps its full dataset private; the protocol reveals only which records the two parties have in common.
- **Optional data exchange for matched records.** Beyond identifying matches, parties can share selected columns (for example, program enrollment dates or contact information).
- **Configurable matching.** Records are matched on linkage keys built from identifier fields such as name, date of birth, or SSN, with built-in data cleaning and standardization so both parties' data is compared consistently.
- **No third party holds your data.** The web app exchanges data directly between the two parties' browsers; the command line app uses an SFTP server or shared folder that you control, or exchanges directly with a partner's browser.
- **A record of every exchange.** Each completed exchange produces a local record of what was shared, which you can retain for disclosure documentation.

## Example use cases

- A county HMIS administrator and a Medicaid agency identify clients enrolled in both systems and exchange fields such as renewal dates or case manager contact information (for shared clients only).
- Two service providers with a data sharing agreement determine which clients they serve in common without disclosing their full caseloads to each other.
- An agency IT team runs a recurring, scheduled exchange with a partner as part of a monthly data pipeline, using the command line app.

## Test data

This repository includes two synthetic datasets you can use to try the tool without touching real records: [`test_data/fake_data_1.csv`](test_data/fake_data_1.csv) and [`test_data/fake_data_2.csv`](test_data/fake_data_2.csv). Each contains fabricated names, SSNs, and dates of birth, with partial overlap between the two files, so you can run a complete practice exchange. One party uses each file. What the partner needs depends on how you run it:

- **Web app**: a browser and the other file. You create the invitation at the web app's address and send your partner the link (for example, by secure email); they open it and pick their file.
- **Console**: the other file, and the same SFTP server or shared folder you chose. Your partner runs the command line app or a console of their own, and accepts with the invitation you send them.
- **Command line app**: the other file, and the same SFTP server or shared folder. For an exchange with a browser partner, they need only a browser and the invitation you send them (see [Exchanging with a browser partner](#exchanging-with-a-browser-partner)).

## Web app

Open [https://psi.data-bridge.org](https://psi.data-bridge.org) and choose **Create an invitation**. Send the link it gives you to your partner, who opens it in their own browser. Keep your tab open until the exchange completes.

To practice, each party picks one of the files in [`test_data/`](test_data/) as input.

To exchange with the same partner on a schedule, choose **Save as a recurring exchange** on the exchange screen; see [Managed (recurring) web exchanges](docs/MANAGED_EXCHANGE.md).

The step-by-step guide, for both the party who invites and the partner who receives the link, is [docs/WEB_APP.md](docs/WEB_APP.md). It also explains the exchange record you can download at the end and how to check it.

## CLI App Quickstart

This app has a pre-built Docker image that can be used.

To link a file:

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. Within the Docker terminal (or in a Windows/Mac/Linux terminal window), run:  
```sh
docker pull ghcr.io/georgetown-mdi/alcove:latest
docker run -it \
  --rm --mount type=bind,src=WORK_PATH,dst=/work \
  ghcr.io/georgetown-mdi/alcove:latest \
  sftp://SFTP_USER@SFTP_HOST:SFTP_PORT/SFTP_PATH \
  --server-password=@PASSWORD_FILE \
  INPUT_FILE OUTPUT_FOLDER
```  
Replacing each of the following:
   * `WORK_PATH` - relative or absolute path to a directory on your machine that contains your input file. The container can only read and write inside this directory, and the output folder is in it. Example: `/Users/me/psi-exchange` (Mac/Linux) or `C:\Users\me\psi-exchange` (Windows).
   * `SFTP_USER`, `SFTP_HOST`, `SFTP_PORT` - standard SFTP connection information: the account username, the server address, and the port (usually `22`; if you use the default you can omit `:SFTP_PORT`).
   * `PASSWORD_FILE` - a file in `WORK_PATH` holding the SFTP account's password, so the password stays out of the command line and your shell history. Example: `passwd`.
   * `SFTP_PATH` - path from the **root** of the SFTP server to a directory that both parties can read and write; the exchange happens through files placed here. Example: `/exchanges/county-a-county-b`.
   * `INPUT_FILE` - your data file: a CSV with identifier columns (such as name, date of birth, or SSN) and, optionally, columns with data to share with the other party for matched records. A relative path is resolved inside `WORK_PATH`. Example: `clients.csv`.
   * `OUTPUT_FOLDER` - the folder the run writes its result and exchange record in, each run under its own time-stamped names. It is created if missing, and a relative path is resolved inside `WORK_PATH`. Example: `./` for `WORK_PATH` itself, or `matches/`.

A complete example, run from `/Users/me/psi-exchange` containing `clients.csv`:

```sh
docker run -it \
  --rm --mount type=bind,src=/Users/me/psi-exchange,dst=/work \
  ghcr.io/georgetown-mdi/alcove:latest \
  sftp://exchange_user@sftp.example.org/exchanges/county-a-county-b \
  --server-password=@passwd \
  clients.csv matches/
```

The `-it` flag connects your terminal to the container. On the first connection, Alcove shows the SFTP server's host-key fingerprint and asks you to confirm it; check it against the fingerprint your server administrator gives you before answering yes. Without `-it` there is no terminal to ask at, and Alcove refuses to connect to a server whose fingerprint it has not been given.

To run without a terminal, as a scheduled job does, read the fingerprint first, confirm it with your server administrator, and pass it on each run:

```sh
docker run --rm ghcr.io/georgetown-mdi/alcove:latest \
  probe-host-key sftp://sftp.example.org
```

Then paste the whole fingerprint it printed in place of `SHA256:FINGERPRINT` in the run command:

```sh
docker run \
  --rm --mount type=bind,src=/Users/me/psi-exchange,dst=/work \
  ghcr.io/georgetown-mdi/alcove:latest \
  sftp://exchange_user@sftp.example.org/exchanges/county-a-county-b \
  --server-password=@passwd \
  --server-host-key-fingerprint=SHA256:FINGERPRINT \
  clients.csv matches/
```

See [Reading a host key with `probe-host-key`](docs/CLI.md#reading-a-host-key-with-probe-host-key).

Because the only content accessible to the container is what is in `WORK_PATH`, we recommend making a new directory and placing the file you wish to link in it.

If you use Docker Desktop -- on Mac, Windows, or Linux -- skip this paragraph: it makes the mounted directory reachable by the container, so the commands above work as written. The container runs unprivileged, as uid 1000. Under Docker Engine on Linux the directory keeps its own ownership, so give it to that uid once -- `sudo chown 1000:1000 WORK_PATH` -- if your account is not itself uid 1000. If an earlier Alcove image has already written into that directory, the files it left belong to root, and the directory needs `sudo chown -R 1000:1000 WORK_PATH` to hand those over as well. See [The user the image runs as](docs/DEPLOYMENT.md#the-user-the-image-runs-as) for both, and for the alternative of running the container as your own account.

The output file is a CSV giving the linkage between the two parties' records. See [Output](docs/spec/PROTOCOL.md#output) for the exact column layout and naming rules.

To practice before using real data, the repository provides two synthetic input files in [`test_data/`](test_data/); each party uses one.

### Exchanging with a browser partner

The command line app also exchanges over WebRTC with a partner who uses the web app, with no SFTP server or shared folder between you. Invite them from the directory holding your input, replacing `Agency A` with your organization's name:

```sh
docker run -it --rm --mount type=bind,src="$PWD",dst=/work ghcr.io/georgetown-mdi/alcove:latest invite --identity "Agency A" https://psi.data-bridge.org/ clients.csv matches/
```

It prints an invitation and waits. Send it to your partner over a trusted channel; they paste it under **Accept an invitation you were sent** at [https://psi.data-bridge.org](https://psi.data-bridge.org). See [Inviting over WebRTC](docs/CLI.md#inviting-over-webrtc).

### Running it on a schedule

1. Set the exchange up once with `invite` on one side and `accept` on the other.
2. That writes `alcove.yaml` and a key file into your working directory.
3. Each later run is `exchange INPUT_FILE OUTPUT_FOLDER` from the same directory, with no further coordination.
4. Each run rotates the shared secret in the key file, so keep the directory between runs.
5. Hand that command to cron or the Windows Task Scheduler, as [Scheduling the run](docs/CLI.md#scheduling-the-run) shows.

For a first recurring exchange step by step, every command, and what each exit code means, see [docs/CLI.md](docs/CLI.md).

## Web Console Quickstart

The same Docker image serves the guided web experience from your own machine, with no Node.js setup, and runs the exchange (over SFTP or a shared folder) on that machine rather than browser-to-browser. It serves one party and is never shared beyond that host. For a partner who has only a browser, create the invitation in the [web app](#web-app) instead: the console does not run browser-to-browser exchanges.

1. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/).
2. From a directory holding your input CSV, for Mac / Linux, run the command below. Replace `/path/to/shared-folder` with the folder your sync tool shares with your partner, and `shared-folder` on the line above it with the name you and your partner know that folder by:
```sh
docker run --rm -p 127.0.0.1:3000:3000 \
  --env JOB_DATA_ROOT=/work -v "$PWD":/work \
  --env JOB_RENDEZVOUS_DIR=/shared \
  --env JOB_RENDEZVOUS_NAME=shared-folder \
  -v "/path/to/shared-folder":/shared \
  ghcr.io/georgetown-mdi/alcove:latest serve
```
   On Windows, navigate to that directory in the Docker console and run:
```sh
docker run --rm -p 127.0.0.1:3000:3000 --env JOB_DATA_ROOT=/work -v "${PWD}:/work" --env JOB_RENDEZVOUS_DIR=/shared --env JOB_RENDEZVOUS_NAME=shared-folder -v "C:\path\to\shared-folder:/shared" ghcr.io/georgetown-mdi/alcove:latest serve
```
3. Visit [http://127.0.0.1:3000](http://127.0.0.1:3000) on that machine; press Ctrl-C when done.

Your directory holds your input, the exchange's working files, and its results; the console reads your CSV in place. The shared folder is the one a shared-folder exchange runs through, and the name you give it is the name an invitation tells your partner to look for.

For an SFTP exchange, which syncs no folder with your partner, the three shared-folder lines can be left out. For a shared-folder exchange, keep them: without them, this console's shared folder is the folder holding your files. Whoever syncs it gets your input, configuration and results.

Publishing to `127.0.0.1` keeps the unauthenticated console reachable only from this machine, and works the same on Linux, macOS, and Windows. For SFTP exchanges and the other settings, see [CONSOLE.md](docs/CONSOLE.md).

The `serve` role is the one that cannot instead be run as your own account with `--user`: it keeps container-internal state belonging to uid 1000, so what it leaves behind in the mounted directory belongs to uid 1000 as well, and `sudo` may be needed to move or delete it afterwards. See the uid 1000 guidance above, and [The user the image runs as](docs/DEPLOYMENT.md#the-user-the-image-runs-as).

## Podman

[Podman](https://podman.io/) can be used as a drop-in replacement for Docker. The only change needed is to replace calls to the `docker` executable with calls to `podman`.

## CLI App

### SFTP parameters

#### Passwords

Read the password from a file with `--server-password=@PASSWORD_FILE`, as the quickstart does: the password then never appears on the command line or in your shell history, and its special characters need no escaping. See [Command line flags](#command-line-flags).

If you put the password in the connection string instead, special characters in it can be interpreted incorrectly by your shell. To avoid this, encase the whole connection string in single-quotation marks or escape the problematic characters. As an example of an exchange running from the current directory (indicated by mounting `$PWD`, or **p**rinting the **w**orking **d**irectory):

```sh
docker run -it --rm --mount type=bind,src=$PWD,dst=/work ghcr.io/georgetown-mdi/alcove:latest \
   'sftp://user:passw!rd@example.org/psi' input.csv ./results
```

or

```sh
docker run -it --rm --mount type=bind,src=$PWD,dst=/work ghcr.io/georgetown-mdi/alcove:latest \
   sftp://user:passw\!rd@example.org/psi input.csv ./results
```

#### Command line flags

Connection parameters can also be specified individually as command line flags to the script. Among others, they include:
   * `--server-port` - port number of the server
   * `--server-username` - username for authentication
   * `--server-password` - password for password-based user authentication; use `@path` to read from file
   * `--server-private-key` - an SSH private key (OpenSSH format) for key-based (publickey) authentication; use `@path` to read from file
   * `--server-private-key-passphrase` - for an encrypted private key, this is the passphrase used to decrypt it; use `@path` to read from file

Using `@path`s specifies that the value should be read from a file. For example, to have the script read a password from the file `passwd` in the working directory, run:

```sh
docker run -it --rm --mount type=bind,src=$PWD,dst=/work ghcr.io/georgetown-mdi/alcove:latest \
  sftp://user@example.org/psi \
  --server-password=@passwd \
  input.csv ./results
```

Note that because Docker prevents the container from accessing any path on your host system that isn't explicitly mounted, if you wish to use a pre-existing private key the program cannot access `~/.ssh` by default. In that case, either add a read-only mount to the key folder or copy the key to the working directory.

### Windows

#### Windows Subsystem for Linux

Docker for Windows requires that the Windows Subsystem for Linux be installed. Docker will ask you to install this the first time it starts up.

#### Docker terminal

To execute commands, launch a terminal from within Docker Desktop by clicking on the `>_` icon on the lower-right of the application's status bar.

### Paths and invocation

Paths can be given to Docker using standard Windows-style back-slashes. One exception is at the very end of the string: a trailing back-slash can cause Docker to fail to understand the end of the string. It is safe to remove it as it will still be treated as a directory.

Additionally, the line-continuation markers given in the examples (the `\` at the end of each line) above do not parse correctly. Put commands all on one line instead. For example:

```sh
docker run -it --rm --mount type=bind,src='C:\Users\me\Documents\alcove',dst=/work ghcr.io/georgetown-mdi/alcove:latest sftp://user@example.org/psi --server-password=@passwd input.csv ./results
```

### Docker run background

The `docker run` command has two parts. The first is the Docker invocation, which connects your terminal to the container so Alcove can ask you to confirm the server's fingerprint, and mounts `WORK_PATH` at `/work` so the container can read your input and write the output there (see Docker's own docs for [`--rm`](https://docs.docker.com/reference/cli/docker/container/run/#rm) and [`--mount`](https://docs.docker.com/reference/cli/docker/container/run/#mount)):

```sh
docker run -it --rm --mount type=bind,src=WORK_PATH,dst=/work ghcr.io/georgetown-mdi/alcove:latest
```

The second part is the invocation of the Alcove script and includes any command line options you wish to use. In the first example above it is:

```sh
sftp://SFTP_USER@SFTP_HOST:SFTP_PORT/SFTP_PATH --server-password=@PASSWORD_FILE INPUT_FILE OUTPUT_FOLDER
```

However, you can place anything here you wish to pass on to the program. For example, to have it print all of its options, execute:

```sh
docker run --rm ghcr.io/georgetown-mdi/alcove:latest --help
```

## Documentation

The full documentation set lives in [docs/](docs/README.md) and covers the protocol, threat model, exchange specification, deployment, and operations. The user guides are [docs/WEB_APP.md](docs/WEB_APP.md) for the web app, [docs/CONSOLE.md](docs/CONSOLE.md) for the console, and [docs/CLI.md](docs/CLI.md) for the command line app. The role-based reading guide in [docs/README.md](docs/README.md) points each audience (analysts, invited partners, program officers, security reviewers, IT staff, contributors) to the most relevant documents. An agency security review starts with [docs/SHARED_RESPONSIBILITY.md](docs/SHARED_RESPONSIBILITY.md), which states the deployment model and what the project operates versus what the deploying agency operates.

Repository-level resources:

- [CONTRIBUTING.md](CONTRIBUTING.md) - repository layout, development setup, code conventions, and pull request process
- [SECURITY.md](SECURITY.md) - vulnerability reporting and supported versions
- [PRIVACY.md](PRIVACY.md) - what the project collects and retains, and what supporting services can observe
- [SUPPORT.md](SUPPORT.md) - bug reports, questions, and evaluation help
- [CHANGELOG.md](CHANGELOG.md) - release history
