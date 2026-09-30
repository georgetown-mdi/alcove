#!/usr/bin/env python3
"""The relay's registrar: enroll, rotate, and revoke an exchange's relay key over HTTPS.

    POST   /exchanges/<exchange-id>   {"key": "<key-hex64>", "maxAgeDays": <n> | null}
    PUT    /exchanges/<exchange-id>   {"key": "<key-hex64>", "maxAgeDays": <n> | null}
    DELETE /exchanges/<exchange-id>

Every request but a CORS preflight holds one of two credentials in its
Authorization header: "Bearer <token>", the relay-owner token, which enrolls
(POST) and is the operator's recovery route on PUT and DELETE; or
"Alcove-Relay-Proof ts=<unix-seconds>,mac=<hex64>", a proof of holding the key
the exchange has registered, which rotates (PUT) and revokes (DELETE). Any other
request is answered 401 before its body is parsed. Authentication reads that
header and nothing else, and no answer allows credentials, so a browser's
cookies never authenticate a call. A write is one transaction through
relay_table.py beside this file, the secrets table's one write path.
infra/relay/README.md, The registrar, is the contract, and
docs/spec/PROTOCOL.md, The registrar request proof, the proof's format.

Runs as the relay image's account, which owns the table, and reads the token and
certificate from the credentials systemd hands the unit.

Python 3.9 standard library only: the version Amazon Linux 2023 ships.
"""

import hashlib
import hmac
import http.server
import json
import os
import re
import socketserver
import ssl
import sys
import threading
import time

sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import relay_table  # noqa: E402

ETC = "/etc/alcove-relay"
# systemd's LoadCredential= copies the root-only files into this directory.
CREDENTIALS = os.environ.get("CREDENTIALS_DIRECTORY")
TOKEN_FILE = os.environ.get("ALCOVE_RELAY_REGISTRAR_TOKEN_FILE") or (
    os.path.join(CREDENTIALS, "registrar-token") if CREDENTIALS else ETC + "/registrar-token"
)
CERT_DIR = os.environ.get("ALCOVE_RELAY_CERT_DIR") or (CREDENTIALS or ETC + "/certs")
PORT = os.environ.get("ALCOVE_RELAY_REGISTRAR_PORT") or "8443"
REALM = os.environ.get("ALCOVE_RELAY_REALM") or ""

PREFIX = "/exchanges/"
MAX_BODY_BYTES = 1024
# A slow or silent client holds one thread for at most this long.
CONNECTION_TIMEOUT_SECONDS = 15
MIN_TOKEN_LENGTH = 32
ID_REFUSAL = relay_table.ID_REFUSAL
VERIFY_ID_REFUSAL = relay_table.VERIFY_ID_REFUSAL
KEY_REFUSAL = "key must be 64 lowercase hex characters [0-9a-f]"
MAX_AGE_REFUSAL = (
    "maxAgeDays must be a whole number of days from 1 to %d, or null for no lapse" % relay_table.MAX_AGE_DAYS_CEILING
)
BODY_REFUSAL = 'the request body must be {"key": "<key-hex64>", "maxAgeDays": <days> | null}; maxAgeDays is required'
# The header verify.sh sends to register its own ids under the reserved prefix.
# A browser cannot send it: the preflight does not allow it.
VERIFY_RUN_HEADER = "Alcove-Relay-Verify-Run"
# docs/spec/PROTOCOL.md, The registrar request proof.
PROOF_SCHEME = "Alcove-Relay-Proof"
PROOF_KEY_LABEL = "alcove-relay-registrar-v2:proof-key"
PROOF_MESSAGE_LABEL = "alcove-relay-registrar-v2:request"
PROOF_WINDOW_SECONDS = 300
PROOF_PARAMETERS = re.compile(r"ts=(0|[1-9][0-9]{0,11}),mac=([0-9a-f]{64})")
PROOF_FORMAT_REFUSAL = "send the proof as Authorization: %s ts=<unix-seconds>,mac=<64 lowercase hex>" % PROOF_SCHEME
CHALLENGE = 'Bearer realm="alcove-relay-registrar", %s realm="alcove-relay-registrar"' % PROOF_SCHEME
TOKEN = "token"
# The journal names a request's method only from this list.
KNOWN_METHODS = frozenset(("GET", "HEAD", "POST", "PUT", "DELETE", "OPTIONS", "PATCH", "TRACE", "CONNECT"))


def fail_start(message):
    sys.stderr.write("ABORTING: %s\n" % message)
    sys.exit(1)


