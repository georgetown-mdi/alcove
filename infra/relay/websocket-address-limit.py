#!/usr/bin/env python3
"""Check that the front bounds WebSocket relay sockets for each client address.

    websocket-address-limit.py <host> <port> <server-name> <other-host> [--cafile <file>]

Opens 8 TLS connections to <host>:<port> with <server-name> as their server
name, verifying the certificate for that name against the system's
authorities or --cafile, and upgrades each to a WebSocket at /relay, holding
all 8 open. A ninth to <host> must then be closed unanswered, at its TLS
handshake or before its upgrade is answered. One more, to <other-host>, which
must reach the front from another local address, must then be upgraded while
the 8 are still held: a front that counted every client as one address would
close it. No hello is sent, so the relay closes each held socket at its
10-second hello window; a run longer than 8 seconds stops rather than count a
socket the relay closed as one the front refused.

Prints one line saying which sockets were upgraded and which was closed, the
last address it names being the closed socket's local address, or what went
wrong.

Exit status: 0 when the 8 sockets and the one from <other-host> were upgraded
and the ninth was closed, 2 when a TCP connection could not be made, 3 when an
answer did not come in time or the run took longer than 8 seconds, 4 for an
upgrade answered other than 101, 5 when the certificate does not verify for
<server-name>, 6 when the front closed one of the 8 sockets or the socket from
<other-host>, 7 when the ninth socket was answered rather than closed, 8 when
both hosts were reached from the same local address, and 64 for a usage
error.

Python 3.9 standard library only: the version Amazon Linux 2023 ships.
"""

import base64
import os
import re
import socket
import ssl
import sys
import time

RELAY_PATH = "/relay"
# front.conf.tmpl's limit_conn in the WebSocket relay server.
SOCKETS_PER_ADDRESS = 8
ANSWER_TIMEOUT_SECONDS = 15
# Under the relay's 10-second hello window, which closes a held socket.
HOLD_SECONDS = 8
MAX_HEADER_BYTES = 8192


class ProbeError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def parse_arguments(argv):
    usage = "usage: websocket-address-limit.py <host> <port> <server-name> <other-host> [--cafile <file>]"
    positional = []
    cafile = None
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == "--cafile":
            if index + 1 >= len(argv):
                raise ProbeError(64, usage)
            index += 1
            cafile = argv[index]
        elif argument.startswith("--"):
            raise ProbeError(64, usage)
        else:
            positional.append(argument)
        index += 1
    if len(positional) != 4 or not positional[1].isdigit() or not 0 < int(positional[1]) < 65536:
        raise ProbeError(64, usage)
    host, port, server_name, other_host = positional
    return host, int(port), server_name, other_host, cafile


def open_socket(host, port, server_name, context, label, held):
    """Opens one socket and asks for the upgrade.

    Returns this end's local address and the answer's status line, or None in
    its place when the far side closed the connection unanswered. Every socket
    opened is added to held, which the caller closes.
    """
    try:
        raw = socket.create_connection((host, port), timeout=ANSWER_TIMEOUT_SECONDS)
    except OSError as error:
        raise ProbeError(2, "could not connect to %s:%d: %s" % (host, port, error))
    held.append(raw)
    local = raw.getsockname()[0]
    try:
        connection = context.wrap_socket(raw, server_hostname=server_name)
    except ssl.SSLCertVerificationError as error:
        raise ProbeError(5, "the certificate for %s does not verify: %s" % (server_name, error.verify_message))
    except socket.timeout:
        raise ProbeError(3, "%s got no TLS handshake answer within %d s" % (label, ANSWER_TIMEOUT_SECONDS))
    except OSError:
        return local, None
    held.append(connection)
    key = base64.b64encode(os.urandom(16)).decode("ascii")
    request = (
        "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
        "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
    ) % (RELAY_PATH, server_name, key)
    answer = b""
    try:
        connection.sendall(request.encode("ascii"))
        while b"\r\n" not in answer:
            if len(answer) > MAX_HEADER_BYTES:
                raise ProbeError(4, "%s's upgrade answer is longer than %d bytes" % (label, MAX_HEADER_BYTES))
            chunk = connection.recv(4096)
            if not chunk:
                return local, None
            answer += chunk
    except socket.timeout:
        raise ProbeError(3, "%s's upgrade got no answer within %d s" % (label, ANSWER_TIMEOUT_SECONDS))
    except OSError:
        return local, None
    return local, answer.split(b"\r\n", 1)[0].decode("latin-1")[:80]


def probe(host, port, server_name, other_host, cafile):
    context = ssl.create_default_context(cafile=cafile)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    started = time.monotonic()
    held = []

    def expect_upgraded(label, status_line):
        if status_line is None:
            raise ProbeError(6, "the front closed %s unanswered" % label)
        if not re.match(r"HTTP/1\.1 101\b", status_line):
            raise ProbeError(4, "%s's upgrade was answered %r" % (label, status_line))
        if time.monotonic() - started > HOLD_SECONDS:
            raise ProbeError(3, "the run took longer than %d s, so the relay may have closed a held socket" % HOLD_SECONDS)

    try:
        for number in range(1, SOCKETS_PER_ADDRESS + 1):
            label = "socket %d of %d from %s" % (number, SOCKETS_PER_ADDRESS, host)
            local, status_line = open_socket(host, port, server_name, context, label, held)
            expect_upgraded(label, status_line)

        label = "the ninth socket from %s" % host
        _, status_line = open_socket(host, port, server_name, context, label, held)
        if status_line is not None:
            raise ProbeError(7, "%s was answered %r rather than closed" % (label, status_line))

        label = "the socket from %s while %s held %d" % (other_host, host, SOCKETS_PER_ADDRESS)
        other_local, status_line = open_socket(other_host, port, server_name, context, label, held)
        if other_local == local:
            raise ProbeError(
                8,
                "%s and %s were both reached from %s, so the probe cannot tell two client addresses apart"
                % (host, other_host, local),
            )
        expect_upgraded(label, status_line)
        # verify.sh reads the ninth socket's address from "closed a ninth from
        # <address> unanswered" to find the front's refusal line naming it.
        print(
            "the front upgraded %d sockets from %s and one from %s at wss://%s%s, and closed a ninth from %s unanswered"
            % (SOCKETS_PER_ADDRESS, local, other_local, server_name, RELAY_PATH, local),
            flush=True,
        )
        return 0
    finally:
        for connection in held:
            connection.close()


def main(argv):
    try:
        host, port, server_name, other_host, cafile = parse_arguments(argv)
        return probe(host, port, server_name, other_host, cafile)
    except ProbeError as error:
        print(error, file=sys.stderr)
        return error.status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
