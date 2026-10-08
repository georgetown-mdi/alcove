# The single home of the TLS front's image pin. Nothing builds this file.
#
# install.sh reads this FROM reference, refuses one without a sha256 digest,
# checks the configuration in that image and writes the reference to
# /etc/alcove-broker/front-image.env, which alcove-broker-tls.service runs.
# Registry-qualified and pinned to the multi-arch index digest, as
# infra/relay/Dockerfile pins coturn; the docker ecosystem entry for
# /infra/broker in .github/dependabot.yml raises a bump.
FROM docker.io/library/nginx:1.29-alpine