def read_token():
    try:
        with open(TOKEN_FILE, encoding="ascii") as handle:
            token = handle.read().strip()
    except (OSError, UnicodeDecodeError) as error:
        fail_start("could not read the registrar token %s: %s" % (TOKEN_FILE, error))
    if len(token) < MIN_TOKEN_LENGTH or not token.isalnum():
        fail_start(
            "%s must hold one line of at least %d letters and digits; regenerate it with: openssl rand -hex 32"
            % (TOKEN_FILE, MIN_TOKEN_LENGTH)
        )
    return token.encode("ascii")


valid_exchange_id = relay_table.valid_exchange_id
valid_key = relay_table.valid_key
valid_max_age_days = relay_table.valid_max_age_days


def proof_key(relay_key):
    extracted = hmac.new(b"\x00" * 32, bytes.fromhex(relay_key), hashlib.sha256).digest()
    return hmac.new(extracted, PROOF_KEY_LABEL.encode("ascii") + b"\x01", hashlib.sha256).digest()


def proof_message(method, exchange_id, body, timestamp):
    fields = (PROOF_MESSAGE_LABEL, method, exchange_id, hashlib.sha256(body).hexdigest(), str(timestamp))
    return "\n".join(fields).encode("ascii")


def proof_mac(relay_key, method, exchange_id, body, timestamp):
    """The lowercase-hex MAC of a request proving `relay_key`."""
    message = proof_message(method, exchange_id, body, timestamp)
    return hmac.new(proof_key(relay_key), message, hashlib.sha256).hexdigest()


class Proof:
    """A well-formed proof header, checked against no key yet."""

    def __init__(self, timestamp, mac):
        self.timestamp = timestamp
        self.mac = mac

    def made_under(self, relay_key, method, exchange_id, body):
        expected = proof_mac(relay_key, method, exchange_id, body, self.timestamp)
        return hmac.compare_digest(expected.encode("ascii"), self.mac.encode("ascii"))


