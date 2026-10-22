## Quickstart

Node.js `>=26` is required, the `engines.node` range in the root `package.json`.
The root `.npmrc` sets `engine-strict=true`, so npm stops the install on an older Node.js instead of warning.

From the repository root, run these in order:

1. `npm ci -w packages/core -w packages/cli-contract -w apps/cli`
2. `npm run build -w packages/core`
3. `npm run build -w packages/cli-contract`
4. `npm run build -w apps/cli`

Build in this order: `packages/cli-contract` compiles against core's declarations, and the CLI reads both packages from their `dist/` folders.
If you skip step 3, the CLI build still finishes, with "Cannot find module" warnings, and the CLI then stops at start with the same error for `@alcove/cli-contract`.

To connect:

```sh
npm run dev -w apps/cli sftp://USER:PASSWORD@HOST/PATH INPUT_FILE [OUTPUT_FOLDER]
```

Put `--` after `npm run dev -w apps/cli` before any flag you pass to the CLI.
Without it, npm warns `Unknown cli config` and keeps the flag for itself, so the CLI never receives it.

To avoid using a password on the command line, place it in a plain-text file and execute:

```sh
npm run dev -w apps/cli -- --server-password=@PASSWORD_FILE sftp://USER@HOST/PATH INPUT_FILE
```

Similarly, to use a private key:

```sh
npm run dev -w apps/cli -- --server-private-key=@PEM_FILE sftp://USER@HOST/PATH INPUT_FILE
```

## To build for the GitHub Container Registry

Multi-platform images require a `docker-container`-driver buildx builder. Create
it once, but do NOT make it your default (no `--use`): a global default
`docker-container` builder breaks tools that build and then load a single image
into the local engine -- notably `devcontainer up`, which then hangs after the
build with no container created. Select the builder explicitly with `--builder`
on each deployment build instead, leaving your everyday default on the
engine-native `docker` driver.

Run these from the repository root (the Dockerfile lives there).

Do once (skip if `multiarch-builder` already exists; run `docker buildx rm
multiarch-builder` first to recreate):
```sh
docker buildx create --name multiarch-builder
docker buildx inspect --bootstrap multiarch-builder
```

Do every time (the login needs a classic personal access token holding
`write:packages`; GitHub Packages accepts no other token kind):
```sh
docker login ghcr.io -u <github-user> --password-stdin < <token-file>
docker buildx build --builder multiarch-builder \
  --platform linux/amd64,linux/arm64 \
  -t ghcr.io/georgetown-mdi/alcove:latest \
  --push .

docker buildx stop multiarch-builder
```

## To build for testing

Before pushing to the registry, from the repository root:

```sh
docker image rm -f ghcr.io/georgetown-mdi/alcove:latest
docker build -t ghcr.io/georgetown-mdi/alcove:latest .
```

## Running tests

Unit tests:

```sh
npm test -w apps/cli
```

The integration suite drives the real SFTP adapter against an SFTP server it
stands up itself -- in-process by default (an `ssh2.Server` on an ephemeral
loopback port), or a native OpenSSH `sshd` with `ALCOVE_SFTP_BACKEND=native`.
The native backend can run hardened configurations (restricted crypto, rate
limits, an allowlist, a chroot jail) selected by `ALCOVE_SFTP_NATIVE_PROFILE`.
It is self-managing (a vitest `globalSetup` starts the server before the suite
and stops it after):

```sh
npm run test:integration -w apps/cli
```

The WebRTC transport is a project of its own, driving two loopback werift peers
through the vendored PeerJS broker with no SFTP server involved:

```sh
npm run test:integration:webrtc -w apps/cli
```

See [docs/TESTING.md](../../docs/TESTING.md#integration-tests) for details.
