# The single home of the relay's 443 front image pin.
#
# The front's two units name the locally built
# `localhost/alcove-relay-front:installed` tag that install.sh builds from this
# file, so this digest has one copy here. It is the nginx image the broker's
# TLS front pins (infra/broker/Dockerfile), registry-qualified and pinned to its
# multi-arch index digest; the docker ecosystem entry for /infra/relay/front in
# .github/dependabot.yml raises a bump. The front uses nginx's stream module
# with ssl_preread, which install.sh's `nginx -t` in this image requires.
FROM docker.io/library/nginx:1.31-alpine@sha256:df221db836e1754089190208cee7eeda94f233197056426eda74a43ab1abeac2
