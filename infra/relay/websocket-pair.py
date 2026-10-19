#!/usr/bin/env python3
"""Pair two sockets at the WebSocket relay over TLS and forward one message.

    websocket-pair.py <host> <port> <server-name> <exchange-id> [--cafile <file>]

Reads the exchange's relay key, 64 lowercase hex characters, on standard input,
never the command line. Opens two TLS connections to <host>:<port> with
<server-name> as their server name, verifying the certificate for that name
against the system's authorities or --cafile, and upgrades each to a WebSocket
at /relay. One sends the inviter's hello and the other the acceptor's, each
with a proof made under the relay key (docs/spec/PROTOCOL.md, The WebSocket
relay proof) and its start, as docs/spec/WEBSOCKET_RELAY.md specifies. Once
both are paired and started, the inviter sends one 32-byte binary message,
which the acceptor must receive unchanged, then closes with 1000, which the
acceptor must receive.

Prints one line saying what crossed, or what refused it. Never prints the key.

Exit status: 0 when the message crossed and the close reached the acceptor,
2 when a connection or its TLS handshake failed, 3 when an answer did not come
in time or a connection ended unanswered, 4 for an answer that is not the one
the protocol gives, 5 when the certificate does not verify for <server-name>,
6 when the relay closed a socket with a code, which the line names, and 64 for
a usage error.

Python 3.9 standard library only: the version Amazon Linux 2023 ships.
"""

import base64
import hashlib
import hmac
import json
import os
import re
import socket
import ssl
import struct
import sys
import time

RELAY_PATH = "/relay"
ANSWER_TIMEOUT_SECONDS = 15
PROOF_TTL_SECONDS = 60
PROOF_KEY_LABEL = b"alcove-relay-websocket-v2:proof-key"
PROOF_MESSAGE_LABEL = "alcove-relay-websocket-v2:hello"
WEBSOCKET_GUID = b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
MAX_HEADER_BYTES = 8192
MAX_MESSAGE_BYTES = 65536
NORMAL_CLOSE = 1000
TEXT, BINARY, CLOSE, PING, PONG = 0x1, 0x2, 0x8, 0x9, 0xA


class ProbeError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def parse_arguments(argv):
    usage = "usage: websocket-pair.py <host> <port> <server-name> <exchange-id> [--cafile <file>]"
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
    host, port, server_name, exchange_id = positional
    return host, int(port), server_name, exchange_id, cafile


def read_key():
    key = sys.stdin.readline().strip()
    if not re.fullmatch(r"[0-9a-f]{64}", key):
        raise ProbeError(64, "standard input has no relay key of 64 lowercase hex characters")
    return key


def proof_key(relay_key):
    """HKDF-SHA-256 of the relay key's bytes, salt 32 zero bytes, one 32-byte block."""
    prk = hmac.new(b"\x00" * 32, bytes.fromhex(relay_key), hashlib.sha256).digest()
    return hmac.new(prk, PROOF_KEY_LABEL + b"\x01", hashlib.sha256).digest()


def hello(relay_key, exchange_id, role):
    message = "%s\n%s\n%d" % (PROOF_MESSAGE_LABEL, role, int(time.time()) + PROOF_TTL_SECONDS)
    tag = hmac.new(proof_key(relay_key), message.encode("ascii"), hashlib.sha256).hexdigest()
    return json.dumps(
        {"type": "hello", "exchangeId": exchange_id, "role": role, "proof": message, "tag": tag},
        separators=(",", ":"),
    )


