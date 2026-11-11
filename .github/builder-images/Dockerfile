# The home of the BuildKit and QEMU emulator image pins that the
# docker/setup-buildx-action and docker/setup-qemu-action steps in
# release.yaml and image_smoke.yaml pass as inputs. Nothing builds this file.
#
# Dependabot reads no action input, so the docker entry for
# /.github/builder-images in .github/dependabot.yml raises a bump here, and
# scripts/dockerhub-login.test.mjs fails until the same pull request sets
# every step's input to the new digest.
FROM docker.io/moby/buildkit:v0.34.2@sha256:c5f8862f52499773af85bc07695b2379ef08e8002352b0df2c4864c91d78dabe AS buildkit
FROM docker.io/tonistiigi/binfmt:qemu-v10.2.3@sha256:400a4873b838d1b89194d982c45e5fb3cda4593fbfd7e08a02e76b03b21166f0 AS binfmt
