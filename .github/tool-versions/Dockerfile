# The home of tool versions that a workflow input or a Dockerfile ARG names
# and no Dependabot block reads: each stage's tag is the release of a tool the
# consumer below installs. Nothing builds or pulls this file.
#
# The docker entry for /.github/tool-versions in .github/dependabot.yml raises a
# bump of a tag here, and scripts/tool-versions.test.mjs fails until the same
# pull request moves the consumer to that release.
#
# cosign: the cosign-release input of the sigstore/cosign-installer steps.
FROM ghcr.io/sigstore/cosign/cosign:v3.1.4 AS cosign
# python: the python-version input of re2js_reference.yaml's setup-python step.
FROM docker.io/library/python:3.12.10 AS python
# aws-cli: AWSCLI_VERSION in .devcontainer/Dockerfile. Its two archive digests
# move by hand, re-verified as .devcontainer/README.md describes.
FROM docker.io/amazon/aws-cli:2.36.38 AS aws-cli
