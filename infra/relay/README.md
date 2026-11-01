# The Alcove standing relay: a reference for a dedicated instance

Everything needed to bring up a self-hosted TURN relay that carries an Alcove
WebRTC exchange for a party on a network that blocks UDP or admits only TCP/443:
a digest-pinned coturn image, a hardened configuration, the systemd unit that
supervises it, a front that holds 443 and routes each connection by the name
it asks for, an ACME renewal that keeps its certificate current, scripts that
register and revoke each exchange's relay key, an optional HTTPS registrar that
enrolls an exchange under the relay-owner token, or without one where the
operator turns that on, and rotates or revokes it under
a proof of holding its key, a sweep that revokes
lapsed keys, an optional [WebSocket relay](#the-websocket-relay) behind the
same front for a network that stops TURN, and a verification script that asks
the deployed relay whether it is doing its job.

The relay runs on a **dedicated instance**, provisioned from this reference
rather than configured by hand. [`aws/provision.md`](aws/provision.md) is how one
is launched on AWS; the two `demo-*.sh` scripts beside it stop and start the
separate always-on demo box, which carries the demo SFTP server and is not this.

## What the relay sees

**The relay carries the encrypted WebRTC channel and nothing else.** A TURN
server forwards DTLS without terminating it, so what passes through it is
ciphertext: it sees addresses, timing, and volume, and no exchange data at any
point. That is not a design intention -- it was measured. An interception point
sitting on the relay path read only the STUN and TURN envelope, about 13 KB each
way, while both parties still resolved the correct intersection (see
[the deployment record](../../docs/notes/webrtc-relay-deployment.md), question 1,
and [SECURITY_DESIGN.md](../../docs/SECURITY_DESIGN.md#channel-security) for the
posture the measurement confirms).

The consequence for an agency reviewing a deployment: the relay is not a place
where personal data is processed, and hosting it does not put the host inside the
data path. A party that will not accept a relay it does not operate can run this
one itself, which is the whole reason a self-hosted reference exists beside the
managed option.

## Design records and tests

This reference is verified this far, and a claim beyond it is one to check in
your own environment:

- The docker path runs end to end on an instance launched from
  [`aws/provision.md`](aws/provision.md), with `verify.sh` passing every probe.
- The podman/Quadlet path and the per-exchange secrets table run on stand-in
  hosts beside the pinned coturn image, not on a relay instance.
- The registrar, the lapse sweep, and `max-allocate-lifetime` run beside the
  pinned coturn image on a docker host and a podman host, both installed by
  `install.sh`.
- [The 443 front](#the-443-front) is installed on the project's relay host
  and passed `verify.sh` through it (13 checks), with signaling answering on
  443, in its one-hop form. Its route hop, the registrar behind it with the
  client's address in the PROXY header, its TURN server terminating TLS and
  passing the client's address to coturn, and a relayed exchange from a
  443-only client are not yet measured there. The pinned coturn taking a
  PROXY v1 header on its `tcp-proxy-port`, and using the header's address
  as the client's, was driven in Docker on 2026-10-14. Its tests under
  `scripts/` drive `render-front.sh` and hold the template to coturn's
  listener, not nginx; the registrar's tests drive its PROXY header reader
  with a header written by the test, and `stun-binding.py`'s tests drive it
  against a STUN answer written by the test, not by nginx or coturn.
- [The OS update](#os-updates) has not yet run on the project's relay
  host, so where the host records its release lock, and what its first run
  restarted, are not yet recorded here.
- `verify.sh` probes the allocation and its refusals, not exchange traffic,
  unless `ALCOVE_RELAY_VERIFY_PEER` names a responsive peer. What a relayed
  exchange through this relay covers is in
  [standing-relay-delivery.md](../../docs/notes/standing-relay-delivery.md).
- [The WebSocket relay](#the-websocket-relay), its unit, its route on the
  front and its `verify.sh` probe ran on the project's relay host on
  2026-10-19, installed from the promoted `main` by the host pull and
  `install.sh`. The probe passed through the front (25 checks, none
  failing): two sockets paired and a 32-byte message crossed. nginx loaded
  the front's WebSocket relay server there, and from the public internet the
  upgrade at `/relay` was answered 101 and at another path 404. The tests drive `websocket-pair.py`
  against the relay itself, started as its unit starts it, behind a TLS
  server the test runs in the front's place, with keys
  `register-exchange.sh` wrote, and `websocket-address-limit.py` against it
  behind such a server holding a bound for each address of its own. On the
  project's relay host on 2026-10-25, the front's bound counted the address
  the PROXY header names: 8 sockets from the host's private address and one
  from `127.0.0.1` were upgraded, a ninth from the private address was
  closed during the TLS handshake, and with the bound removed that ninth
  socket was upgraded.
- [The counts publisher and the alarms](#monitoring) ran on the project's
  relay host on 2026-10-15; [the runbook's block
  command](#when-an-alarm-fires) has not yet run there. The tests drive the
  publisher against a stubbed `aws` and hold its timer out of the busy hours.

The measurement this reference implements, and the shapes it rules out, are in
[`docs/notes/webrtc-relay-deployment.md`](../../docs/notes/webrtc-relay-deployment.md);
the delivery decision is in
[`docs/notes/standing-relay-delivery.md`](../../docs/notes/standing-relay-delivery.md).
Neither is restated here.

Nothing in this directory runs coturn in CI. Tests under `scripts/` drive
`certs/deploy-hook.sh`, `relay_table.py`, the key scripts, the sweep, the
registrar, `verify.sh`'s cleanup and registrar probe, and `render-config.sh`
against a fixture host whose `turndb` is a real SQLite file holding coturn's
`turn_secret` table. `scripts/relay-websocket.test.mjs` runs the WebSocket
relay itself against such a file, for `websocket-pair.py`. `scripts/relay-host-schedule.test.mjs` holds every daily
timer on the host to [the daily schedule](#the-daily-schedule) and each daily
unit's `ExecStart` to the maintenance lock's shape.
`scripts/relay-turn-secret-schema.test.mjs` holds that
table's shape to the pinned image: where docker or podman answers, the image's
own `turnadmin` creates a table, `relay_table.py` reads its row and writes its
own, and `turnadmin` lists the result; where neither answers, the test is
reported as skipped rather than passed. None of it is a build input. The one
other repository-level coupling is the docker Dependabot entry for
`/infra/relay`, which raises a base image bump as a pull request.

## Order of operations

1. Hold an elastic address, create the DNS A record for the relay's name, and
   one for the registrar's name and the WebSocket relay's where each gets one,
   and launch the instance -- [`aws/provision.md`](aws/provision.md). A host
   that runs the WebSocket relay also needs the Node workspace tree
   [The WebSocket relay](#the-websocket-relay) names.
2. Put `/etc/alcove-relay/relay.env` on the host from
   [`relay.env.example`](relay.env.example) and set the realm, and the names
   [the 443 front](#the-443-front) routes. Every script refuses to run without
   it; nothing defaults to a hostname.
3. Put `/etc/alcove-relay/acme.env` from [`certs/env.example`](certs/env.example)
   at mode 600, with the DNS provider's credential.
4. Run `install.sh` as root. It adds [`/swapfile`](#os-updates) where it is not
   set up, installs a container runtime, builds the image,
   creates the data directory for the secrets table, obtains a certificate,
   renders the configuration, installs the unit and the three timers, on
   Amazon Linux 2023 the [OS update](#os-updates) timer, where `relay.env`
   names a metrics region the [counts publisher](#monitoring)'s timer,
   starts the relay, starts the registrar where the host holds its token,
   starts the WebSocket relay where `relay.env` names it, and runs
   `verify.sh`.
5. Read `verify.sh`'s output. A relay that starts and cannot allocate looks
   identical from the console.
6. Per exchange: `register-exchange.sh <exchange-id> <max-age-days|none>`
   with the exchange's relay key on standard input, and
   `revoke-exchange.sh <exchange-id>` when it ends -- see [Per-exchange keys](#per-exchange-keys) -- or the same through
   [the registrar](#the-registrar). The parties mint their own credentials from
   that key.

`install.sh` is idempotent. Run it again after an edit to the template, the unit,
or the Dockerfile and it converges. A re-run that stops partway through moving a
host from the layout where coturn terminates TLS to the one where the front does
can leave the front or coturn unable to start, until `install.sh` is run again to
completion.

These steps bring up a new host. On the project's host, later commits of
`main` reach the relay through [the host pull](../host-pull/README.md), which
runs this directory's `install.sh`, and so `verify.sh`, from each new commit's
tree, and rolls back to the previous commit when either fails. The pull is
opt-in: a host built from this reference without it takes a later commit only
when its operator runs `install.sh` from that commit's checkout.

## The files

| path | what it is |
| --- | --- |
| `Dockerfile` | The base image pin, and nothing else. One line of instruction: `coturn/coturn` at a tag and its multi-arch index digest. The single home of that digest -- every other file names the locally built `localhost/alcove-relay:installed` tag, so a base move is exactly one edit. Its comment carries the fallback if the community image stops publishing |
| `turnserver.conf.tmpl` | The hardened coturn configuration, with `__PLACEHOLDER__` values. coturn's one listener is its `tcp-proxy-port`, plain TURN over TCP on loopback, port 5350, behind [the 443 front](#the-443-front), which terminates TLS. It sets `no-tcp-relay`, because the exchange never asks for a TCP relay transport to a peer, and `verify.sh` probes that such an allocation is refused. Tracked; the rendered file is not |
| `front.conf.tmpl`, `render-front.sh` | [The 443 front](#the-443-front)'s nginx configuration and the script that writes this host's routes into it. `install.sh` checks the result with `nginx -t` before it writes `/etc/alcove-relay/front.conf` |
| `front/Dockerfile`, `alcove-relay-front.container`, `alcove-relay-front-docker.service` | The front's nginx image pin, and its unit on a podman host and on a docker host, paired as the relay's two units are. Both run `alcove-relay-front.service` from the tag `install.sh` builds, with the relay's certificate mounted |
| `stun-binding.py` | One STUN Binding over TLS, printing the client address the server answers with; `verify.sh` runs it through the front and fails on a loopback answer |
| `render-config.sh` | Substitutes the template at mode 600. Run at install and again on every start, because a stopped and started instance comes back on a different address and a stale `external-ip` advertises a candidate nobody can reach. The cloud seam is one variable: an executable printing `<public>/<private>` |
| `alcove-relay.container` | The Quadlet unit for a podman host, installed at `/etc/containers/systemd/`. systemd is the only supervisor; there is no container daemon under it |
| `alcove-relay-docker.service` | The same container on a docker host: a plain systemd unit running `docker run` in the foreground, installed as `/etc/systemd/system/alcove-relay.service`. Same image, mounts, and flags as the Quadlet unit -- the two are edited together |
| `alcove-relay-verify.service`, `.timer` | The daily verification. A standing relay is idle between exchanges, so nothing else notices it stopped carrying allocations until a partner is waiting on one |
| `alcove-relay-os-update.service`, `.timer` | The daily OS update on Amazon Linux 2023. See [OS updates](#os-updates) |
| `install.sh` | The whole install, idempotent |
| `relay_table.py` | The one write path to the secrets table: register, revoke, and sweep, each one SQLite transaction, as the relay image's account. Everything below that touches the table calls it. See [Per-exchange keys](#per-exchange-keys) |
| `register-exchange.sh`, `revoke-exchange.sh`, `exchange-keys.sh` | Add and remove one exchange's relay key, through `relay_table.py`; the third is the shared part both source, and `sweep-exchanges.sh` and `verify.sh` too. See [Per-exchange keys](#per-exchange-keys) |
| `import-legacy-mapping.sh` | Carries the text mapping an install from before the secrets table's own mapping kept into the table, and deletes it once the table reads back every row; `install.sh` runs it. See [Per-exchange keys](#per-exchange-keys), The mapping |
| `sweep-exchanges.sh`, `alcove-relay-sweep.service`, `.timer` | Revokes every exchange whose registration has lapsed, every ten minutes. See [Per-exchange keys](#per-exchange-keys), Lifetime |
| `registrar.py`, `alcove-relay-registrar.service` | The optional HTTPS registrar, which registers and revokes through `relay_table.py`: it enrolls an exchange for a caller holding the relay-owner token, or for any caller where enrollment without a token is on, and rotates or revokes it for a caller proving it holds the exchange's key. See [The registrar](#the-registrar) |
| `alcove-relay-websocket.service` | The optional [WebSocket relay](#the-websocket-relay) on `127.0.0.1`, from the host's Node workspace tree, as the relay image's account; `install.sh` fills in that account and the relay's port and starts it only where `relay.env` names the relay |
| `websocket-pair.py` | Two sockets at the WebSocket relay over TLS, paired under one exchange's key and passing one message and the close; `verify.sh` runs it through the front |
| `websocket-address-limit.py` | Eight sockets at the WebSocket relay over TLS from one address and one from another, all upgraded, and a ninth from the first, closed unanswered; `verify.sh` runs it through the front to check its bound for each client address |
| `verify.sh` | Drives a real TURNS handshake, a Binding through the front that coturn must answer with the client's own address rather than a loopback one, a real allocation, a probe that an allocation toward an internal address is refused, and the secrets table: two keys registered for the run both allocate, an unregistered key and a credential keyed with a key's decoded bytes are refused, and a revoked key's new allocation is refused. Each name in `ALCOVE_RELAY_FRONT_ROUTES` must answer on 443 with a certificate that verifies for it. Where the host holds a registrar token it also asks the registrar, at its own name on 443 where it has one: a registration with the token reaches the mapping and the table, calls with no token or a wrong one are then answered 401 and change nothing, and a revocation with the token removes the key from both; with no token it says it skipped the registrar. Where `relay.env` names the WebSocket relay it runs `websocket-pair.py` through the front at that name: two sockets pair under a key registered for the run, and one message and the close cross; it then runs `websocket-address-limit.py` through the front from the address it connects from and from `127.0.0.1`. With no name it says it skipped the WebSocket relay. Its exchanges are under the ids `alcove-verify-a`, `-b`, `-registrar`, and `-websocket`, a prefix every other caller is refused. On exit it revokes them, each in one transaction, and warns naming the exchange id, never the key, for any it could not revoke. Passes only on an observed refusal: a question that could not be asked reports UNCLEAR and fails. Connects to the realm's name by default; `ALCOVE_RELAY_VERIFY_CONNECT` overrides the TCP connect target while the realm still names the SNI and TURN realm -- `install.sh` sets it to the instance's private address for the end-of-install run, because EC2 does not hairpin an instance's traffic back to its own Elastic IP, while the daily timer stays on the public name so it fails if that path breaks. `ALCOVE_RELAY_VERIFY_WAIT` sets how many seconds it retries a TLS handshake for the realm through the 443 front, and then a Binding through it to coturn, waiting for a just-(re)started front and coturn behind it to come up; 30 by default |
| `mint-credential.sh` | One time-limited credential under the static secret, on a host that holds one: `<expiry>:<name>` as the username, the base64 HMAC-SHA1 of it as the password |
| `relay.env.example` | The host's one configuration file, copied to `/etc/alcove-relay/relay.env` |
| `certs/` | ACME DNS-01 renewal: the timer and its unit, the client-neutral `renew.sh`, the deploy hook, and the provider credential's example |
| `aws/` | The AWS-specific half: instance provisioning, the IMDSv2 external-address helper, the registrar's counts publisher, and the demo box's stop/start scripts |
| `aws/publish-metrics.sh`, `aws/alcove-relay-metrics.service`, `.timer` | Publishes the registrar's counts to CloudWatch every 5 minutes outside the host's busy hours, where `relay.env` names a region. See [Monitoring](#monitoring) |

## Per-exchange keys

Each exchange has its own relay key, derived from the exchange's shared secret
([PROTOCOL.md, Relay credential derivation](../../docs/spec/PROTOCOL.md#relay-credential-derivation)).
The relay holds one row per registered exchange in coturn's `turn_secret` table,
in the SQLite file `/var/lib/alcove-relay/turndb` (mounted at
`/var/lib/coturn/turndb`), and accepts a credential minted under any row.

Run both scripts as root on the relay host, from `/opt/alcove-relay`, or call
[the registrar](#the-registrar), which writes through the same code:

```sh
register-exchange.sh <exchange-id> <max-age-days|none>   # the key on standard input
revoke-exchange.sh <exchange-id>
```

- **The arguments.** The exchange id is 1 to 128 of `[A-Za-z0-9._-]`, not
  starting with `-`. An id containing a run of 64 hex characters of either
  case is refused, so a key passed in the id's place is never registered or
  journaled, and so is an id starting with `alcove-verify-`, which `verify.sh`
  registers and revokes on every run. max-age-days is a whole number of days
  from 1 to 36500, or `none` for a row that never lapses -- see Lifetime below;
  it is required, so a registration never clears a lapse by leaving it out.
  Either script refuses a malformed argument and names it, without printing the
  value.
- **The key.** 64 lowercase hex characters, the form coturn keys its HMAC with,
  read from standard input: typed at a terminal, where it is not echoed, or
  piped. It is never an argument, so it does not reach the process table, the
  shell's history, or a `sudo` log:

  ```sh
  printf '%s\n' "$KEY" | /opt/alcove-relay/register-exchange.sh exchange-1 90
  ```

- **Registering.** Adds the key's row and maps the exchange to it. An exchange
  already registered has its prior row deleted in the same transaction, so the
  relay holds only its current key from the moment the call returns -- register
  again after each [rotation](../../docs/spec/PROTOCOL.md#shared-secret-rotation).
  Registering the key an exchange already holds renews its row: the new
  registration time and the call's max-age-days. A key another exchange holds
  is refused. The message states the resulting lapse.
- **Revoking.** Deletes the exchange's row and its mapping in one transaction,
  whether by `revoke-exchange.sh`, the registrar, or the sweep. Measured against
  coturn 4.18.0, what a revoke does and does not do:
  - A new allocation under the key is refused within about 200 ms, with no
    restart.
  - An allocation already open is NOT cut. Its client keeps it for as long as
    it keeps refreshing: refreshes under a revoked key and an expired credential
    went on succeeding until the client exited, twelve minutes past the
    credential's expiry, and coturn accepted every forced re-authentication
    after a stale nonce, with the default nonce lifetime and with
    `stale-nonce=60` alike. Neither a revoke nor a credential's expiry ends a
    client that keeps refreshing, and a shorter `stale-nonce` does not help.
  - `turnserver.conf.tmpl` sets `max-allocate-lifetime=600`, the longest
    lifetime one allocate or refresh is granted. That bounds only a client that
    stops refreshing: coturn closed such an allocation 600 s after its last
    refresh.
- **Lifetime.** A row registered with max-age-days lapses that many days after
  its registration, and the sweep -- `sweep-exchanges.sh`, or
  `alcove-relay-sweep.timer` every ten minutes -- revokes it within about
  eleven minutes. A lapsed row still authenticates until the sweep deletes
  it. Registering
  the exchange's next key, or its current key again, replaces the row and
  restarts the count, so each run's registration is the renewal and an exchange
  that keeps running is never swept. max-age-days is the managed-exchange
  record's `tokenMaxAgeDays`
  ([MANAGED_EXCHANGE_RECORD.md, Persisted across runs](../../docs/spec/MANAGED_EXCHANGE_RECORD.md#persisted-across-runs)): each successful run stamps the stored secret's
  `expires` that many days out and rotates the secret, and the relay forgets
  the exchange's key at the same bound after which the record's secret lapses
  and a re-invite is needed. Its ceiling, 36500, is core's
  `MAX_TOKEN_MAX_AGE_DAYS` (`packages/core/src/config/connection.ts`). The
  record's policy is off by default; a row registered with `none`, like a record
  with no policy, has no lapse and lives until it is revoked or replaced. There
  is no relay-side setting for the lapse, except for a row
  [the registrar](#the-registrar) enrolls without a token: it lapses at a
  time the registrar fixes, which a later registration under a proof does
  not move.
- **The mapping.** `turn_secret` is keyed by realm and key and holds no exchange
  id, so `relay_table.py` keeps a second table in the same file,
  `alcove_exchange`: the exchange id, the realm, the key, the Unix time of the
  registration, max-age-days (empty for no lapse), and, for a row enrolled
  without a token, the Unix time it lapses (`fixed_lapse_at`; such a row also
  holds a max-age-days of 1, so the sweep of an install that does not read
  that column, as after a rollback, still revokes it within a day). coturn
  reads neither the
  table nor anything else it does not know. One file means a register, revoke,
  or sweep is one SQLite transaction across the row and the mapping: it lands
  whole or not at all, and its result is the write's own, with nothing read
  back. `install.sh` carries a mapping an earlier install kept in
  `/etc/alcove-relay/exchange-keys` into the table once, through
  `import-legacy-mapping.sh`, and deletes that file, which holds every key in
  plaintext, once the table, read back, accounts for each of its rows: each
  exchange carried in reads back, no key in the file is listed without an
  exchange mapping it, or mapped without being listed, and a key the table
  maps is mapped to the row's own exchange. If the import fails, the file is
  kept unchanged and `install.sh` stops. If the import lands but the table
  does not account for a row, the file is moved to `exchange-keys.imported`
  and `install.sh` warns, naming the exchange ids; remove a key listed with
  no exchange mapping it with `forget-key`, delete from
  `exchange-keys.imported` a row whose key another exchange holds (a key maps
  to one exchange only; register that exchange again with a key of its own
  if it is still in use), and run `install.sh` again. A file is imported
  once only: every later run checks `exchange-keys.imported` the same way,
  never imports it again, and deletes it once the table accounts for it, so
  an exchange revoked or swept since stays revoked, and a row removed from
  the file is not carried in. Deleting either file deletes
  `exchange-keys.lock` beside it too; a kept or moved file keeps the lock.
- **How they reach the table.** `relay_table.py`, on the host's own `python3`
  and its `sqlite3` module, opens `/var/lib/alcove-relay/turndb` as the relay
  image's account -- a script run as root drops to the account that owns the
  file first -- so every file SQLite creates beside it is one coturn can use. No
  container runtime is involved. It never creates `turndb`: coturn does at its
  first start, and until then every call exits 1 naming the file. A table that
  cannot be written -- read-only, unopenable, locked past 10 s -- exits 1 with
  SQLite's own reason, having changed nothing. A row no exchange maps -- one
  added by hand -- is removed by value, the key on standard input:
  `printf '%s\n' "$KEY" | python3 /opt/alcove-relay/relay_table.py forget-key`,
  with `relay.env`'s variables in the environment. It removes the row and any
  mapping of the key in `ALCOVE_RELAY_REALM`, in one transaction, and like
  `status` exits 2 naming the variable when it is unset. An `alcove-verify-` row
  the import skips -- a verify run that died before cleaning up -- gets no
  mapping, so if an earlier install already wrote its key into the table
  that key stays until it is removed with `forget-key`, the key taken from
  the legacy file, which `install.sh` keeps until then.
- **A replaced `turndb` needs a restart.** coturn holds the file open. A
  `turndb` deleted or replaced under a running coturn -- by hand, or a restore
  from backup -- leaves the server reading the file it opened while every write
  lands in the new one: a revoke reports success while the key still
  allocates, and a registration does not allocate. After touching the file,
  `systemctl restart alcove-relay.service`.

**The static secret is optional.** A host holding
`/etc/alcove-relay/static-auth-secret` renders it beside the table, and coturn
accepts a credential under the static secret or any row -- measured, so a
relay can move to per-exchange keys with its static secret still set, while
credentials from `mint-credential.sh` keep working. To finish the move, delete
the file and restart `alcove-relay.service`. `install.sh` keeps a secret it
finds and mints none.

## The registrar

An HTTPS service beside coturn that enrolls, rotates, and revokes an exchange's
key, so a browser inviter can register the key it rotates to at the end of
each run without shell access to the relay host. It is optional: `install.sh`
runs it only on a host holding `/etc/alcove-relay/registrar-token`. To turn it
on:

```sh
(umask 077; openssl rand -hex 32 > /etc/alcove-relay/registrar-token)
/opt/alcove-relay/install.sh   # or the checkout's install.sh
```

Give the token to the relay's operator, who needs it only to enroll an
exchange and to recover one, and never puts it in a served bundle. To turn the
registrar off, delete the file and run `install.sh` again. To replace the
token, overwrite the file and
`systemctl restart alcove-relay-registrar.service`. The registrar can also
enroll an exchange for a caller holding no token, such as a browser party
whose operator gave it none; that is turned on in `relay.env` -- see
[Enrollment without a token](#enrollment-without-a-token) below.

- **Two ways to authenticate.** Every request but a CORS preflight, and an
  enrollment without a token where that is on, holds one credential in its
  `Authorization` header:
  - **The relay-owner token**, `Authorization: Bearer <token>`, enrolls an
    exchange the relay does not yet hold (`POST`). It also registers or revokes
    any exchange unconditionally (`PUT`, `DELETE`): that is the operator's
    recovery route, below.
  - **A proof**, `Authorization: Alcove-Relay-Proof ts=<unix-seconds>,mac=<hex64>`,
    shows the caller holds the key the exchange has registered, and rotates
    (`PUT`) or revokes (`DELETE`) that exchange. Its format, the key it is
    signed under, and test vectors are in
    [PROTOCOL.md, The registrar request proof](../../docs/spec/PROTOCOL.md#the-registrar-request-proof);
    core's `relayRegistrarAuthorization` makes one. It holds no token, so the
    routine calls after enrollment never need the token.

  A request with neither, other than that enrollment, a wrong token, or a
  malformed proof is answered 401 and nothing is written. A proof whose `ts` is more than 300 s from the
  registrar's clock is answered 401 with `serverTime`, the registrar's Unix
  seconds, so a caller whose clock has drifted signs again. A CORS preflight
  (`OPTIONS`) is answered 204 without a credential and does nothing. Any other
  method -- `GET`, `TRACE`, `PROPFIND`, anything but `POST`, `PUT`, `DELETE`,
  and `OPTIONS` -- is answered 401 without a credential and 405 with one, in
  JSON, and writes nothing.
- **The calls.**

  | request | credential | writes | answer |
  | --- | --- | --- | --- |
  | `POST /exchanges/<exchange-id>` with `{"key": "<key-hex64>", "maxAgeDays": <days> \| null}` | token | the key's row and the exchange's mapping, for an id not yet enrolled | 200 and `{"message": ..., "maxAgeDays": ..., "lapsesAt": ...}` |
  | `PUT /exchanges/<exchange-id>` with the same body | proof | the new key in place of the one proven, or a renewal of the key held | as `POST` |
  | `DELETE /exchanges/<exchange-id>` | proof | what `revoke-exchange.sh <exchange-id>` writes | 200 and `{"message": ...}` |
  | `PUT` or `DELETE`, as above | token | what `register-exchange.sh <exchange-id> <days\|none>` or `revoke-exchange.sh <exchange-id>` writes, whatever key the exchange holds | as above |
  | `POST /exchanges/<exchange-id>` with `{"key": "<key-hex64>", "maxAgeDays": null}`, where enrollment without a token is on | none: no `Authorization` header | as the token's `POST`, the row lapsing at a time the registrar fixes | as `POST`, `maxAgeDays` `null` and `lapsesAt` the fixed lapse |

  - **Enrolling** is create-only. Enrolling an exchange again with the key it
    holds changes nothing and is answered 200 with the registration as held,
    so a caller can repeat a call whose answer it lost; enrolling it with any
    other key is answered 409.
  - **A rotation** replaces the key only if the proof verifies under the key the
    exchange holds when the write takes the table's lock: a compare-and-swap,
    so of two rotations proven under one key only the first lands, and a
    proof made under a key since replaced is answered 409. A `PUT` naming the
    key the exchange already holds renews it, whichever key its proof was made
    under, so the second party to register a rotated key renews the row rather
    than failing; the renewal restarts the lapse and takes `maxAgeDays` from
    the body.
  - **A revocation** under a proof deletes the row only if the proof verifies
    under the key the exchange holds. A proof for an exchange not enrolled is
    answered 409. The two 409 messages tell a caller holding no key whether an
    id is enrolled, so choose exchange ids that reveal nothing about the
    parties.

  `maxAgeDays` is required: a whole number of days, or `null` for a row that
  never lapses. A body that leaves it out is refused, so a re-registration
  cannot clear a lapse by omission, and the answer states the resulting lapse:
  `maxAgeDays` as registered and `lapsesAt` as an ISO 8601 UTC time, or `null`.
  The registrar checks the exchange id, the key, and `maxAgeDays` against the
  rules in [Per-exchange keys](#per-exchange-keys), The arguments, and answers a
  value that fails them 400 with a fixed message naming the field, never the
  value, before anything is written. An id starting with `alcove-verify-` is
  refused 400 unless the request carries `Alcove-Relay-Verify-Run: 1`, which
  `verify.sh` sends and which the preflight does not allow a browser to send.
  An enrollment without a token of such an id is also refused 400 unless its
  client address is loopback -- the connection's own on the registrar's port,
  the one the front's PROXY header names on the front's -- since any other
  client can send that header; `verify.sh`, which runs on the relay host,
  sends those enrollments to `127.0.0.1`. A
  body that is not that JSON object is answered 400, one over 1024 bytes 413,
  and one without a `Content-Length` 411; a revocation under a proof may send
  no body, which it signs as empty. A request line or header block the
  registrar cannot parse is answered in JSON with the connection closed, as
  is a request line over 4096 bytes (414) and a request line and headers over
  8192 bytes together (431). A refusal on the exchange's state -- a key
  another exchange holds, an id not registered, a proof that does not verify
  under the key held -- is answered 409 with `{"error": ...}`, which never
  contains the key. A table that cannot be read or written is answered 500
  with one fixed message, and the cause, naming the table's file, goes to the
  registrar's journal only. A proof is checked before the table is opened for
  writing, and one write runs at a time.
- **Bounds on a connection.** A connection's TLS handshake and first request,
  and each later request on it, must arrive whole within 15 s, however the
  bytes are spaced, or the connection is closed. Sending a response has its own
  15 s bound (`RESPONSE_DEADLINE_SECONDS`), and a write waits for the
  registrar's in-process lock no longer than its request's deadline, answering
  503 with `Retry-After` and writing nothing past it. The SQLite lock wait
  inside the table open and transaction is bounded separately by
  `BUSY_TIMEOUT_SECONDS` (10 s), whatever the deadline; if an outside holder
  keeps the lock past that, the answer is the fixed 500, not a 503. At most 32 connections are
  served at once; past that, up to 8 more are answered 503 with
  `Retry-After: 5` and any further ones are closed unanswered. A connection in
  that busy band gets the 503 only when it sends its request within 5 s
  (`BUSY_DEADLINE_SECONDS`); one that stalls is closed unanswered. The
  `Retry-After` value is `RETRY_AFTER_SECONDS`, which follows the busy
  deadline. These bounds, and the 4096 and 8192 byte limits above, are
  arbitrary working values set by `REQUEST_DEADLINE_SECONDS`,
  `RESPONSE_DEADLINE_SECONDS`, `MAX_HANDLERS`,
  `MAX_BUSY_ANSWERS`, `BUSY_DEADLINE_SECONDS`, `RETRY_AFTER_SECONDS`,
  `MAX_REQUEST_LINE_BYTES` and `MAX_HEAD_BYTES` in `registrar.py`, and are
  raised on request.
- **Recovery is the operator's action.** An exchange whose key nobody holds any
  more -- a key lost, or a registrar holding a key the caller no longer has --
  is recovered by the relay's operator, deliberately: the token on `PUT` or
  `DELETE` above, or `register-exchange.sh` and `revoke-exchange.sh` on the
  host. A client never falls back to the token on its own when a proof is
  answered 401 or 409: a client that did would make the token the credential
  for every call again.
- **Authentication and CORS.** Authentication reads the `Authorization` header
  and nothing else -- no cookie, no query parameter -- and no answer carries
  `Access-Control-Allow-Credentials`, so a browser's ambient credentials never
  authenticate a cross-origin call. `Access-Control-Allow-Origin: *` is safe for
  that reason. `scripts/relay-exchange-keys.test.mjs` holds both.
- **Where it listens.** HTTPS on `ALCOVE_RELAY_REGISTRAR_PORT` in `relay.env`,
  on every address, with the relay's own certificate from
  `/etc/alcove-relay/certs`; the certificate deploy hook restarts it when the
  certificate changes. The port is 8443 where unset; `relay.env.example` sets
  8444, because the broker's TLS front holds 8443 on a host that runs it. An
  existing host's registrar port is whatever its `relay.env` sets. Where
  `ALCOVE_RELAY_REGISTRAR_NAME` gives it a name of its own, it also listens
  on `127.0.0.1` at `ALCOVE_RELAY_REGISTRAR_FRONT_PORT` (8445 where unset),
  and [the 443 front](#the-443-front) passes a connection asking for that
  name there, so its address is `https://<that name>`, on 443. Each
  connection on that port starts with the front's PROXY protocol (version 1)
  header naming the client's address, which the registrar reads, within 5 s
  (`PROXY_HEADER_SECONDS`), before the TLS handshake. A connection that does
  not start with a well-formed one is closed unanswered and writes nothing,
  including the header's `UNKNOWN` form, which names no client and which
  nginx does not send for a TCP connection. The port listens on
  loopback only, so only a process on the host can name an address there.
  The certificate is issued for the name beside the realm.
- **Who must reach it.** Every machine that registers: the machine
  `alcove enroll-relay` runs on, and every CLI or browser that runs an
  exchange through this relay, since each run registers its rotated key. At
  the registrar's own name, that is outbound TCP to 443, the port TURNS uses,
  so a network that allows only 443 out both relays and registers. At the
  realm's name and the registrar's port, each machine also needs that port
  open outbound, and the instance's security group must admit it
  ([aws/provision.md](aws/provision.md), Ports); the CLI's failure names the
  host and port it could not reach
  ([docs/CLI.md](../../docs/CLI.md#registering-the-relay-key-at-your-relay)).
  An exchange configured with that address keeps it until its configuration
  names the registrar's own name, so close the port only once none does.
- **How it reaches the table, and as whom.** In-process, through
  `relay_table.py`, so the table and mapping have one write path. It runs as the
  relay image's uid and gid, which `install.sh` reads from the image and fills
  into the unit, with no capability and no container runtime; the token and
  certificate under the root-only `/etc/alcove-relay` reach it as systemd
  credentials (`LoadCredential=`). The unit carries a full systemd sandbox --
  read-only system and no home, a private `/tmp` and `/dev`, no kernel,
  cgroup, clock, or hostname writes, the `@system-service` system calls, and
  write access to `/var/lib/alcove-relay` alone -- and the sweep's unit the
  same with no network. `/etc/alcove-relay` is hidden from both units
  (`InaccessiblePaths=`) as a second layer behind the root-only directory,
  since the relay image's account owns the rendered `turnserver.conf` there;
  systemd reads `relay.env` and the credential sources before it sets up that
  view. It is `python3` from the distribution (3.9 or later, the standard
  library only), which Amazon Linux 2023 ships.
- **What it logs.** One line per request to the journal (`journalctl -u
  alcove-relay-registrar.service`), naming the method, the status, and the
  path, and the result of each write: a registration as one
  `credential issuance:` line naming the exchange, the time, the outcome and
  whether the token, a proof, or no credential made it, in the format
  [the deployment record](../../docs/notes/webrtc-relay-deployment.md#what-the-relay-host-keeps)
  states. The path is logged only when it is
  `/exchanges/<exchange-id>` with a well-formed id, and the method only when
  it is a standard one; any other path or method, and any part of a malformed
  request line, is replaced by a fixed placeholder, since it could hold a key
  sent in the wrong place. Neither the token, a key, nor the caller's address
  is logged. The rate limit below and the cap on each client's rows hold each
  address that enrolled without a token in the registrar's memory, and
  neither writes it anywhere. An entry that has ended is dropped only when a
  later enrollment without a token arrives, so on a registrar that receives
  none the address stays in memory until one does or the registrar restarts.

### Enrollment without a token

A browser party enrolls the exchange it is about to run with no token: it
holds none, and any token a served page held would be public. Where
`ALCOVE_RELAY_REGISTRAR_TOKENLESS_ENROLLMENT=on` in `relay.env`, the
registrar takes a `POST` with no `Authorization` header as an enrollment.
Off, or unset, it answers that `POST` 401. The setting is read at
start: to turn it off, set it to `off` and
`systemctl restart alcove-relay-registrar.service`.

- **What it writes.** As the token's enrollment, for an id not yet enrolled:
  the key's row and the exchange's mapping. Any id in the registrar's id
  space is accepted; the exchange id a browser exchange uses is
  [PROTOCOL.md](../../docs/spec/PROTOCOL.md)'s to state.
- **The lapse is the registrar's.** The body must send `"maxAgeDays": null`;
  any other value is answered 400 and nothing is written. The row lapses
  4200 s (70 minutes) after the enrollment (`TOKENLESS_LIFETIME_SECONDS`), and
  the answer states it: `maxAgeDays` `null` and `lapsesAt` that time. The 70
  minutes are what one browser exchange needs: the inviter enrolls when it
  creates the invitation and waits at most 10 minutes for its partner
  (`DEFAULT_PEER_WAIT_TIMEOUT_MS`, `apps/web/src/psi/transport/waitForConnection.ts`),
  and each party then mints a credential that lasts 3600 s
  (`RELAY_CREDENTIAL_MAX_TTL_SECONDS`, `packages/core/src/relayCredential.ts`),
  under which a new allocation needs the row. A lapsed row authenticates
  until the sweep deletes it, within about eleven minutes of its lapse
  ([Per-exchange keys](#per-exchange-keys), Lifetime), so a row lives at most
  about 81 minutes.
- **The same key again, and another key.** An enrollment of the key the id
  already holds is answered 200 with the registration as held, its lapse
  unchanged: both parties derive the same key from the same secret, and
  either may enroll. Another key is answered 409, so a caller cannot replace
  or revoke an exchange whose key it does not hold. That holds for an id the
  token enrolled too.
- **No extension past the lapse.** A `PUT` under a proof on a row enrolled
  without a token -- a renewal, or a rotation to a new key -- keeps the row's
  lapse whatever `maxAgeDays` its body names, and the answer states that
  lapse. Only the relay-owner token's `PUT`, the operator's recovery route,
  replaces it with the lapse its body names. A `DELETE` under a proof revokes
  the row as for any other.
- **The rate limit.** At most 20 enrollments without a token from one client
  address in a window of 600 s from its first (`TOKENLESS_ENROLLMENTS_PER_WINDOW`,
  `TOKENLESS_WINDOW_SECONDS`). Past that, an enrollment is answered 429 with
  `Retry-After`, the seconds until the window ends, which the answer lets a
  browser's script read (`Access-Control-Expose-Headers`), and nothing is
  written.
  Each request is counted before its id or body is read, so a malformed one,
  or one probing whether an id is held, counts too. These are arbitrary
  working values, raised on request; the reasoning behind them: one exchange
  costs at most two enrollments, the inviter's and its partner's, and a
  client retrying as core's registrar client does
  ([PROTOCOL.md, Registering the rotated relay key](../../docs/spec/PROTOCOL.md#registering-the-rotated-relay-key),
  Retries) sends a request that gets no answer, or a 429, three times in
  all, so 20 in 10 minutes -- the length of the inviter's wait -- admits
  about ten exchanges set up at once behind one address, such as a facility's
  shared network address, or three whose every request was retried. The cap
  on each client, below, bounds the rows an address holds.
- **The client's address.** On the registrar's own port, the connection's
  address. Through the front, the address in its PROXY header, since every
  connection the front passes comes from `127.0.0.1` (Where it listens,
  above). For the rate limit, an IPv6 address counts as its /64, which one
  host commonly holds whole; for the cap on each client, below, as its /48.
- **The cap on each client.** At most 10 rows enrolled without a token and
  not yet lapsed are held for one client address
  (`TOKENLESS_ROWS_PER_CLIENT`), counted inside the enrollment's own write.
  Past it, an enrollment of an id not yet held is answered 429 with
  `Retry-After`, the seconds until the first of that address's rows lapses,
  and nothing is written; an enrollment naming the key an id already holds
  is still answered 200. A row revoked, or lapsed, no longer counts.
  - **Why 10.** An arbitrary working value, raised on request. A row lives
    70 minutes whether its exchange relays or not, so the cap is the number
    of exchanges one address can set up within any 70 minutes. An exchange
    holds one row whichever of its parties enrolls it, so 10 admits the
    about ten exchanges set up at once behind a facility's one shared
    address that the rate limit above is sized for. One address holds at
    most 10 / 1800 of the ceiling below, about half of one percent.
  - **IPv6.** The cap counts an IPv6 address as its /48, not its /64: a
    site is commonly assigned a /56 or a /48, so counting /64s would give
    one holder 256 to 65,536 caps. A site on IPv6 then shares one cap
    across its /48, as a facility on IPv4 shares one across its address.
    The reference deployment's names are DNS A records only
    ([aws/provision.md](aws/provision.md)), so there every client reaches
    the registrar, and is counted, by its IPv4 address.
  - **Held in memory.** Which address enrolled each row is held in the
    registrar's memory, and written nowhere. A row the registrar revokes is
    dropped at once; a lapsed row is dropped only when a later enrollment
    without a token arrives. A restart of the registrar clears it, so after one
    an address can enroll up to 10 more while its earlier rows still hold;
    the ceiling below still bounds them all.
- **How many addresses.** At most 4096 addresses' windows are held at once
  (`MAX_TRACKED_ADDRESSES`, an arbitrary working value). With all of them
  taken, an enrollment from another address is answered 429, until the
  oldest window ends, and writes nothing.
- **The ceiling.** At most 1800 rows enrolled without a token and not yet
  lapsed are held in the realm at once
  (`ALCOVE_RELAY_REGISTRAR_TOKENLESS_CEILING` in `relay.env`, 1800 where
  unset), counted inside the enrollment's own write. Past it, an enrollment
  of an id not yet held is answered 503 with `Retry-After`, the seconds until
  the first of those rows lapses, and nothing is written; an enrollment
  naming the key an id already holds is still answered 200. Every such row is
  a secret in coturn's `turn_secret` for the realm, and coturn checks a
  credential against every secret the realm holds, so the ceiling bounds the
  work callers holding no credential can add to each authentication.
  - **Where 1800 comes from.** From what a row costs, not from what the
    relay serves:
    - **Authentication.** A request with a wrong credential is checked
      against every row. A model of one check -- two HMAC-SHA1s and an MD5, in Python --
      measured about 5.5 microseconds a row on a development machine. The
      bound is a full scan of about 10 ms, an arbitrary working value, and
      10 ms / 5.5 microseconds is about 1800 rows.
    - **Size.** About 400 bytes a row in `turndb`, measured on the same
      machine, so 1800 rows add under 1 MB and 18,000 about 7 MB, small
      beside the instance's memory. The size does not set the ceiling.
    - **Use.** Use at full relay capacity holds about 140 rows, under a
      tenth of the ceiling: `total-quota` (40, `ALCOVE_RELAY_TOTAL_QUOTA`)
      allows 20 relayed exchanges at once, at two allocations each; taking
      `max-allocate-lifetime`'s 600 s as how long an exchange holds them,
      that is 2 exchanges a minute, each holding one row for 70 minutes. The
      formula is `total-quota x 3.5`: on raising the quota, keep the
      ceiling well above it.
    - **On the relay host.** The cost of a row is an estimate, and the
      2026-10-15 measurement on the relay host could not resolve it: each
      timed allocation included a client start of 11 to 17 s, and with no
      rows added, with 1800 and with 18,000 the times showed no difference
      beyond that noise. The default 1800 stays a modeled working value. A
      timing that leaves out the client's start confirms the ceiling, or
      lowers it to 10 ms over the measured cost of a row.

    A lapsed row is not counted, and the sweep deletes it within about
    eleven minutes, so a flood holds at most about 1800 x 81 / 70, about
    2100, such rows in the table.
  - **The limit.** One address holds at most 10 rows (The cap on each
    client, above), so filling the ceiling takes 180 client addresses, IPv4
    addresses or IPv6 /48s, fewer by the rows legitimate use holds. Many
    addresses can still fill it: then an enrollment without a token of a new
    id is refused until rows lapse, up to 70 minutes, and a browser run that
    could not enroll dials without the default relay, by STUN alone. A run
    that never relays still holds a row, so legitimate use setting up more
    than about 25 exchanges a minute reaches it too. Each refusal is counted
    (What it counts, below), for the relay's monitoring.

### What it counts

The registrar counts the enrollments without a token it wrote, the 429s it
answered at the rate limit (`rate_limit_refusals`) and at the cap on each
client (`client_cap_refusals`), and the 503s it answered at
[the ceiling](#enrollment-without-a-token) (`tokenless_ceiling_refusals`),
and writes the counts to `/var/lib/alcove-relay/registrar-counters`
(beside the secrets table), for the relay's monitoring to read:

```
started=2026-10-15T12:00:00Z
updated=2026-10-15T12:34:50Z
tokenless_enrollments=12
rate_limit_refusals=3
client_cap_refusals=0
tokenless_ceiling_refusals=0
```

Each count is the total since the registrar started, at `started`; a reader
takes the difference between two reads, and a changed `started` means the
counts began again at 0. The file is written at start, then at most every 10
s (`COUNTERS_WRITE_SECONDS`), and only when a count changed, replaced whole
so a reader never sees half a file; `updated` is the time of the last write.
A file, rather than a count of journal lines, because journald drops a
unit's lines past its rate limit (`RateLimitBurst` in `journald.conf`), and
a flood of enrollments is what would reach it, and because reading it costs
one small read on an instance with no memory to spare. A failure to write it
goes to the registrar's journal, and the registrar goes on serving.

## The 443 front

One listener holds 443/tcp on every address: nginx's stream module in a
container of its own, `alcove-relay-front.service`. It reads the server name
from a connection's TLS ClientHello. A connection for the registrar or a
routed service passes on, its bytes unchanged, to that service on loopback,
which presents its own certificate. A connection for the WebSocket relay has
its TLS terminated by the front, which passes the upgrade to the relay on
loopback. Every other connection is TURN: the front
terminates its TLS under the relay's certificate and passes plain TURN over
TCP to coturn on loopback, which opens no TLS listener and holds no key.

- **The rule.** By server name (SNI), from `relay.env`:

  | the connection asks for | it goes to |
  | --- | --- |
  | `ALCOVE_RELAY_REGISTRAR_NAME` | the registrar, on `127.0.0.1` at `ALCOVE_RELAY_REGISTRAR_FRONT_PORT`, with a PROXY header naming the client |
  | `ALCOVE_RELAY_WEBSOCKET_NAME` | the front's WebSocket relay server on `127.0.0.1:5351`, which terminates the TLS, then the WebSocket relay on `127.0.0.1` at `ALCOVE_RELAY_WEBSOCKET_PORT`, with no PROXY header |
  | a name in `ALCOVE_RELAY_FRONT_ROUTES` (`name=port` pairs) | that port on `127.0.0.1`, through the route hop |
  | the realm, any other name, no name, or bytes that are not TLS | the front's TURN server on `127.0.0.1:5347`, then coturn's proxy port, `127.0.0.1:5350` |

  TURN takes every connection no route claims, so a TURN client reaches
  coturn whatever name it sends, or none; one that sends bytes that are not
  TLS fails the TURN server's handshake. A route names a port on `127.0.0.1`
  and never another host. `render-front.sh` compares names in lowercase, as
  nginx's map matches them, and refuses a route for the realm, a name two
  routes claim, a name that is not a lowercase DNS name, a name nginx's map
  reads as a keyword (`default`, `include`, `hostnames`, `volatile`), port
  443, and a port another route, the registrar, the front's own servers or
  coturn already uses; `install.sh`
  runs it before it installs or restarts anything. `install.sh` then builds
  the front's image and checks the rendered configuration with `nginx -t`
  before it installs the scripts under `/opt` or renders coturn's
  configuration, so a front that fails either leaves coturn as it was. A
  first install has no certificate yet at that point, so it checks against a
  throwaway one.
- **Three servers, and a fourth for the WebSocket relay.** The client's address is needed in two places: the
  registrar's rate limit counts by it, and coturn reports it to a TURN client
  as the address the client connected from. A browser that is told a
  loopback address there may refuse the allocation: Firefox 157 gathered no
  relay candidate on 2026-10-14, while Chrome ignored the address. The front
  can hand the address on only as a PROXY protocol header, which nginx sends
  for a whole server block or not at all. So:
  - the server on 443 sends the header on every connection, by server name
    to the registrar's front port, which reads it, or to one of the two
    servers below;
  - the TURN server, on `127.0.0.1:5347`, reads the header, takes the
    client's address from it (`set_real_ip_from 127.0.0.1`, nginx's stream
    realip module), terminates the TLS, and sends coturn a header of its own
    naming that address. coturn reads it on its `tcp-proxy-port`, which
    refuses a connection that opens without one;
  - the route hop, on `127.0.0.1:5348`, reads and drops the header and
    passes the connection, TLS unopened, to the routed service, which never
    sees it;
  - where `relay.env` names the WebSocket relay, the WebSocket relay
    server, on `127.0.0.1:5351`, reads the header, terminates the TLS at
    the TURN server's settings, and passes the connection to the relay with
    no header ([The WebSocket relay](#the-websocket-relay), Quotas).
    `render-front.sh` leaves it out of a host that names no relay.

  The ports 5347, 5348 and 5351 are fixed in `front.conf.tmpl` and
  `render-front.sh` (`TURN_PORT`, `HOP_PORT`, `WEBSOCKET_TLS_PORT`), and 5350 in
  `turnserver.conf.tmpl` and `render-front.sh` (`COTURN_PORT`);
  `scripts/relay-front.test.mjs` holds them equal.
- **TLS for TURN.** The TURN server serves `/etc/alcove-relay/certs`, the
  certificate the deploy hook writes ([Certificates](#certificates)),
  mounted read-only into the front's container. It takes TLS 1.2 and 1.3,
  the registrar's floor too, and on TLS 1.2 only ECDHE suites with AES-GCM
  or ChaCha20-Poly1305 (`ssl_protocols`, `ssl_ciphers` in
  `front.conf.tmpl`); TLS 1.3's suites are OpenSSL's defaults.
  **Dated, 2026-10-14:** TLS for TURN is the front's, at the settings above.
  coturn opens no TLS listener and `turnserver.conf.tmpl` sets no TLS
  option, so nothing coturn does or ignores sets the relay's TLS floor.
- **Why the server name.** The alternatives weighed against it, a test of the
  first bytes and ALPN, are in
  [the deployment record](../../docs/notes/webrtc-relay-deployment.md#one-listener-on-443),
  and so are those weighed against the hops.
- **What the services see.** The registrar takes the client's address from
  the PROXY header, and coturn from the TURN server's. A connection through
  the route hop arrives at its service from `127.0.0.1`, so the broker
  front's access log lines for a connection through 443 name that address.
  So does every connection the WebSocket relay takes. `verify.sh` asks
  coturn, through the front, which address it sees, and fails on a loopback
  one.
- **Bounds.** A connection's first bytes must arrive within 10 s
  (`preread_timeout`), the TURN server's TLS handshake must finish within 10 s
  (`ssl_handshake_timeout`), and the service behind must accept within 5 s.
  An established connection idle for 900 s is closed, longer than coturn's
  `max-allocate-lifetime` of 600 s, so an allocation its client refreshes is
  not cut. Each server applies the same bounds, except that the WebSocket
  relay server closes a connection idle for 300 s, ten times the relay's
  30 s ping ([The WebSocket relay](#the-websocket-relay), Its route).
- **Connections and memory.** One worker (`worker_processes 1`) holds at
  most 1024 connections at once (`worker_connections`), a client's side and
  the service's side of each hop counting one. A TURN client counts four
  (the server on 443's two sides, the TURN server's two sides), and so does
  a client of a routed service (the server on 443's two sides, the route
  hop's two sides), or of the WebSocket relay (the server on 443's two
  sides, the WebSocket relay server's two sides). A registrar client counts
  two. So 1024 is 256 TURN
  clients, six times coturn's `total-quota` of 40 allocations, 256 clients
  of routed services, twice the 128 WebSocket clients the broker's front
  admits (`worker_connections 256` in `infra/broker/nginx.conf.tmpl`, two
  per client), 256 sockets of the WebSocket relay, above the 72 it holds at
  once (48 awaiting a hello and 12 pairings of two, `docs/spec/WEBSOCKET_RELAY.md`),
  or 512 registrar clients. That is the bound on the front's
  memory: each TURN client holds the TURN server's TLS session and a buffer
  each way on two hops, which the host run reads under load
  (below). The instance has 412 MB and no headroom (a full `npm ci` there
  OOM-killed coturn). On the project's host, without a registrar and without
  the TURN server, the front's cgroup measured 8.08 MB and `free` reported
  20 MB less available memory, mostly page cache, with no out-of-memory kill.
  `install.sh` adds disk swap for dnf's runs; see [OS updates](#os-updates).
  These are working values in `front.conf.tmpl`, raised on request.
- **Measuring the front's memory.** On a docker host the container's cgroup
  is `/sys/fs/cgroup/system.slice/docker-<id>.scope/`, `<id>` being
  `docker inspect -f '{{.Id}}' alcove-relay-front`. Read `memory.current` and
  `memory.peak` there, with `docker stats --no-stream alcove-relay-front`,
  idle and while a batch of `stun-binding.py --hold` probes holds connections
  open through the front, and `free -m` before and after.
- **One limit for every service.** The 1024 connections are shared by
  TURN, the registrar, the WebSocket relay and every routed service, and the
  front sets no limit per client address but the WebSocket relay server's
  ([The WebSocket relay](#the-websocket-relay), Quotas). One host that opens that many
  connections, and holds them or replaces each as the 10 s or idle bound
  closes it, keeps every other client from TURN, the registrar, the
  WebSocket relay and the broker on 443 for as long as it does so.
- **What it logs.** No access log: one line per connection would record which
  client asked for which service. Its error log, warnings and above, goes to
  the journal. When coturn, a routed service or the WebSocket relay's
  server refuses a connection, does not accept it within 5 s, or resets it,
  the line nginx writes there names
  the client's address beside the service's loopback port, which identifies
  the service the client asked for. On the project's relay host, with one
  hop, coturn resetting a connection whose credential or allocation it
  refused, or a probe that sent no server name, an ALPN offer or bytes that
  were not TLS, each wrote such a line (`recv() failed (104: Connection reset
  by peer) while proxying and reading from upstream`), and so did each socket
  the WebSocket relay's server refused under its bound for each client
  address, one line per socket (measured 2026-10-25). Which address the
  TURN server's and the route hop's lines name is not yet measured.
  The WebSocket relay's server also writes its own line for each socket it
  refuses under that bound, at `warn` (`limit_conn_log_level`): `limiting
  connections by zone "alcove_websocket_relay"`, naming the client's
  address, the one the PROXY header from 443 names, as `client:`.
  `verify.sh` checks for it (see the verification list below). That line is
  not yet measured on the project's relay host.
- **The broker.** The broker's TLS front ([infra/broker](../broker/README.md))
  listens on 8443 and presents its own certificate, so on a host that runs it,
  `ALCOVE_RELAY_FRONT_ROUTES="signal.example.org=8443"` answers it on 443
  under its own name. The registrar then needs another port, such as the 8444
  `relay.env.example` sets.
- **The WebSocket relay.** Under a name of its own, with its TLS terminated
  by the front rather than passed through, since the relay has no
  certificate: [The WebSocket relay](#the-websocket-relay).

What was measured on the project's relay host on 2026-10-12, and what has
not been -- the registrar behind the front, the TURN server, and a relayed
exchange from a 443-only client -- is in
[the deployment record](../../docs/notes/webrtc-relay-deployment.md#one-listener-on-443),
with the alternative if the front fails a TURN client: a second public
address on the instance.

## The WebSocket relay

The WebSocket relay ([`packages/websocket-relay`](../../packages/websocket-relay/README.md))
is the path an exchange takes for two parties whose network stops TURN but
passes a WebSocket on 443. Each party opens one socket at `wss://<name>/relay` and
proves it holds the exchange's relay key; the relay pairs the two sockets of
one exchange and forwards their frames unread. Its wire and bounds are in
[WEBSOCKET_RELAY.md](../../docs/spec/WEBSOCKET_RELAY.md), the design in
[web-websocket-transport.md](../../docs/notes/web-websocket-transport.md).
`install.sh` runs it where `relay.env` sets `ALCOVE_RELAY_WEBSOCKET_NAME`, and
stops and disables it where that is unset.

- **Its name.** A DNS name of its own, whose record points at this host and
  is DNS-only; nothing defaults it. It cannot be the realm or the
  registrar's name. The relay's certificate is issued for it beside the
  realm ([Certificates](#certificates)), so a certificate issued before the
  name was set needs a forced renewal, and `verify.sh`'s probe fails until
  then.
- **Its route.** The front sends a connection asking for the name to its
  WebSocket relay server, which terminates the TLS at the TURN server's
  settings and passes the connection to the relay on `127.0.0.1` at
  `ALCOVE_RELAY_WEBSOCKET_PORT`, 8446 where unset
  ([The 443 front](#the-443-front)). The relay terminates no TLS and listens
  on loopback alone. The front's WebSocket relay server closes an
  established connection idle for 300 s, the timeout
  [WEBSOCKET_RELAY.md, Keepalive](../../docs/spec/WEBSOCKET_RELAY.md#keepalive)
  sets the relay's ping against; the relay pings each socket every 30 s, so
  a pairing whose parties are silent stays open until the relay's own idle
  bound.
- **Its keys.** It reads the exchange keys from the secrets table coturn
  reads ([Per-exchange keys](#per-exchange-keys)), read-only, so an exchange
  `register-exchange.sh` or [the registrar](#the-registrar) enrolled is
  admitted here as by coturn, and a revoked or swept one is not. It opens no
  connection of its own.
- **The unit.** `alcove-relay-websocket.service` runs
  `/usr/local/bin/node --import tsx packages/websocket-relay/src/standalone.ts`
  as the relay image's account, which owns the table, from the Node
  workspace tree at `/opt/alcove-broker/src`: the tree
  [`infra/broker/README.md`, Install](../broker/README.md#install), steps 1
  to 6, sets up, which [the host pull](../host-pull/README.md) keeps at
  `main` on the project's host. The broker workspace's install there has
  every package the relay imports (measured on 2026-10-19 against a scoped
  `npm ci` of that workspace alone). The tree also needs core's
  `websocket-relay.esm.js`, with the chunks it imports, in
  `packages/core/dist`, which the broker core build
  ([docs/RELEASES.md](../../docs/RELEASES.md#the-broker-core-build)) includes
  beside the broker's entry, under the same `SHA256SUMS` manifest and
  signature. `install.sh` checks for them and for `/usr/local/bin/node` where
  the name is set, and stops before it changes anything when one is missing;
  a tree whose core build predates the relay's entry is refused with that
  cause. After the start it waits up to 120 s, each probe at most 2 s, for
  the relay to answer a plain request on `/relay` with `404`.
- **One process.** The unit runs `node` with tsx's loader rather than
  `npm start`, which runs npm, tsx's own process and then node; why, and
  what was measured:
  [webrtc-relay-deployment.md, The WebSocket relay's unit](../../docs/notes/webrtc-relay-deployment.md#the-websocket-relays-unit).
- **The sandbox.** The broker's ([`infra/broker/README.md`,
  Exposure](../broker/README.md#exposure)): no capability, connections to and
  from loopback alone (`IPAddressDeny=any`, `IPAddressAllow=localhost`), and
  the whole file system read-only except a private `/tmp`, where tsx keeps
  its cache. `/etc/alcove-relay` is hidden from it (`InaccessiblePaths=`):
  the relay image's account owns the rendered `turnserver.conf`, which holds
  coturn's static authentication secret where the host keeps one, and the
  relay reads nothing there. `install.sh` refuses an image that reports uid
  0, so the relay never runs as root. `systemd-analyze security` has not
  been run on it.
- **Quotas.** The relay's own, each on an exchange's key
  ([WEBSOCKET_RELAY.md, Quotas](../../docs/spec/WEBSOCKET_RELAY.md#quotas)).
  It counts nothing by client address, and every connection reaches it from
  `127.0.0.1`: the front sends it no PROXY header, because the relay, a Node
  HTTP server, answers an upgrade that opens with one `400` (measured against
  the standalone runner on 2026-10-19). So the front sets the bound for
  each client address: its WebSocket relay server holds at most 8
  connections from one address at once (`limit_conn` in
  `front.conf.tmpl`), counted by the address it takes from the PROXY header
  from 443. It closes a further connection from that address before
  answering it, so that party sees a closed connection, not a `503`. Each
  refusal writes a `limiting connections by zone` line naming the client's
  address, and the 443 server a reset line naming it beside the relay
  server's loopback port ([What it logs](#the-443-front)).
  `verify.sh` checks the bound from two addresses. The 8 is a working
  value, raised on request. The front's limit on all its connections is
  shared with every other service on 443 ([The 443 front](#the-443-front),
  One limit for every service).
- **Logs.** Its standard output and error go to the journal, under the
  retention `journald-alcove-relay.conf` sets: the line
  `alcove-websocket-relay <port>` at each start, and on its error stream a
  warning when the key table cannot be read and the faults
  [WEBSOCKET_RELAY.md, The key table](../../docs/spec/WEBSOCKET_RELAY.md#the-key-table)
  names, each limited to one a minute; a fault about one exchange's key
  names that exchange's id.
- **Memory.** On the project's host, which has 412 MB, the relay's
  resident set peaked at about 81 MB and its cgroup at about 94 MiB through
  `verify.sh` on 2026-10-19. Available memory was 129 MB before the relay
  started and 103 MB at the lowest, 24 seconds after the start, against the
  installer's 64 MB floor ([The 443 front](#the-443-front), Connections and
  memory). The resident set falls once the relay is idle, because the kernel
  swaps part of it, so the peak is the figure. In the development container
  its resident set peaked at 77 MB on one pairing at its full byte rate
  ([web-websocket-transport.md, S3](../../docs/notes/web-websocket-transport.md#the-spikes)).
- **Restarts.** Every `install.sh` run on a host that names the relay
  restarts it, the host pull's among them, and a certificate change restarts
  the front; either drops the pairings in progress.
- **`verify.sh`.** Registers `alcove-verify-websocket` under a key of its
  own and runs `websocket-pair.py` through the front at the relay's name:
  the two sockets must pair and one message and the close must cross. Once
  they have, it runs `websocket-address-limit.py` through the front from
  two addresses, the one it connects from and `127.0.0.1`: 8 sockets from
  the first and one from the second must be upgraded, and a ninth from the
  first closed unanswered. The front's journal
  (`journalctl -u alcove-relay-front.service`) must then hold a refusal
  line naming a client address, written since the probe started, in one of
  ten reads a second apart, each bounded at 10 s. The run's key is revoked
  on exit.

## Supervision and the container runtime

One service name, `alcove-relay.service`, whichever runtime the host carries:
the verification timer requires it by that name. Which file defines it is what `install.sh` decides, and it decides
once per host -- the runtime is recorded in `relay.env` and read back on every
later run, so a converge does not move a running relay from one supervisor to the
other.

| The host has | The unit | The supervisor |
| --- | --- | --- |
| podman | `alcove-relay.container`, at `/etc/containers/systemd/` | podman's systemd generator: daemonless, and systemd is the only supervisor |
| docker | `alcove-relay-docker.service`, installed as `/etc/systemd/system/alcove-relay.service` | systemd, over a foreground `docker run`; the unit `Requires=docker.service` |

**Amazon Linux 2023 is a docker host.** It publishes no `podman` package and
carries no EPEL, so `dnf install podman` fails there with no match, while `dnf
install docker` installs Docker Engine. That is measured on the arm64 AMI
[`aws/provision.md`](aws/provision.md) prescribes, and it is why the docker path
is a tracked unit rather than a documented equivalence. `install.sh` still
prefers podman wherever the distribution carries it.

**Under podman, a container's command line reaches the journal.** Each
container lifecycle event (create, start, died, remove, and the rest) is a
journal entry that journald stamps with podman's command line, and where
`containers.conf` sets `log_driver = "journald"`, Fedora's default, conmon sends
the container's output there too. Measured on Fedora 42: a key on a `podman
run` command line reached the journal on every run, and a credential on
`turnutils_uclient`'s did the same. Nothing here puts a key on a container's
command line -- `relay_table.py` runs no container:
`scripts/relay-exchange-keys.test.mjs` checks that its import statements name
exactly the modules it uses today, that it imports `os` only by that name and
takes no name from it with `from os import`, and that it holds no `getattr` on
`os`, `__import__`, or `importlib`, though not a name reached some other way
off `os` or code a string builds and `eval` runs -- and `verify.sh` passes
podman's global `--events-backend=none` to every `turnutils_uclient` run. A run
by hand whose command line or output carries a key or a credential takes the
same flags, `podman --events-backend=none run --log-driver=none ...`, which
were measured to leave none in the journal while the caller still reads the
output. docker journaled neither.

The two unit files carry the same image, the same read-only mounts, and the same
container flags. `alcove-relay-docker.service`'s header holds the
directive-to-flag mapping between them, and an edit to one is an edit to both.

Host networking is a requirement of the protocol rather than a convenience. TURN
hands out a relayed transport address, and bridge networking or published ports
rewrite the address the client is told to use; the relay range is also wide
enough that publishing it is not a port list.

## The daily schedule

Every daily job on the relay host runs between 08:00 and 11:00 UTC: 04:00 to
07:00 Eastern and 01:00 to 04:00 Pacific in daylight time, an hour earlier in
winter. The jobs run one after another, each from a fixed start and stopped at
its maximum run time:

| job | timer | start (UTC) | maximum | busy (UTC) | may restart |
| --- | --- | --- | --- | --- | --- |
| the relay's certificate renewal | `alcove-relay-cert.timer` | 08:00, plus up to 5 min | 10 min | 08:00 to 08:15 | `alcove-relay-front.service` and `alcove-relay-registrar.service`, on a day the certificate changed |
| the broker's certificate renewal | `alcove-broker-cert.timer` | 08:15, plus up to 5 min | 10 min | 08:15 to 08:30 | `alcove-broker.service`, `alcove-broker-tls.service` and the timer, where their inputs changed ([`infra/broker/README.md`](../broker/README.md)) |
| the OS update | `alcove-relay-os-update.timer` | 08:30 | 60 min | 08:30 to 09:30 | `docker.service`, and with it `alcove-relay.service`, `alcove-relay-front.service` and `alcove-broker-tls.service`, where a package's update restarts it ([OS updates](#os-updates)) |
| the host pull | `alcove-host-pull.timer` | 09:30 | 60 min | 09:30 to 10:30 | `alcove-broker.service`, then what both install scripts restart, on a day `main` moved ([`infra/host-pull/README.md`](../host-pull/README.md)) |
| the verification | `alcove-relay-verify.timer` | 10:30 | 30 min | 10:30 to 11:00 | nothing |

- **The order.** The certificate renewals come first and the OS update before
  the host pull, whose unit is also ordered `After=` it. The verification runs
  last, after every job that can restart a service, so it checks what they
  left. After a hold that spans several start times, the jobs run in whatever
  order they get the lock, and the next day's verification checks the result.
  The lapse sweep, every ten minutes, keeps its own schedule and takes no
  lock: it restarts nothing.
- **The starts.** The two renewals keep up to 5 minutes of randomized delay,
  because Let's Encrypt asks clients to randomize their renewal time; every
  other job starts on the minute.
- **The maximums.** The pull's hour is the bound `pull.sh`'s own timeouts are
  sized to (its header). The OS update's hour is more than twice the 23-minute
  upgrade measured under [OS updates](#os-updates). The verification's 30
  minutes are above the sum of `verify.sh`'s own timeouts, about 23 minutes
  with one front route and about four minutes more with the WebSocket relay. The renewals' 10 minutes are a working value, not a
  measured one: neither `renew.sh` bounds its ACME client.
- **A host that was down** at a job's start runs the renewals and the
  verification when it boots, under the lock below; the OS update and the pull
  skip the day.

**The maintenance lock.** Each daily job's unit takes
`/run/alcove-maintenance/lock` in its own `ExecStart`, before the job acts, and
holds it until the job ends, so no two jobs, and no job and a host hand-off,
run at once. The lock file is in `/run/alcove-maintenance`, a directory only
root can enter (mode 0700, owned by root), so no account but root can open the
lock, and none can hold it. A file directly under `/run` would not do: `flock`
creates it readable by everyone, and any account can hold a lock on a file it
can read. The tmpfiles entry `infra/tmpfiles.d/alcove-maintenance.conf` makes the
directory at every boot, and each `install.sh` that installs a locked unit
(the relay's, the broker's and the host pull's) installs it as
`/etc/tmpfiles.d/alcove-maintenance.conf` and runs `systemd-tmpfiles --create`
on it, so the directory exists before any unit runs. Every unit's `ExecStart`
has the same shape:

    /usr/bin/flock -o -w 7200 /run/alcove-maintenance/lock /usr/bin/timeout -k 30 <maximum - 30> <command>

- **The wait.** A job waits up to two hours for the lock. When it is still held
  then, `flock` exits 1 without running the job and the unit fails, so a
  skipped renewal, update or verification shows as a failed unit
  (`systemctl --failed`), not as a success.
- **The maximum.** Holding the lock, `timeout` sends the job TERM 30 seconds
  before its maximum and KILL at it. `-o` keeps the job from inheriting the
  lock, so a process it leaves behind does not hold it.
- **The start timeout.** Each unit sets `TimeoutStartSec=infinity`: the wait and
  `timeout` already bound the run, and a finite start timeout would have to
  cover both.
- **By hand.** To run a command under the lock, as root:
  `flock /run/alcove-maintenance/lock <command>`. A daily job's unit started
  while the lock is held waits for it like a scheduled run, and fails the same
  way.

## Certificates

Let's Encrypt over DNS-01, on a systemd timer, driven through `lego` (default,
v5 or later -- `renew.sh` drives the v5 `run` flag shape, which a v4 binary
rejects) or `acme.sh`. DNS-01 rather than HTTP-01 because the relay already
terminates TLS on 443 for TURNS -- an HTTP-01 challenge would need a second
service on 80 whose only job is to answer it.

The certificate names the realm, and `ALCOVE_RELAY_REGISTRAR_NAME` and
`ALCOVE_RELAY_WEBSOCKET_NAME` beside it where each is set, since the
registrar presents the same certificate under its own name and the front
presents it under the WebSocket relay's. A certificate issued before a name
was set does not cover that name until a forced renewal reissues it:
`ALCOVE_RELAY_RENEW_FORCE=1 /opt/alcove-relay/certs/renew.sh`, which widens
lego's window to 365 days or passes acme.sh `--force`. Until then `verify.sh`'s
probe of that service fails on the name. Each forced renewal counts against Let's
Encrypt's limit of five duplicate certificates a week.

The provider is a variable, and the credential lives in `/etc/alcove-relay/acme.env`
at mode 600. `certs/env.example` carries the Cloudflare shape (a token scoped to
`Zone:DNS:Edit` on the one zone, not a global key); another provider is that
provider's variables in the same file.

Two services read the certificate: [the 443 front](#the-443-front), which
terminates TLS for TURN and the WebSocket relay, and
[the registrar](#the-registrar). coturn and the WebSocket relay read none.

**The deploy hook gives the files to root.** The front's nginx master reads
the key as root with every capability dropped, so it can read only a key root
owns, and a front that cannot read it does not start. The registrar's unit
reads it through systemd, as root. `install.sh` converges the same ownership on
every run, certificate already present or not.

The hook **restarts** the front and the registrar rather than reloading them.
Whether a signal makes nginx re-read its certificate is a question nobody has
driven against the real front, so the hook does the thing that certainly
works. A restart of the front drops every connection through 443, TURN
allocations in flight among them, so the hook restarts only when the
certificate or key it deploys differs from the copy already in
`/etc/alcove-relay/certs` in content or owner -- on most days the timer fires,
the ACME client renews nothing and the front keeps running -- and the timer
runs in [the daily schedule](#the-daily-schedule) for the day it does renew.

## OS updates

On Amazon Linux 2023, `install.sh` installs `alcove-relay-os-update.timer`,
which upgrades the host to the newest distribution release unattended. On any
other distribution it installs neither unit and says so; set up that
distribution's own automatic updates there.

**When.** Every day at 08:30 UTC, for at most an hour, after both certificate
renewals and before the host pull ([The daily schedule](#the-daily-schedule)),
so a package's restart does not land with a certificate's or an install's. A
host that is down at that time skips the day rather than updating at boot.

**What it updates.** It runs `dnf -y upgrade --releasever=latest`: every
installed package, to its version in the newest Amazon Linux 2023 release, so
the host stays on one published package set. Nothing outside dnf is touched:
the relay and front images are pinned in their Dockerfiles and move by
`install.sh`, and Node on a host that also runs the broker is the tarball under
`/usr/local/lib/nodejs` ([`infra/broker/README.md`](../broker/README.md)),
which dnf does not manage.

**The release.** Amazon Linux 2023 locks dnf to the release the host was
launched from, so a plain `dnf upgrade` reads only that release's
repository. The unit passes `--releasever=latest` to upgrade to the newest
release, which moves that lock forward, so `install.sh`'s `dnf install` calls
and any run by hand follow it. To see the repository the unit reads, run
`dnf -v --releasever=latest repolist` on the host and read each repository's
URL.

**What restarts.** The unit restarts no service by name and never reboots.

- A package's own install scripts may restart that package's service. Where a
  Docker update restarts `docker.service`, systemd restarts every unit that
  `Requires=` it with it: `alcove-relay.service`, `alcove-relay-front.service`,
  and on a host that also runs the broker, `alcove-broker-tls.service`. Those
  restarts drop the allocations and WebSockets in flight.
- A new kernel, and a new library under a process that is still running, take
  effect only at the next reboot or restart of that process.
  `dnf needs-restarting -r` says whether a reboot is pending; the reboot is the
  operator's to schedule.

**The verification.** The unit runs no verification of its own: the daily
verification runs after it and the host pull, at 10:30 UTC, and checks what
both left. A failed upgrade fails `alcove-relay-os-update.service`
(`journalctl -u alcove-relay-os-update.service`), and a relay it broke fails
`alcove-relay-verify.service`.

**The swapfile.** dnf needs more memory than a 412 MB instance has: on the
project's t4g.nano with only Amazon Linux 2023's zram swap, reading the newest
release's package metadata ran out of memory, and the out-of-memory killer
stopped the relay and the broker. So `install.sh`, on every distribution, adds
a disk swapfile before it installs anything:

- `/swapfile`, 2048 MB when `/` has at least 4096 MB free and 1024 MB when it
  has at least 2560 MB, leaving room for dnf's downloads. With less free, it
  adds none and warns, naming the free space; the daily upgrade on that host
  can run out of memory.
- Made with `fallocate`, or with `dd` where `swapon` refuses the fallocated
  file, at mode 600, enabled with `swapon -p 10`, and listed in `/etc/fstab` as
  `/swapfile none swap defaults,pri=10 0 0`. Priority 10 is below zram's 100,
  so zram fills first and the disk takes the overflow. `vm.swappiness` is left
  as the distribution sets it.
- Where `/swapfile` exists or `/etc/fstab` names it, `install.sh` adds
  nothing but a missing `/etc/fstab` line for a file that is in use as swap,
  and logs its `swapon --show` line, or warns when it is not in use.

**Measured.** On the project's host, a t4g.nano with a 1024 MB swapfile, on
2026-10-13:

- The upgrade, run through `alcove-relay-os-update.service`, took 23 min 17 s
  of dnf for 92 package upgrades and a new kernel, with no out-of-memory kill
  and the verification passing after it. Swap in use peaked at 601 MB in total;
  over the run zram sat full at 411 MB and the swapfile reached 192 MB at its
  own peak. Sampled from outside, the relay refused one connection, at the
  Docker package's restart (What restarts, above).
- A dry run before it, reading the newest release's metadata, peaked higher:
  740 MB of swap in total, zram full and the swapfile reaching 328 MB. Some of
  the relay's answers from outside took 3 to 7 seconds; none failed.
- `systemctl show -p MemoryPeak` prints nothing on Amazon Linux 2023's
  systemd 252. To see what a run uses, read `memory.current` and
  `memory.swap.current` under
  `/sys/fs/cgroup/system.slice/alcove-relay-os-update.service/` while it runs;
  the measured upgrade peaked at 141 MB of memory and 285 MB of swap there.

## Monitoring

CloudWatch alarms email the owner when the relay's traffic, the account's
spend, or the registrar's enrollments without a token rise past a threshold
derived below, and when the publisher of those counts stops publishing. They are created by hand and recorded, for the relay's
OpenTofu root to import, in [aws/provision.md](aws/provision.md), Alarms.

### Publishing the registrar's counts

`aws/publish-metrics.sh`, run by `alcove-relay-metrics.timer`, reads the
counters file the registrar writes ([The registrar](#the-registrar), What it
counts) and publishes how much each count rose since its last publish, as a
metric of the same name in the namespace `Alcove/Relay`, with `aws cloudwatch
put-metric-data` under the instance role.

- **Where.** Only where `relay.env` sets `ALCOVE_RELAY_METRICS_REGION`;
  `install.sh` leaves the timer disabled elsewhere. The instance role needs
  the permission [aws/provision.md](aws/provision.md), The instance role,
  names.
- **When.** Every 5 minutes, except in hours 08 to 10 UTC, when the daily
  jobs run ([The daily schedule](#the-daily-schedule)): dnf alone ran this
  instance out of memory before it had disk swap. A rise in those hours is
  published by the 11:00 run, so that datapoint can hold three hours of
  counts, which [the enrollment alarm](#the-alarms) allows for.
- **No maintenance lock.** The publisher is not a daily job and restarts
  nothing, so it does not take [the maintenance
  lock](#the-daily-schedule); the timer keeps it out of the jobs' hours, and
  a run held behind a job would fail after two hours.
- **The heartbeat.** The first run of each UTC day that reads the counters
  file also publishes `publisher_heartbeat`, value 1, in the same call as any
  rise, so [an alarm](#the-alarms) can tell a publisher that fails from a
  quiet relay. A run that fails, or finds no counters file, sends none.
- **At install.** Where it enables the timer, `install.sh` first runs
  `publish-metrics.sh --heartbeat`, one test publish of a heartbeat, and stops
  naming the cause where there is no `aws` command or CloudWatch refuses it.
- **What it costs.** A run where no count rose, past the day's first, reads
  one small file and starts no `aws` process. A run that publishes starts one
  for a few seconds, niced, idle-class for I/O, and stopped after 2 minutes;
  its peak memory on the project's host is not yet measured.
- **What it keeps.** The counts it last published and the UTC day of the last
  heartbeat, in `/var/lib/alcove-relay-metrics/published`. The first run
  records the counts and publishes none of them; a changed `started` in the
  counters file counts from 0; a failed publish keeps the old record, so the
  next run publishes the rise, and the heartbeat, again. A run writes one line
  to `journalctl -u alcove-relay-metrics.service` when it publishes, records
  the first counts, fails, or finds no counters file, and none on a run where
  nothing was published.

### The alarms

Each alarm notifies an SNS topic the owner's email subscribes to:
`alcove-relay-alarms` in the instance's region, and `alcove-billing-alarms`
in us-east-1, the one region AWS publishes billing metrics in. For the
alarms in the table, missing data is not breaching: the publisher sends
nothing on a quiet run.

| alarm | metric, statistic and period | fires when it exceeds |
| --- | --- | --- |
| `alcove-account-estimated-charges`, us-east-1 | `AWS/Billing` `EstimatedCharges`, `Currency=USD`, maximum over 6 hours | the last full month's bill times 31, divided by that month's days |
| `alcove-relay-network-out` | `AWS/EC2` `NetworkOut` of the relay instance, sum over 1 hour | the largest hourly sum in the last full month |
| `alcove-relay-tokenless-enrollments` | `Alcove/Relay` `tokenless_enrollments`, sum over 6 hours | 30 times `ALCOVE_RELAY_TOTAL_QUOTA` |
| `alcove-relay-rate-limit-refusals`, `alcove-relay-client-cap-refusals`, `alcove-relay-tokenless-ceiling-refusals` | `Alcove/Relay` `rate_limit_refusals`, `client_cap_refusals` and `tokenless_ceiling_refusals` in turn, sum over 1 hour | 0 |

`alcove-relay-publisher-heartbeat` watches the publisher itself:
`Alcove/Relay` `publisher_heartbeat`, sum over 1 day, firing when two
consecutive days hold no datapoint. For it alone, missing data is breaching.

How each threshold is derived:

- **Spend.** A month spending at the last full month's daily rate stays
  under it, even at 31 days. It fires only once this month's total passes a
  full 31-day month at that rate, so a month spending faster than the last
  trips it before the month ends, not early in it. The 6 hours
  are an arbitrary working value longer than the
  billing metric's update interval.
- **Traffic.** No hour of the last full month sent as many bytes. Read it
  from the instance's own `NetworkOut` history, at a 1-hour period.
- **Enrollments.** At `ALCOVE_RELAY_TOTAL_QUOTA` allocations, two to an
  exchange, each held about 600 s, the relay at full use starts
  `ALCOVE_RELAY_TOTAL_QUOTA` x 3 exchanges an hour, each enrolled once
  ([The registrar](#the-registrar), Enrollment without a token, The
  ceiling). More enrollments than that are more exchanges than the relay
  could carry if every one relayed. A 6-hour sum holds at most 6 hours of
  enrollments plus the longest gap between the publisher's runs, 07:55 to
  11:00 UTC (3 hours 5 minutes), which the 11:00 run publishes as one
  datapoint: under 9 hours 5 minutes in all, which is under 10 hours. So the
  threshold is 10 hours at full use, 30 times the quota, and ordinary
  enrollments in the jobs' hours do not trip it at 11:00. The cost is slower
  detection: an hourly sum would fire within the hour enrollments pass full
  use, while this one fires up to 6 hours later, and only once they average
  five thirds of full use over the 6 hours. Change the threshold with the
  quota.
- **Heartbeat.** A working publisher puts one heartbeat in each UTC day,
  whatever the relay's traffic, at the day's first run, normally 00:00 UTC,
  or 11:00 or later where the runs before the skipped hours failed. Two days
  rather than one, so the day in progress, before its first run, is not taken
  for a publisher that fails. It fires within about three days of the
  publisher's last success.
- **Refusals.** Each bound the registrar refuses at is sized to admit
  legitimate use ([The registrar](#the-registrar), Enrollment without a
  token), so a refusal is a client past it. A ceiling refusal also refuses
  every other new enrollment without a token.
- **Again after the default.** Where the month a baseline came from preceded
  the web app's default use of this relay, record both baselines again a
  month after that default reached production, since it changes the relay's
  normal traffic and spend.

### When an alarm fires

On the relay host, as root. What is happening now, for any alarm:

```sh
cat /var/lib/alcove-relay/registrar-counters
# Client connections on 443 by address, most first.
ss -Htn state established '( sport = :443 )' | awk '{print $4}' | sed 's/:[0-9]*$//' | sort | uniq -c | sort -rn | head
```

- **`alcove-relay-network-out`.** `ss -tin state established '( sport = :443 )'`
  lists each client connection with `bytes_acked`, the bytes sent to it; the
  addresses holding most of them are where the traffic goes. coturn logs no
  line for an allocation and no byte count
  ([the deployment record](../../docs/notes/webrtc-relay-deployment.md#what-the-relay-host-keeps)),
  so its journal cannot trace the traffic to an exchange; `journalctl -u
  alcove-relay.service --since -1h | grep -c 'are wrong'` counts failed
  authentications, a client guessing credentials. The front's journal
  (`journalctl -u alcove-relay-front.service`) names a client address beside
  the service port when a service refused or reset it, and its `limiting
  connections by zone` lines name each address the WebSocket relay's bound
  refused. Block the addresses sending most of the traffic; revoke an
  exchange known to be theirs.
- **`alcove-relay-tokenless-enrollments` and the three refusal alarms.** The
  registrar's journal (`journalctl -u alcove-relay-registrar.service --since
  -1h`) has one line per request, naming its method, path and status, and a
  `credential issuance:` line for each exchange written. It logs no address,
  so an address that keeps appearing in the connection count above while the
  counts rise is the likeliest source: block it. Enrollments above the
  threshold from many addresses, or any ceiling refusal, mean turning
  enrollment without a token off.
- **`alcove-account-estimated-charges`.** The month's cost by usage type:
  `aws ce get-cost-and-usage --time-period Start=<first of the month>,End=<tomorrow>
  --granularity MONTHLY --metrics UnblendedCost --group-by
  Type=DIMENSION,Key=USAGE_TYPE`, from a machine holding the account's
  credentials. Data transfer out of the instance is the relay's traffic: as
  for `alcove-relay-network-out`. Anything else is not the relay's.
- **`alcove-relay-publisher-heartbeat`.** The publisher has sent nothing for
  two UTC days, so the alarms on the registrar's counts would not fire either.
  `journalctl -u alcove-relay-metrics.service --since -3days` names the cause
  on its last lines: CloudWatch refusing the publish (the instance role's
  permission, or the network), a counters file it cannot read or that is
  malformed, or no counters file, where the registrar is not running.
  `systemctl list-timers alcove-relay-metrics.timer` shows whether the timer
  still runs. After the fix, `systemctl start alcove-relay-metrics.service`
  runs it once, and the alarm returns to OK at the next day's heartbeat.

The responses:

- **Revoke an exchange.** `revoke-exchange.sh <exchange-id>`
  ([Per-exchange keys](#per-exchange-keys)). An allocation already open is not
  cut, so block its client's address too.
- **Block an address at the 443 front.** Insert a rule that drops its
  traffic to port 443:

  ```sh
  iptables -I INPUT -s <address> -p tcp --dport 443 -j DROP
  ```

  Use `ip6tables` for an IPv6 address. A new connection from it is dropped; an
  open one gets nothing more through, and the front closes it after at most
  900 s idle ([The 443 front](#the-443-front), Bounds). The rules last until a
  reboot. `iptables -L INPUT -n --line-numbers` lists them with their numbers;
  `iptables -D INPUT <number>` removes one. On a host that has `nft` instead,
  `nft add rule` into an `input` chain with `ip saddr <address> tcp dport 443
  drop` does the same, and `nft -a list ruleset` shows the handle that
  `nft delete rule` takes.
- **Turn enrollment without a token off.** Set
  `ALCOVE_RELAY_REGISTRAR_TOKENLESS_ENROLLMENT=off` in `relay.env`, then
  `systemctl restart alcove-relay-registrar.service`
  ([The registrar](#the-registrar), Enrollment without a token). A browser run
  then enrolls nothing and dials without the default relay, by STUN alone,
  until it is turned back on; rows already enrolled lapse within 70 minutes.

## Portability

The core of this directory is cloud-neutral. Moving it to Azure, to another
provider, or on-prem changes four things and nothing else:

- **The external address.** `render-config.sh` calls whatever
  `ALCOVE_RELAY_EXTERNAL_IP_HELPER` names and requires only that it print
  `<public>/<private>` on one line. `aws/external-ip.sh` reads IMDSv2; another
  cloud is a sibling of that file, and a host with a static pair is two lines of
  `printf`.
- **The DNS-01 provider.** Two variables in `acme.env`.
- **OS updates.** [The update unit](#os-updates) is
  installed only on Amazon Linux 2023; elsewhere the distribution's own
  automatic updates take its place.
- **Monitoring.** [The counts publisher](#monitoring) calls CloudWatch, and
  runs only where `ALCOVE_RELAY_METRICS_REGION` is set; elsewhere leave it
  unset and read the counters file with that provider's own tooling.

The image, the configuration, the units, the credential model, and the
verification are the same everywhere. Neither `install.sh`'s `dnf` lines nor the
`aws/` directory is reached by anything else here, but for the publisher's
timer, which stays disabled without that setting; on a distribution without
`dnf`, install podman or docker with that distribution's own package manager and
`install.sh` uses what it finds.

## What is not tracked

The tooling is here; nothing that carries a secret, identifies an account, or is
a rendered artifact is. Each path is ignored by this directory's `.gitignore`,
and every script refuses to run rather than defaulting to a value it was not
given.

| path | what goes there |
| --- | --- |
| `/etc/alcove-relay/static-auth-secret` | Optional. The static secret `mint-credential.sh` signs under, mode 600. It never appears on a unit's `ExecStart` line, in a tracked file, or in the journal |
| `/etc/alcove-relay/registrar-token` | Optional. The relay-owner token, mode 600, which enrolls an exchange at the registrar and is the operator's recovery route there; the registrar runs only where it exists |
| `/etc/alcove-relay/turnserver.conf` | The rendered configuration, mode 600, because it can hold that secret. Rendered from the tracked template on every start |
| `/var/lib/alcove-relay/turndb` | The secrets table and the exchange mapping beside it, owned by the container's uid, in a mode-700 directory of that account's |
| `/etc/alcove-relay/certs/` | The certificate and private key the ACME hook deploys. The key is mode 600 and owned by root |
| `/etc/alcove-relay/relay.env` | The realm, the port range, the quotas, and the external-address helper. Copy [`relay.env.example`](relay.env.example) |
| `/etc/alcove-relay/acme.env` | The ACME contact, client, provider, and the provider's credential. Copy [`certs/env.example`](certs/env.example) |
| `aws/env` | The demo box's instance id, region, profile, and optional zone credential. Copy [`aws/env.example`](aws/env.example) |

Not to be confused with [`hosted/`](../hosted/README.md), the OpenTofu root
for the project's hosted web application environments.