class Socket:
    def __init__(self, role, connection):
        self.role = role
        self.connection = connection
        self.buffer = b""

    def fill(self):
        try:
            chunk = self.connection.recv(65536)
        except socket.timeout:
            raise ProbeError(3, "the %s's socket got no answer within %d s" % (self.role, ANSWER_TIMEOUT_SECONDS))
        except OSError as error:
            raise ProbeError(3, "the %s's socket ended before the relay answered: %s" % (self.role, error))
        if not chunk:
            raise ProbeError(3, "the relay closed the %s's connection without a WebSocket close" % self.role)
        self.buffer += chunk

    def read_exactly(self, count):
        while len(self.buffer) < count:
            self.fill()
        data, self.buffer = self.buffer[:count], self.buffer[count:]
        return data

    def upgrade(self, server_name):
        key = base64.b64encode(os.urandom(16))
        request = (
            "GET %s HTTP/1.1\r\nHost: %s\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            "Sec-WebSocket-Key: %s\r\nSec-WebSocket-Version: 13\r\n\r\n"
        ) % (RELAY_PATH, server_name, key.decode("ascii"))
        self.connection.sendall(request.encode("ascii"))
        while b"\r\n\r\n" not in self.buffer:
            if len(self.buffer) > MAX_HEADER_BYTES:
                raise ProbeError(4, "the %s's upgrade answer is longer than %d bytes" % (self.role, MAX_HEADER_BYTES))
            self.fill()
        head, self.buffer = self.buffer.split(b"\r\n\r\n", 1)
        lines = head.decode("latin-1").split("\r\n")
        if not re.match(r"HTTP/1\.1 101\b", lines[0]):
            raise ProbeError(4, "the %s's upgrade was answered %r" % (self.role, lines[0][:80]))
        expected = base64.b64encode(hashlib.sha1(key + WEBSOCKET_GUID).digest()).decode("ascii")
        accept = [line.split(":", 1)[1].strip() for line in lines[1:] if line.lower().startswith("sec-websocket-accept:")]
        if accept != [expected]:
            raise ProbeError(4, "the %s's upgrade answer has no Sec-WebSocket-Accept for its key" % self.role)

    def send(self, opcode, payload):
        mask = os.urandom(4)
        if len(payload) < 126:
            header = struct.pack("!BB", 0x80 | opcode, 0x80 | len(payload))
        elif len(payload) < 65536:
            header = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, len(payload))
        else:
            header = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, len(payload))
        masked = bytes(byte ^ mask[i % 4] for i, byte in enumerate(payload))
        self.connection.sendall(header + mask + masked)

    def receive(self):
        """The next message the relay sends, answering a ping on the way."""
        while True:
            first, second = struct.unpack("!BB", self.read_exactly(2))
            opcode = first & 0x0F
            if not first & 0x80 or opcode == 0:
                raise ProbeError(4, "the relay sent the %s a fragmented message" % self.role)
            if second & 0x80:
                raise ProbeError(4, "the relay sent the %s a masked frame" % self.role)
            length = second & 0x7F
            if length == 126:
                length = struct.unpack("!H", self.read_exactly(2))[0]
            elif length == 127:
                length = struct.unpack("!Q", self.read_exactly(8))[0]
            if length > MAX_MESSAGE_BYTES:
                raise ProbeError(4, "the relay sent the %s a frame of %d bytes" % (self.role, length))
            payload = self.read_exactly(length)
            if opcode == PING:
                self.send(PONG, payload)
            elif opcode != PONG:
                return opcode, payload

    def expect_text(self, wanted):
        opcode, payload = self.receive()
        if opcode == CLOSE:
            raise_close(self.role, payload)
        try:
            frame = json.loads(payload.decode("utf-8")) if opcode == TEXT else None
        except ValueError:
            frame = None
        if frame != {"type": wanted}:
            raise ProbeError(4, "the %s expected the relay's %s and got another message" % (self.role, wanted))


def raise_close(role, payload):
    code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else None
    reason = payload[2:].decode("utf-8", "replace")
    raise ProbeError(
        6,
        "the relay closed the %s's socket with %s%s"
        % (role, code if code is not None else "no code", " (%s)" % reason if reason else ""),
    )


def connect(host, port, server_name, cafile, role):
    context = ssl.create_default_context(cafile=cafile)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        raw = socket.create_connection((host, port), timeout=ANSWER_TIMEOUT_SECONDS)
    except OSError as error:
        raise ProbeError(2, "could not connect to %s:%d: %s" % (host, port, error))
    try:
        connection = context.wrap_socket(raw, server_hostname=server_name)
    except ssl.SSLCertVerificationError as error:
        raw.close()
        raise ProbeError(5, "the certificate %s:%d serves does not verify for %s: %s" % (host, port, server_name, error.verify_message))
    except (OSError, ssl.SSLError) as error:
        raw.close()
        raise ProbeError(2, "the TLS handshake with %s:%d failed: %s" % (host, port, error))
    return Socket(role, connection)


def probe(host, port, server_name, exchange_id, cafile, relay_key):
    sockets = []
    try:
        for role in ("inviter", "acceptor"):
            party = connect(host, port, server_name, cafile, role)
            sockets.append(party)
            party.upgrade(server_name)
        inviter, acceptor = sockets
        for party in sockets:
            party.send(TEXT, hello(relay_key, exchange_id, party.role).encode("ascii"))
            party.send(TEXT, b'{"type":"start"}')
        for party in sockets:
            party.expect_text("paired")
            party.expect_text("start")
        message = os.urandom(32)
        inviter.send(BINARY, message)
        opcode, payload = acceptor.receive()
        if opcode == CLOSE:
            raise_close(acceptor.role, payload)
        if opcode != BINARY or payload != message:
            raise ProbeError(4, "the acceptor received a message other than the inviter's")
        inviter.send(CLOSE, struct.pack("!H", NORMAL_CLOSE))
        opcode, payload = acceptor.receive()
        code = struct.unpack("!H", payload[:2])[0] if opcode == CLOSE and len(payload) >= 2 else None
        if code != NORMAL_CLOSE:
            raise ProbeError(4, "the inviter's close reached the acceptor as %s, not %d" % (code, NORMAL_CLOSE))
        acceptor.send(CLOSE, struct.pack("!H", NORMAL_CLOSE))
        print(
            "paired at wss://%s%s; a 32-byte message crossed from the inviter to the acceptor, and the close followed it"
            % (server_name, RELAY_PATH),
            flush=True,
        )
        return 0
    finally:
        for party in sockets:
            party.connection.close()


def main(argv):
    try:
        host, port, server_name, exchange_id, cafile = parse_arguments(argv)
        relay_key = read_key()
        return probe(host, port, server_name, exchange_id, cafile, relay_key)
    except ProbeError as error:
        print(error, file=sys.stderr)
        return error.status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