class RegistrarHandler(http.server.BaseHTTPRequestHandler):
    server_version = "alcove-relay-registrar"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = CONNECTION_TIMEOUT_SECONDS

    def setup(self):
        super().setup()
        # The listening socket defers the handshake, so a client that connects
        # and never completes one holds this thread, not the accept loop.
        self.connection.do_handshake()

    def log_message(self, format, *args):
        sys.stderr.write("%s %s\n" % (self.address_string(), format % args))

    def log_request(self, code="-", size="-"):
        # The request line can carry a key -- in the path, or anywhere in a
        # malformed line -- so the journal gets the method and path only when
        # they have a shape no key has.
        command = self.command or ""
        method = command if command in KNOWN_METHODS else "(other method)"
        exchange_id = self.exchange_id() if command else None
        path = self.path if exchange_id is not None and valid_exchange_id(exchange_id) else "(path withheld)"
        self.log_message("%s %s %s", method, path, str(int(code)) if code != "-" else code)

    def send_error(self, code, message=None, explain=None):
        # Every error the standard library answers itself -- an unsupported
        # method, a malformed request line or header block -- is answered here,
        # in JSON, and with nothing from the request logged or echoed back.
        if code == 501:
            self.refuse_method()
            return
        self.close_connection = True
        try:
            reason = self.responses[code][0]
        except KeyError:
            reason = "error"
        self.send_json(code, {"error": "the request is malformed: %s" % reason.lower()}, (("Connection", "close"),))

    def send_json(self, status, body, extra_headers=()):
        payload = (json.dumps(body) + "\n").encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", "*")
        for name, value in extra_headers:
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(payload)

    def discard_body(self):
        # A small body is read and discarded, so the next request on the
        # connection starts where this one ends, and because closing a socket
        # with unread data resets it and can lose the answer; any other body
        # ends the connection unread. Returns the headers the answer carries.
        length = self.headers.get("Content-Length") or "0"
        if "Transfer-Encoding" not in self.headers and length.isdigit() and int(length) <= MAX_BODY_BYTES:
            self.rfile.read(int(length))
            return ()
        self.close_connection = True
        return (("Connection", "close"),)

    def refuse(self, status, message, extra_headers=()):
        self.send_json(status, {"error": message}, self.discard_body() + tuple(extra_headers))

    def credential(self):
        """TOKEN for the relay-owner token, or the Proof the header holds,
        checked against no key yet. Anything else is answered 401 here, and
        None returned."""
        header = self.headers.get("Authorization", "")
        scheme, _, presented = header.partition(" ")
        if scheme.lower() == "bearer" and hmac.compare_digest(
            presented.strip().encode("utf-8", "replace"), self.server.token
        ):
            return TOKEN
        if scheme.lower() == PROOF_SCHEME.lower():
            match = PROOF_PARAMETERS.fullmatch(presented.strip())
            if match is not None:
                return Proof(int(match.group(1)), match.group(2))
            self.refuse(401, PROOF_FORMAT_REFUSAL, (("WWW-Authenticate", CHALLENGE),))
            return None
        self.refuse(
            401,
            "missing or wrong credential; enroll with Authorization: Bearer <relay-owner token>, and rotate "
            "or revoke with Authorization: %s ts=<unix-seconds>,mac=<hex64>" % PROOF_SCHEME,
            (("WWW-Authenticate", CHALLENGE),),
        )
        return None

    def fresh(self, proof):
        now = int(time.time())
        if abs(now - proof.timestamp) <= PROOF_WINDOW_SECONDS:
            return True
        self.send_json(
            401,
            {
                "error": "the proof's timestamp is more than %d s from the registrar's clock; sign the "
                "request again with ts near serverTime" % PROOF_WINDOW_SECONDS,
                "serverTime": now,
            },
            self.discard_body() + (("WWW-Authenticate", CHALLENGE),),
        )
        return False

    def exchange_id(self):
        path = getattr(self, "path", "")
        if not path.startswith(PREFIX):
            return None
        exchange_id = path[len(PREFIX) :]
        if not exchange_id or "/" in exchange_id or "?" in exchange_id or "#" in exchange_id:
            return None
        return exchange_id

    def read_body(self, empty_when_unsized=False):
        length = self.headers.get("Content-Length")
        if length is None and empty_when_unsized and "Transfer-Encoding" not in self.headers:
            return b""
        if length is None or not length.isdigit():
            self.refuse(411, "send the request body with a Content-Length")
            return None
        if int(length) > MAX_BODY_BYTES:
            self.refuse(413, "the request body is over %d bytes" % MAX_BODY_BYTES)
            return None
        return self.rfile.read(int(length))

    def write_table(self, operation, extra_headers=()):
        # One write at a time from this process; SQLite's lock orders it
        # against the scripts and the sweep.
        with self.server.table_lock:
            try:
                conn = relay_table.open_table()
                try:
                    return operation(conn)
                finally:
                    conn.close()
            except relay_table.Refused as error:
                self.send_json(409, {"error": str(error)}, extra_headers)
            except relay_table.TableError as error:
                sys.stderr.write("%s\n" % error)
                self.send_json(500, {"error": str(error)}, extra_headers)
        return None

    def do_OPTIONS(self):
        # A browser's CORS preflight carries no Authorization header, so it is
        # answered without one and does nothing.
        closing = self.discard_body()
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, PUT, DELETE")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Content-Length", "0")
        for name, value in closing:
            self.send_header(name, value)
        self.end_headers()

    def target(self, verb):
        """The request's exchange id once it is well formed; otherwise the
        request is answered here and None returned."""
        exchange_id = self.exchange_id()
        if exchange_id is None:
            self.refuse(404, "%s at %s %s<exchange-id>" % (verb, self.command, PREFIX))
            return None
        if not valid_exchange_id(exchange_id):
            self.refuse(400, ID_REFUSAL)
            return None
        return exchange_id

    def read_registration(self, exchange_id):
        """(raw body, key, maxAgeDays) of a well-formed registration body;
        otherwise the request is answered here and None returned."""
        if relay_table.is_verify_id(exchange_id) and self.headers.get(VERIFY_RUN_HEADER) != "1":
            self.refuse(400, VERIFY_ID_REFUSAL)
            return None
        raw = self.read_body()
        if raw is None:
            return None
        try:
            body = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            self.send_json(400, {"error": "the request body is not JSON"})
            return None
        if not isinstance(body, dict) or set(body) != {"key", "maxAgeDays"}:
            self.send_json(400, {"error": BODY_REFUSAL})
            return None
        if not valid_key(body["key"]):
            self.send_json(400, {"error": KEY_REFUSAL})
            return None
        if not valid_max_age_days(body["maxAgeDays"]):
            self.send_json(400, {"error": MAX_AGE_REFUSAL})
            return None
        return raw, body["key"], body["maxAgeDays"]

    def answer_registration(self, journal, registration):
        message = relay_table.describe_registration(registration)
        sys.stderr.write("%s: %s\n" % (journal, message))
        lapses_at = registration["lapses_at"]
        self.send_json(
            200,
            {
                "message": message,
                "maxAgeDays": registration["max_age_days"],
                "lapsesAt": None if lapses_at is None else relay_table.iso_time(lapses_at),
            },
        )

    def do_POST(self):
        credential = self.credential()
        if credential is None:
            return
        if credential is not TOKEN:
            self.refuse(
                401,
                "enroll with Authorization: Bearer <relay-owner token>; a proof rotates or revokes an "
                "enrolled exchange",
                (("WWW-Authenticate", CHALLENGE),),
            )
            return
        exchange_id = self.target("enroll")
        if exchange_id is None:
            return
        registration = self.read_registration(exchange_id)
        if registration is None:
            return
        _, key, max_age_days = registration
        enrollment = self.write_table(
            lambda conn: relay_table.enroll(conn, REALM, exchange_id, key, max_age_days, time.time(), True)
        )
        if enrollment is not None:
            self.answer_registration("enroll", enrollment)

    def do_PUT(self):
        credential = self.credential()
        if credential is None or (credential is not TOKEN and not self.fresh(credential)):
            return
        exchange_id = self.target("register")
        if exchange_id is None:
            return
        registration = self.read_registration(exchange_id)
        if registration is None:
            return
        raw, key, max_age_days = registration
        if credential is TOKEN:
            written = self.write_table(
                lambda conn: relay_table.register(conn, REALM, exchange_id, key, max_age_days, time.time(), True)
            )
            if written is not None:
                self.answer_registration("register (relay-owner token)", written)
            return

        def holds(current):
            # A body naming the held key shows possession of it as fully as a
            # MAC under it: that is a renewal, which the second party to
            # register a rotated key makes under the key its partner has
            # already replaced.
            if hmac.compare_digest(key.encode("ascii"), current.encode("ascii")):
                return True
            return credential.made_under(current, "PUT", exchange_id, raw)

        written = self.write_table(
            lambda conn: relay_table.rotate(conn, REALM, exchange_id, key, max_age_days, time.time(), holds, True)
        )
        if written is not None:
            self.answer_registration("register (proof)", written)

    def do_DELETE(self):
        credential = self.credential()
        if credential is None or (credential is not TOKEN and not self.fresh(credential)):
            return
        exchange_id = self.target("revoke")
        if exchange_id is None:
            return
        if credential is TOKEN:
            closing = self.discard_body()
            revocation = self.write_table(lambda conn: relay_table.revoke(conn, exchange_id), closing)
            journal = "revoke (relay-owner token)"
        else:
            closing = ()
            raw = self.read_body(empty_when_unsized=True)
            if raw is None:
                return
            revocation = self.write_table(
                lambda conn: relay_table.revoke_with_proof(
                    conn, exchange_id, lambda current: credential.made_under(current, "DELETE", exchange_id, raw)
                )
            )
            journal = "revoke (proof)"
        if revocation is None:
            return
        message = relay_table.describe_revocation(revocation)
        sys.stderr.write("%s: %s\n" % (journal, message))
        self.send_json(200, {"message": message}, closing)

    def refuse_method(self):
        # Reached through send_error's 501 for every method with no do_ handler.
        if self.credential() is not None:
            self.refuse(
                405, "use POST, PUT or DELETE on %s<exchange-id>" % PREFIX, (("Allow", "POST, PUT, DELETE"),)
            )


