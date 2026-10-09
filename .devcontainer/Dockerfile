# Development container for Alcove. Node 26 (the shipped runtime and the version
# .nvmrc, CI, and the product image pin), running as the non-root `node` user.
# It carries the OpenSSH server the native SFTP test backend spawns and the
# iptables/ipset stack the egress firewall installs at startup, so the full suite
# -- build, unit, lint, typecheck, web dev server, and both SFTP integration
# backends -- runs inside with no Docker present.
#
# The build context is the repository root (devcontainer.json), so the image can
# read package-lock.json; every COPY below names its path from that root.

# The playwright-core version the lockfile installs, which decides the Chromium
# build the browser suite launches. A stage of its own so the main stage's cache
# keys on the version alone: a lockfile change that leaves playwright where it
# was rebuilds nothing below.
FROM node:26-bookworm AS playwright-pin
COPY package-lock.json /pin/package-lock.json
COPY scripts/check-playwright-browser.mjs /pin/scripts/check-playwright-browser.mjs
COPY scripts/lib/lockfile.mjs /pin/scripts/lib/lockfile.mjs
RUN node /pin/scripts/check-playwright-browser.mjs --pinned-version /pin/package-lock.json > /playwright-version

FROM node:26-bookworm

ARG TZ
ENV TZ="$TZ"

ARG CLAUDE_CODE_VERSION=latest

# Base development tools, the OpenSSH server/client the native SFTP test backend
# spawns and keygens against, and the iptables/ipset/dns toolchain the egress
# firewall uses (aggregate collapses the GitHub CIDR list, jq parses the meta
# feed, dnsutils provides dig, iproute2 provides ip).
#
# tinyproxy-bin and netcat-openbsd belong to the second egress lane
# (init-egress-proxy.sh), which both profiles run. The binary-only
# tinyproxy-bin is installed rather than the tinyproxy metapackage over it, so
# the image gains no service unit, no default config listening on 8888, and no
# tinyproxy-owned cron job or logrotate fragment; the system user and the
# whole configuration are the script's own.
# netcat-openbsd provides the `nc` that script uses to test whether the proxy
# is listening.
RUN apt-get update && apt-get install -y --no-install-recommends \
  less \
  git \
  procps \
  sudo \
  fzf \
  zsh \
  man-db \
  unzip \
  gnupg2 \
  openssh-server \
  openssh-client \
  iptables \
  ipset \
  iproute2 \
  dnsutils \
  aggregate \
  jq \
  nano \
  vim \
  tinyproxy-bin \
  netcat-openbsd \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# The GitHub CLI is not in Debian's repositories; add its official signed apt
# source, then install it. (The reference devcontainer's bare `apt-get install
# gh` only works where this source is already configured.)
RUN mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# The Chromium build the web app's browser suites launch through Playwright,
# with the shared libraries it links against, installed from the playwright-core
# version the lockfile pins so the two match. It is baked rather than fetched at
# container creation because the download redirects to storage.googleapis.com,
# which the egress firewall refuses. Root-owned and world-readable: the node
# user launches it but cannot replace or delete it.
#
# FRICTION: a playwright bump that moves the Chromium revision needs a container
# rebuild (Dev Containers: Rebuild Container); until then post-create.sh and
# `node scripts/check-playwright-browser.mjs` fail naming the missing build.
# The layer adds about 680 MB (Chromium, its headless shell, and FFmpeg,
# measured on linux-arm64 for playwright 1.64).
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=playwright-pin /playwright-version /usr/local/share/alcove-playwright-version
RUN npx --yes "playwright-core@$(cat /usr/local/share/alcove-playwright-version)" install --with-deps chromium \
  && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH" \
  && rm -rf /root/.npm \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# The native sshd test backend spawns an unprivileged sshd, which still fatally
# checks for the privilege-separation directory at startup even when run as a
# normal user; create it at build time so the backend needs no root at test time
# (CI creates the same directory before its native leg).
RUN mkdir -p /run/sshd

# Give the non-root node user a writable global npm prefix (so claude-code can be
# installed -- and self-update -- without root), and put its bin on PATH for login
# shells too: a Dockerfile ENV PATH is rebuilt from scratch by Debian's
# /etc/profile, which both bash and zsh login shells re-source, so the npm-global
# bin (where the `claude` launcher lives) would otherwise drop off an interactive
# terminal's PATH.
RUN mkdir -p /usr/local/share/npm-global && \
  chown -R node:node /usr/local/share/npm-global && \
  echo 'export PATH="$PATH:/usr/local/share/npm-global/bin"' > /etc/profile.d/npm-global-path.sh

# Marks the environment as a dev container for orientation/tooling.
ENV DEVCONTAINER=true

# Create the workspace and Claude config mount points owned by the node user.
# /workspace/node_modules is pre-created and owned by node so the named volume
# mounted there in devcontainer.json (which isolates Linux-built dependencies,
# including the native cpu-features, from the bind-mounted host tree) is writable
# by the non-root user on first creation.
RUN mkdir -p /workspace/node_modules /home/node/.claude && \
  chown -R node:node /workspace /home/node/.claude

WORKDIR /workspace

USER node

ENV NPM_CONFIG_PREFIX=/usr/local/share/npm-global
ENV PATH=$PATH:/usr/local/share/npm-global/bin

ENV SHELL=/bin/zsh
ENV EDITOR=vim
ENV VISUAL=vim

# Claude Code itself, so an agent session runs inside the container.
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

