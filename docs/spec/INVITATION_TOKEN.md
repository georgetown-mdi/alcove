---
title: "Invitation Token"
---

# Invitation token

This document specifies the invitation token: the encoded string an inviting party hands its partner out of band to set up an exchange.
It covers the encoding and its checksum, the token's fields and their rules, the connection endpoint's per-channel layout, the size bounds, the checks a minter applies, and the checks a receiver applies, in order, each with the constant or function that applies it.
It is the implementation-level complement to [Invitation contents and confidentiality](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality) in SECURITY_DESIGN.md, which covers what an invitation contains, why it is confidential, and its lifetime policy.
It does not cover the fields of the linkage-terms document the token includes (see [EXCHANGE_REFERENCE.md](../EXCHANGE_REFERENCE.md#linkage-terms)) or that document's bounds (see [PARSED_INPUT_BOUNDS.md](PARSED_INPUT_BOUNDS.md), [TRANSFORM_REGEX_DIALECT.md](TRANSFORM_REGEX_DIALECT.md) and [TRANSFORM_PARAMETER_BOUNDS.md](TRANSFORM_PARAMETER_BOUNDS.md)).
It does not cover the split-directory role swap or the meaning of the retain-mode declaration (see [FILE_SYNC.md](FILE_SYNC.md#split-inboundoutbound-directories)), the relay locator's url grammar (see [PROTOCOL.md](PROTOCOL.md#the-invitations-relay-locator)), how the shared secret is generated and rotated (see [PROTOCOL.md](PROTOCOL.md#shared-secret-rotation)), or how an accepted token becomes a key file and a connection (see [EXCHANGE_FILE.md](EXCHANGE_FILE.md#channel-binding-semantics)).
Intended readers are security auditors and implementors.

The encoder and decoder are `encodeInvitation` and `decodeInvitation` in `packages/core/src/config/invitation.ts`, the module every constant and schema below is defined in unless another is named.
The token is partner-supplied input: an accepting party decodes a string an unauthenticated counterparty wrote.

## Encoding

```
encoded  = BODY || CHECKSUM
BODY     = base64url(utf8(JSON(token)))
CHECKSUM = base64url(SHA-256(utf8(JSON(token)))[0..4])
```

`base64url` is the URL-safe alphabet (`A-Z`, `a-z`, `0-9`, `-`, `_`) with no `=` padding.
The checksum is the first 4 bytes of the SHA-256 digest of the same UTF-8 bytes `BODY` encodes, which unpadded base64url always writes as 6 characters (`CHECKSUM_CHARS`).
There is no separator: a decoder takes the last 6 characters as the checksum and the rest as the body.

The JSON is `JSON.stringify` of the token as the mint schema parsed it, so it has no insignificant whitespace, and only the schema's own fields reach it.
Every key is camelCase, at every depth, the linkage terms and the connection endpoint included.
No canonical form is involved: the checksum covers the exact bytes the encoder wrote, and the decoder reads the members in any order.

The checksum detects transcription errors only.
Anyone can recompute it over any payload, so it gives no integrity or authenticity against a party who writes a token on purpose.

### How the string travels

The encoded string is passed as a bare code or inside a web application accept link, `<origin>/accept#<encoded>`, where `/accept` is `INVITATION_ACCEPT_ROUTE_PATH`.
The token sits in the URL fragment, so a browser does not send it to the server.
The CLI accepts either form: `invitationFromAcceptLink` (`apps/cli/src/invitationDecode.ts`) takes the fragment of an `http:` or `https:` URL and passes any other value through unchanged.
The web paste field uses `tokenFromInput` (`apps/web/src/psi/invitation.ts`), which takes the text after the first `#` of any input that has one.

A pasted token may arrive wrapped by an email or chat client.
`stripInvitationWhitespace` removes every ECMAScript `\s` character from it, interior ones included, before the decode.
An input longer than `MAX_RAW_INVITATION_LENGTH` (**131,072** characters, twice the encoded bound) is returned unchanged, without being scanned, for the decode to refuse by length.

## Fields

The token is a JSON object with these members:

| Member | JSON type | Required | Rule |
| --- | --- | --- | --- |
| `version` | string | yes | The decimal string of a positive integer no larger than the newest version this build reads, `"1"`. A larger one is refused as made by a newer Alcove, naming both versions; the number `1` and any other string are refused. |
| `about` | object | no | The informational block; see [Version policy](#version-policy). |
| `linkageTerms` | object | yes | A linkage-terms document, validated by `InvitationLinkageTermsSchema`: `LinkageTermsSchema` behind a key-folding pre-pass (below). |
| `sharedSecret` | string | yes | `SHARED_SECRET_REGEX` (`packages/core/src/config/connection.ts`): 43 base64url characters, the last one in `[AEIMQUYcgkosw048]`, so the string decodes to exactly 32 bytes. |
| `expires` | string | no | An ISO 8601 date-time in UTC with seconds, a `Z` suffix and any number of fractional-second digits (`z.iso.datetime()`); an offset, a time without seconds, a date alone, a lowercase `z`, or `null` is refused. |
| `connectionEndpoint` | object | no | A credential-free locator; see [Connection endpoint](#connection-endpoint). |
| `inviterRetainsFiles` | boolean | no | The inviting party's retain-mode declaration; see [Cross-field rules](#cross-field-rules). |

The top-level object is strict: a member outside this table is refused as made by a newer Alcove, naming the member.
The encoder serializes only the members of this table, so a member outside it never reaches the wire from an Alcove mint.
Top-level member names are not case-folded: `linkage_terms` or `shared_secret` is an unknown member and is refused.

Inside `linkageTerms` the keys are folded from snake_case to camelCase by the bounded `camelizeKeys` walk (`packages/core/src/utils/camelizeKeys.ts`) before `LinkageTermsSchema` validates them, the same fold a configuration file's terms take.
Two keys of one object that fold to one name are refused with `KeyFoldCollisionError`.
The walk leaves a `transform.params` object with more than `MAX_PARAMS_ENTRIES` (**256**) members unrewritten, for the schema's count bound to refuse.
A key anywhere in the terms document that the schema does not read is refused as made by a newer Alcove, naming the key as the token spells it, after a schema parse that succeeds.

### Version policy

The token is versioned under the same rule as the exchange file ([EXCHANGE_FILE.md](EXCHANGE_FILE.md#versioning-and-compatibility-policy)), with its own version table (`INVITATION_VERSION_POLICY`, `packages/core/src/config/invitation.ts`):

- `encodeInvitation` writes the token at the lowest version its content needs: it leaves out each member that holds the value an older decoder takes the member's absence to mean, and states as `version` the version the remaining members need, whatever `version` its caller passed.
  A token that uses no member newer than an older decoder's version is therefore one that decoder reads.
- `decodeInvitation` refuses a `version` above the newest it reads before the schema, naming both versions, and refuses a declared `version` below what the token's members need, naming the member and the version it needs.
- The `about` member is the informational block: the mint time (`mintedAt`), the minting build (`mintedBy`), a `label`, a `comment`, and a form hint (`formHint`).
  A decoder of any version skips every member of it, a member it does not know included.
  Every other position is strict.

Version 1 holds every member above, the split directory pair and the webrtc `relay` of the endpoint included ([FILE_SYNC.md](FILE_SYNC.md#split-inboundoutbound-directories), [PROTOCOL.md](PROTOCOL.md#the-invitations-relay-locator)), so the version table is empty.

### Connection endpoint

`connectionEndpoint` is discriminated by `channel`, which is one of `webrtc`, `sftp` or `filedrop`; any other value is refused.
Each channel's object is strict (`z.strictObject`): a key outside its row below is refused, not stripped, so a password, private key, API key, relay credential or host-key fingerprint cannot be added to a token that still decodes.
Endpoint keys are not case-folded, so `inbound_path` is an unknown key and refused.

| Channel | Members |
| --- | --- |
| `webrtc` | `channel`; `host` (required); `port`; `path`; `relay` |
| `sftp` | `channel`; `host` (required); `port`; `path`; `inboundPath`; `outboundPath` |
| `filedrop` | `channel`; `path`; `inboundPath`; `outboundPath` |

- `host` is a string of 1 to `MAX_ENDPOINT_HOST_LENGTH` (**256**) UTF-16 code units, the only check the schema makes.
  A `webrtc` host must also be a bare authority, with no port of its own, which every acceptor checks before it dials ([WEBRTC_TRANSPORT.md](WEBRTC_TRANSPORT.md#broker-socket)).
- `port` is an integer from 1 to 65535.
  Port 0 is refused, which is stricter than the connection configuration, since an OS-assigned port is never a connect target.
- `path`, `inboundPath` and `outboundPath` are each a string of 1 to `MAX_ENDPOINT_PATH_LENGTH` (**4096**) UTF-16 code units.
  They are not checked to be absolute here: the accepting party remaps the inviter's paths, and `packages/core/src/config/connection.ts` checks its own final configuration.
- `relay` is the inviting party's relay locator, TURN and STUN urls, a WebSocket relay url with its exchange id, and a registrar url only (`relayLocatorSchema` in `packages/core/src/config/connection.ts`), with its grammar and bounds in [PROTOCOL.md](PROTOCOL.md#the-invitations-relay-locator).

`ConnectionEndpointSchema` then applies four rules to the `sftp` and `filedrop` endpoints, each at both encode and decode:

1. `inboundPath` and `outboundPath` are present together or not at all.
2. The two differ under `pathsResolveToSameDir` (`packages/core/src/utils/pathCompare.ts`), the same function the connection configuration applies.
3. `path` and the pair are not both present.
4. A `filedrop` endpoint names a directory, `path` or the pair.
   An `sftp` endpoint may name none of the three, meaning the login home directory.

A refusal of an unknown endpoint key starts with the locator allowlist and then names the rejected keys, each fitted to `DEFAULT_MAX_DISPLAY_LENGTH` (`endpointKeyError`).
The names are partner-chosen and are composed raw, for the display boundary to escape once ([DISPLAY_ESCAPE.md](DISPLAY_ESCAPE.md#display-sanitization-escape-format)).

### Cross-field rules

`InvitationTokenSchema` refuses two pairings at both encode and decode, each reported on `inviterRetainsFiles`:

- `inviterRetainsFiles: true` beside a `webrtc` endpoint.
- `inviterRetainsFiles: false` beside an endpoint with the split pair, which `endpointRequiresRetainedFiles` reports as requiring retain mode.

The mint applies a third rule that decode does not: `MintedInvitationTokenSchema` refuses a split-pair endpoint unless `inviterRetainsFiles` is `true`.
A token from another implementation that omits the declaration beside a split pair still decodes.
What the declaration means, and why the third rule binds the mint only, is in [FILE_SYNC.md](FILE_SYNC.md#retain-mode-declaration-on-the-token).

## Size bounds

The encoded bound is the one that limits every field at decode.
The checksum is no barrier to a crafted payload, so the per-field bounds below it are defense in depth.

| Bound | Value | Applied by |
| --- | --- | --- |
| `MAX_ENCODED_INVITATION_LENGTH` | **65,536** characters | `decodeInvitation`, before any other work; `encodeInvitation`, on its own output |
| `MAX_RAW_INVITATION_LENGTH` | **131,072** characters | `stripInvitationWhitespace`, which leaves a longer input unscanned |
| `MAX_ENDPOINT_HOST_LENGTH` | **256** UTF-16 code units | the `host` of a `webrtc` or `sftp` endpoint |
| `MAX_ENDPOINT_PATH_LENGTH` | **4096** UTF-16 code units | each endpoint path |
| `MAX_RELAY_LOCATOR_URLS`, `MAX_RELAY_LOCATOR_URL_LENGTH` | **8** urls per list, **1024** code units per url | the webrtc `relay` ([PROTOCOL.md](PROTOCOL.md#the-invitations-relay-locator)) |
| `parseBoundedJson` structure bounds | per object, per array, nesting depth | the decoded JSON, before `JSON.parse` ([PARSED_INPUT_BOUNDS.md](PARSED_INPUT_BOUNDS.md#application-layer-parsed-input-bounds)) |
| `camelizeKeys` bounds | nesting depth and total node count | the `linkageTerms` fold ([PARSED_INPUT_BOUNDS.md](PARSED_INPUT_BOUNDS.md#application-layer-parsed-input-bounds)) |

The linkage-terms document's own count, length, regex and parameter bounds apply to `linkageTerms` as they do to any terms document; they are in the documents named in the introduction.
The string bounds count UTF-16 code units through `maxCodeUnits` (`packages/core/src/utils/maxCodeUnits.ts`).

## Minting

`encodeInvitation` mints a token in this order:

1. Keep only the token's members the schema names, leave out each that holds the value an older decoder assumes for its absence, and set `version` to the lowest version the rest need ([Version policy](#version-policy)).
   Validate the result against `MintedInvitationTokenSchema`, throwing `ZodError` on a failure, and keep the parse result.
2. Refuse an `expires` that is not in the future, with `UsageError`.
3. Encode the parse result as in [Encoding](#encoding).
4. Refuse an encoded string longer than `MAX_ENCODED_INVITATION_LENGTH`, with a `UsageError` naming the length and the remedy, so that an invitation the partner could not decode is never handed over.
   Fields that are each within bounds can exceed it together, a long `exclude` list among them.

Alcove's inviters compute `expires` with `invitationExpires`: the moment the shared secret is minted plus the lifetime, as `Date.prototype.toISOString` writes it (millisecond precision, `Z`).
The lifetime is `INVITATION_LIFETIME_SECONDS` (**3600**, one hour) unless the inviter sets one, and `assertInvitationLifetimeSeconds` refuses a lifetime that is not a finite positive number of seconds or exceeds `MAX_INVITATION_LIFETIME_SECONDS` (**31,536,000**, 365 days).
That ceiling binds Alcove's inviters only: `encodeInvitation` checks that `expires` is in the future and nothing more, and `decodeInvitation` does not check the lifetime.

## Decoding

`decodeInvitation` refuses a token at the first check it fails, in this order.
Each of the first five throws `InvitationDecodeError` with a fixed message containing no byte of the input, and names the check in its `failure` field.

1. **Length** (`tooLong`): a string longer than `MAX_ENCODED_INVITATION_LENGTH` is refused before anything else reads it.
2. **Too short** (`tooShort`): a string of 6 characters or fewer has no body.
3. **Body encoding** (`notBase64Url`): the body is decoded by `fromBase64Url` (`packages/core/src/utils/crypto.ts`), which refuses a length that leaves a remainder of 1 when divided by 4 and any character outside `A-Z`, `a-z`, `0-9`, `-` and `_`, apart from up to two trailing `=`.
4. **Checksum** (`checksumMismatch`): the first 4 bytes of the SHA-256 digest of the decoded body bytes, base64url-encoded, are compared with the last 6 characters as strings.
5. **JSON** (`notJson`): the bytes are parsed by `parseBoundedJson` (`packages/core/src/utils/boundedJson.ts`), which checks the structure bounds over the bytes, decodes them as UTF-8 with invalid sequences refused, and then calls `JSON.parse`.
   A structure over a bound, invalid UTF-8 and malformed JSON are all reported as `notJson`.
6. **Version**: a `version` above the newest this build reads is refused with `ZodError`, naming both versions.
7. **Schema**: the parsed value is validated against `InvitationTokenSchema`, which throws `ZodError` on a failure.
   The `linkageTerms` fold runs inside that validation and throws its own errors through it: `NestingDepthExceededError`, `NodeCountExceededError` and `KeyFoldCollisionError`, each a `UsageError`.
   A schema that accepts the token is followed by the refusal of each key of the terms the schema did not read, and of a declared `version` below what the members need, each with `ZodError`.

The `failure` values divide into two groups by what the receiving party can do (`InvitationDecodeFailure`).
`tooShort`, `notBase64Url` and `checksumMismatch` mean the string was cut or changed in transit, so a fresh copy of the same invitation may decode.
`tooLong` and `notJson` mean an intact string this build does not read, so only a new invitation helps.
A schema failure, including the `linkageTerms` fold errors (`NestingDepthExceededError`, `NodeCountExceededError`, `KeyFoldCollisionError`), is also an intact string this build does not read, so it takes the second group's remedy.
A format version newer than this build reads is the one exception, since updating Alcove opens the invitation (`isNewerInvitationVersionError`, `INVITATION_NEWER_REMEDY`).
The web accept route chooses its message by that division (`invitationDecodeRefusal` in `apps/web/src/exchange/invitationDecodeRefusal.ts`).

`decodeInvitation` does not check `expires` against the clock: a token past its expiry decodes, and the expiry check below is a separate step.

**Limits**:
- The body encoding is not unique.
  `fromBase64Url` accepts trailing `=` padding and passes the body to `atob`, which ignores the unused low bits of the last character, so more than one string decodes to the same bytes and the same token.
  The checksum covers the decoded bytes, not the string.
- A JSON object with a repeated member name decodes with the last value, as `JSON.parse` reads it; the repetition is not refused.
- A leading UTF-8 byte order mark is removed by the UTF-8 decode and the token decodes.
- The checksum comparison is an ordinary string comparison; it guards no secret.

**Held by**: `packages/core/test/config/invitation.test.ts`, among them "each pre-schema decode failure names its kind on the error", "rejects an encoded string longer than the maximum, before parsing", "admits an encoded string at exactly the maximum length", "decodeInvitation swallows the JSON.parse error, never relaying partner bytes", "decodeInvitation accepts snake_case structural linkage-terms keys, like the config path", "strips an unknown top-level field rather than embedding it", and the endpoint cases "decodeInvitation rejects a $channel endpoint holding $field"; `packages/core/test/config/invitationRelay.test.ts` for the relay locator.

**Why**: the checksum exists so that a hand-copied or wrapped token that lost a character fails with a transcription message rather than a schema error.
The length bound is checked first because nothing else in the token bounds what a crafted string costs to decode.
The fixed messages keep partner bytes out of the decode refusals; how a schema refusal's partner-chosen parts reach a display is in [DISPLAY_REDACTION.md](DISPLAY_REDACTION.md#message-display-budgets).

## Accepting

Decoding establishes only that the string is a well-formed token.
The accepting paths apply these further checks after the decode, before anything is written or any connection is made, each on the paths named with it.

**Expiry.**
`isInvitationExpired(expires, now)` refuses a token whose `expires` is at or before `now`: a token whose `expires` equals `now` is expired.
An `expires` that does not parse, or a `now` that does not, is treated as expired.
A token with no `expires` does not expire.
The CLI applies it in `decodeAndValidateInvitation` (`apps/cli/src/invitationDecode.ts`), the one decode `alcove accept` and `alcove exchange --invitation` share, and the web application in `prepareAcceptedInvitation` (`apps/web/src/psi/acceptInvitation.ts`).

**Endpoint.**
The web application refuses a token with no `connectionEndpoint`, and one whose channel this build cannot drive (`endpointDrivableHere`): `webrtc` on every build, `filedrop` and `sftp` on a console build only.
The CLI drives all three channels and accepts a token with no endpoint.
The full rule is in [EXCHANGE_FILE.md](EXCHANGE_FILE.md#channel-binding-semantics).

**Terms.**
The accepting party's terms are derived from the inviter's by `deriveAcceptedLinkageTerms` (`packages/core/src/linkageTermsNegotiation.ts`), which refuses `psi-c` terms outside the count-only shape (`assertCountOnlyTermsShape`), a `deduplicate` under a strategy that matches no deduplicating cardinality (`assertDeduplicateImplemented`), and an element transform that does not compile (`assertTransformsCompile`).
`alcove accept` derives the terms through it before its confirmation prompt.
The web application runs `assertDeduplicateImplemented` and `assertTransformsCompile` in `prepareAcceptedInvitation` before its consent screen, and the derivation itself through `acceptorExchangeDataSpec`.
`alcove exchange --invitation` takes only `sharedSecret` and `expires` from the token, so it applies the expiry check alone ([EXCHANGE_FILE.md](EXCHANGE_FILE.md#exchange---invitation-fail-closed-ordering)).

**Limits**:
- Nothing in the token is authenticated.
  The key exchange authenticates whoever has `sharedSecret`, and the linkage terms are exchanged and compared again after it ([PROTOCOL.md](PROTOCOL.md#a-terms-change-at-the-terms-exchange)); before then, the terms and the endpoint are whatever the string's author wrote.
- Expiry is judged by the accepting party's own clock, with no allowance for skew between the two parties' clocks.

**Depends on**: the token reaching the partner over a channel the two parties trust, since anyone who reads it has the setup secret ([SECURITY_DESIGN.md](../SECURITY_DESIGN.md#invitation-contents-and-confidentiality)).

**Held by**: `packages/core/test/config/invitation.test.ts` ("isInvitationExpired: equal to now fails closed (expired at the boundary)", "isInvitationExpired: an unparseable expires fails closed (rejected)", "decodeInvitation succeeds on a token with a past expires"); `apps/cli/test/unit/commands/accept.test.ts` ("an expired invitation is rejected, naming the expiry time", "a web app accept link decodes to the token its fragment holds", "a hard-wrapped invitation paste decodes at the command level"); `apps/web/test/unit/psi/acceptInvitation.test.ts` ("rejects an expired invitation (before any connect)", "rejects an invitation with no connection endpoint", "rejects an element transform that cannot compile, before the consent screen").