class RegistrarServer(http.server.ThreadingHTTPServer):
    daemon_threads = True

    def server_bind(self):
        # HTTPServer's own server_bind looks up the bound address's hostname,
        # which nothing here reads; where the resolver is slow that held the
        # start for 70 s (measured on a macOS runner).
        socketserver.TCPServer.server_bind(self)
        self.server_name = REALM
        self.server_port = self.server_address[1]

    def handle_error(self, request, client_address):
        error = sys.exc_info()[1]
        sys.stderr.write("%s connection ended: %s\n" % (client_address[0], error))


def main():
    if not PORT.isdigit() or int(PORT) > 65535:
        fail_start("ALCOVE_RELAY_REGISTRAR_PORT is '%s'; set it to a port number" % PORT)
    if not REALM:
        fail_start("ALCOVE_RELAY_REALM is unset; the unit reads it from /etc/alcove-relay/relay.env")
    token = read_token()
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    try:
        context.load_cert_chain(os.path.join(CERT_DIR, "fullchain.pem"), os.path.join(CERT_DIR, "privkey.pem"))
    except (OSError, ssl.SSLError) as error:
        fail_start("could not load the certificate in %s: %s" % (CERT_DIR, error))

    try:
        server = RegistrarServer(("", int(PORT)), RegistrarHandler)
    except OSError as error:
        fail_start("could not listen on port %s: %s" % (PORT, error))
    server.token = token
    server.table_lock = threading.Lock()
    server.socket = context.wrap_socket(server.socket, server_side=True, do_handshake_on_connect=False)
    sys.stdout.write("Alcove relay registrar listening on port %d\n" % server.server_address[1])
    sys.stdout.flush()
    server.serve_forever()


if __name__ == "__main__":
    main()