# Install the two egress-lane scripts and their default-profile allowlist, and
# grant the node user passwordless sudo for those two commands only, so
# devcontainer.json can apply them on start. init-firewall.sh builds the IP
# allowlist; init-egress-proxy.sh adds the hostname lane on top of it. Both
# profiles run both scripts -- the allowlist is what differs, and the infra
# block below appends its own patterns to the file COPYed here.
COPY .devcontainer/init-firewall.sh .devcontainer/init-egress-proxy.sh /usr/local/bin/
COPY .devcontainer/egress-allowlist /usr/local/share/alcove-egress-allowlist
USER root
RUN chmod +x /usr/local/bin/init-firewall.sh /usr/local/bin/init-egress-proxy.sh && \
  useradd --system --no-create-home --shell /usr/sbin/nologin tinyproxy && \
  { \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh"; \
  echo 'Defaults!/usr/local/bin/init-egress-proxy.sh env_keep += "ALCOVE_EGRESS_EXTRA_HOSTS"'; \
  echo "node ALL=(root) NOPASSWD: /usr/local/bin/init-egress-proxy.sh"; \
  } > /etc/sudoers.d/node-firewall && \
  chmod 0440 /etc/sudoers.d/node-firewall && \
  visudo -c -f /etc/sudoers.d/node-firewall
USER node

# Infrastructure profile, built by .devcontainer/infra/devcontainer.json with
# ALCOVE_INFRA=1: the AWS CLI, the Docker CLIENT, and the wider hostname
# allowlist the proxy lane needs for work against AWS, Cloudflare, Let's
# Encrypt, and a remote EC2 host -- destinations init-firewall.sh's IP allowlist
# cannot express (EC2 in us-west-2 alone is 169 shared-tenant prefixes).
#
# The build arg is declared HERE, below every layer the default profile uses, so
# an ALCOVE_INFRA=0 build reproduces those layers from cache unchanged. The file
# below is COPYed unconditionally -- a COPY cannot be made conditional -- to a
# staging path the RUN either folds into the installed allowlist or deletes, so
# an ALCOVE_INFRA=0 image carries no path this block introduced and its lane
# admits the default profile's hosts and nothing more.
#
# NO Docker daemon and NO socket mount, only the client, for `docker -H
# ssh://user@host` against a remote daemon. The host's Docker socket is root on
# the host, so mounting it would delete the container boundary that is layer 1
# of the security model in README.md.
COPY .devcontainer/infra/egress-allowlist /usr/local/share/alcove-egress-allowlist-infra

ARG ALCOVE_INFRA=0
# Pinned, and both digests were taken from an archive whose detached signature
# verified against the AWS CLI Team key FB5D B77F D5C1 18B8 0511  ADA8 A631
# 0ACC 4672 475C. AWS publishes no checksum file, so the signature is the
# provenance and the digest is what the build re-checks; re-verify the same way
# when bumping the version (README.md beside this file, Infrastructure profile).
ARG AWSCLI_VERSION=2.36.38
ARG AWSCLI_SHA256_AARCH64=52b045f09058a8e9f54976ec136bb2085463f4ce6db3008980d62381bfeccff5
ARG AWSCLI_SHA256_X86_64=1056bc30b892f4a80e65b05eac856fbf175d0c5aeda051d782450d2218db6657

USER root
RUN set -eu; \
  if [ "$ALCOVE_INFRA" != "1" ]; then \
  rm -f /usr/local/share/alcove-egress-allowlist-infra; \
  else \
  cat /usr/local/share/alcove-egress-allowlist-infra >> /usr/local/share/alcove-egress-allowlist; \
  rm -f /usr/local/share/alcove-egress-allowlist-infra; \
  case "$(dpkg --print-architecture)" in \
  arm64) awscli_arch=aarch64; awscli_sha="$AWSCLI_SHA256_AARCH64" ;; \
  amd64) awscli_arch=x86_64; awscli_sha="$AWSCLI_SHA256_X86_64" ;; \
  *) echo "ALCOVE_INFRA: unsupported architecture $(dpkg --print-architecture)"; exit 1 ;; \
  esac; \
  curl -fsSL -o /tmp/awscliv2.zip "https://awscli.amazonaws.com/awscli-exe-linux-$awscli_arch-$AWSCLI_VERSION.zip"; \
  echo "$awscli_sha  /tmp/awscliv2.zip" | sha256sum -c -; \
  unzip -q /tmp/awscliv2.zip -d /tmp/awscliv2; \
  /tmp/awscliv2/aws/install; \
  rm -rf /tmp/awscliv2.zip /tmp/awscliv2; \
  install -m 0755 -d /etc/apt/keyrings; \
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc; \
  chmod go+r /etc/apt/keyrings/docker.asc; \
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list; \
  apt-get update; \
  apt-get install -y --no-install-recommends docker-ce-cli; \
  apt-get clean; rm -rf /var/lib/apt/lists/*; \
  mkdir -p /etc/ssh/ssh_config.d; \
  { \
  echo '# Infra dev-container profile: every SSH destination is reached through the'; \
  echo '# loopback CONNECT proxy, so an SSH host is admitted by the same hostname'; \
  echo '# allowlist an HTTPS host is. Without this ssh opens a socket directly and'; \
  echo '# the egress firewall rejects it. An interactive ssh to a loopback sshd'; \
  echo '# needs no proxy in its path, and first match wins in ssh_config, so that'; \
  echo '# exemption has to precede the catch-all.'; \
  echo 'Host localhost 127.0.0.1 ::1'; \
  echo '  ProxyCommand none'; \
  echo ''; \
  echo 'Host *'; \
  echo '  ProxyCommand nc -X connect -x 127.0.0.1:8888 %h %p'; \
  } > /etc/ssh/ssh_config.d/alcove-egress-proxy.conf; \
  chmod 0644 /etc/ssh/ssh_config.d/alcove-egress-proxy.conf; \
  fi
USER node
