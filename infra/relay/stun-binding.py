#!/usr/bin/env python3
"""Ask a TURN server over TLS which address it sees this client connect from.

    stun-binding.py <host> <port> <server-name> [--cafile <file>] [--hold <seconds>] [--redact]

Opens one TLS connection to <host>:<port> with <server-name> as its server name,
verifying the certificate against the system's authorities or --cafile, sends
one STUN Binding request (RFC 8489) with no credential, and prints the
XOR-MAPPED-ADDRESS of the answer: the client address the server took for this
connection. Through the relay's 443 front that is the address the PROXY header
gave coturn, so a loopback address means the header did not reach it.

Prints one line, "XOR-MAPPED-ADDRESS <address>:<port>", with " (loopback)"
after it for a loopback address. --redact prints a public address as <public>.
--hold keeps the connection open that many seconds after the answer.

Exit status: 0 for an answer naming an address outside loopback, 5 for one
naming a loopback address, 2 when the connection or the TLS handshake failed,
3 when no answer came in time, and 4 for an answer that is not a Binding
success holding an XOR-MAPPED-ADDRESS.

Python 3.9 standard library only: the version Amazon Linux 2023 ships.
"""

import ipaddress
import os
import socket
import ssl
import struct
import sys
import time

MAGIC_COOKIE = 0x2112A442
BINDING_REQUEST = 0x0001
BINDING_SUCCESS = 0x0101
XOR_MAPPED_ADDRESS = 0x0020
ANSWER_TIMEOUT_SECONDS = 15


class ProbeError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


def parse_arguments(argv):
    usage = "usage: stun-binding.py <host> <port> <server-name> [--cafile <file>] [--hold <seconds>] [--redact]"
    positional = []
    options = {"cafile": None, "hold": 0, "redact": False}
    index = 0
    while index < len(argv):
        argument = argv[index]
        if argument == "--redact":
            options["redact"] = True
        elif argument in ("--cafile", "--hold"):
            if index + 1 >= len(argv):
                raise ProbeError(64, usage)
            index += 1
            options[argument[2:]] = argv[index]
        elif argument.startswith("--"):
            raise ProbeError(64, usage)
        else:
            positional.append(argument)
        index += 1
    if len(positional) != 3 or not positional[1].isdigit() or not 0 < int(positional[1]) < 65536:
        raise ProbeError(64, usage)
    if not str(options["hold"]).isdigit():
        raise ProbeError(64, "--hold takes a whole number of seconds")
    options["hold"] = int(options["hold"])
    host, port, server_name = positional
    return host, int(port), server_name, options


def read_exactly(connection, count):
    data = b""
    while len(data) < count:
        chunk = connection.recv(count - len(data))
        if not chunk:
            raise ProbeError(3, "the server closed the connection before it answered")
        data += chunk
    return data


def mapped_address(message, transaction_id):
    """The address and port of the message's XOR-MAPPED-ADDRESS attribute."""
    offset = 20
    while offset + 4 <= len(message):
        attribute_type, length = struct.unpack("!HH", message[offset : offset + 4])
        value = message[offset + 4 : offset + 4 + length]
        if len(value) < length:
            break
        if attribute_type == XOR_MAPPED_ADDRESS and length >= 4:
            family = value[1]
            port = struct.unpack("!H", value[2:4])[0] ^ (MAGIC_COOKIE >> 16)
            mask = struct.pack("!I", MAGIC_COOKIE) + transaction_id
            if family == 0x01 and length == 8:
                packed = bytes(byte ^ mask[i] for i, byte in enumerate(value[4:8]))
            elif family == 0x02 and length == 20:
                packed = bytes(byte ^ mask[i] for i, byte in enumerate(value[4:20]))
            else:
                raise ProbeError(4, "the XOR-MAPPED-ADDRESS has an unknown family or length")
            return ipaddress.ip_address(packed), port
        offset += 4 + (length + 3) // 4 * 4
    raise ProbeError(4, "the answer holds no XOR-MAPPED-ADDRESS")


def is_loopback(address):
    mapped = getattr(address, "ipv4_mapped", None)
    return address.is_loopback or (mapped is not None and mapped.is_loopback)


def shown(address, redact):
    if redact and address.is_global:
        return "<public>"
    if address.version == 6:
        return "[%s]" % address
    return str(address)


def probe(host, port, server_name, options):
    context = ssl.create_default_context(cafile=options["cafile"])
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        raw = socket.create_connection((host, port), timeout=ANSWER_TIMEOUT_SECONDS)
    except OSError as error:
        raise ProbeError(2, "could not connect to %s:%d: %s" % (host, port, error))
    try:
        connection = context.wrap_socket(raw, server_hostname=server_name)
    except (OSError, ssl.SSLError) as error:
        raw.close()
        raise ProbeError(2, "the TLS handshake with %s:%d failed: %s" % (host, port, error))
    with connection:
        transaction_id = os.urandom(12)
        try:
            connection.sendall(struct.pack("!HHI", BINDING_REQUEST, 0, MAGIC_COOKIE) + transaction_id)
            header = read_exactly(connection, 20)
            message_type, length, cookie = struct.unpack("!HHI", header[:8])
            body = read_exactly(connection, length)
        except socket.timeout:
            raise ProbeError(3, "no answer within %d s" % ANSWER_TIMEOUT_SECONDS)
        except OSError as error:
            raise ProbeError(3, "the connection ended before the server answered: %s" % error)
        if cookie != MAGIC_COOKIE or header[8:20] != transaction_id:
            raise ProbeError(4, "the answer is not a STUN answer to this request")
        if message_type != BINDING_SUCCESS:
            raise ProbeError(4, "the answer is message type 0x%04x, not a Binding success" % message_type)
        address, mapped_port = mapped_address(header + body, transaction_id)
        loopback = is_loopback(address)
        print(
            "XOR-MAPPED-ADDRESS %s:%d%s"
            % (shown(address, options["redact"]), mapped_port, " (loopback)" if loopback else ""),
            flush=True,
        )
        time.sleep(options["hold"])
    return 5 if loopback else 0


def main(argv):
    try:
        host, port, server_name, options = parse_arguments(argv)
        return probe(host, port, server_name, options)
    except ProbeError as error:
        print(error, file=sys.stderr)
        return error.status


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
