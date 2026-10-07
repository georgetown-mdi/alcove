import {
  ConnectionConfigSchema,
  HOST_KEY_FINGERPRINT_REGEX,
  isBareSftpHost,
  isSftpPort,
  parseSftpUrl,
  sftpUrlDirectoryFault,
  withRetainModeImplications,
} from "@alcove/core";
import type { SftpUrlFields } from "@alcove/core";

import type {
  AuthoredSftpConnectionRequest,
  CredentialMount,
} from "@psi/jobClient/sftpAuthoringClient";

/**
 * The pure model behind the console's SFTP connection authoring form: the field
 * set, its validation (a required host and username, an optional port, a required
 * literal host-key fingerprint, and exactly one credential source), the
 * pasted-`sftp://`-URL split, and the single derivation that turns valid fields
 * into the `PUT /api/jobs/sftp` body. No React, no I/O -- the tested boundary for
 * "the form only submits a valid authoring request".
 *
 * The credential is a FILE by default -- one the operator picked from the secrets
 * mount (a locator the server resolves) or a typed `@path` reference -- with a
 * de-emphasized fallback to paste the value, which the server materializes to a
 * file on the console. The optional passphrase is always an `@path`, never a
 * pasted value.
 */

/** Which primary auth method the credential feeds; the radio enforces at-most-one
 * primary at the control level. */
export type SftpCredentialMethod = "password" | "private_key";

/**
 * Where the primary credential comes from:
 * - `mount`: a file the operator picked in the credential browser -- under the
 *   secrets directory, or under the working folder when none is mounted -- as
 *   its path segments under that mount; the server resolves them to an
 *   absolute path.
 * - `path`: a typed `@path` for a credential outside any listable mount.
 * - `raw`: a pasted value (the de-emphasized fallback); the server materializes it
 *   to a file on the console. It is held in component state only, never
 *   persisted to browser storage or the query cache.
 */
type SftpCredentialSource =
  | { kind: "mount"; mount: CredentialMount; subPath: Array<string> }
  | { kind: "path"; ref: string }
  | { kind: "raw"; value: string };

/** The authoring form's field values. */
export interface SftpConnectionFormValues {
  host: string;
  username: string;
  /** The remote working directory. On its own it is the single directory both
   * parties exchange through; paired with a non-empty {@link outboundDirectory}
   * it is the INBOUND (peer-written) half of a split-directory connection. */
  remoteDirectory: string;
  /** The outbound (self-written) remote directory, for a server with distinct
   * drop and pickup folders. Blank for the ordinary single-directory
   * connection. */
  outboundDirectory: string;
  port: string;
  /** One host-key fingerprint, or several separated by commas or spaces for a
   * server whose key is changing: the connection accepts any one of them
   * ({@link hostKeyFingerprintEntries}). */
  hostKeyFingerprint: string;
  method: SftpCredentialMethod;
  /** The chosen primary credential file, or undefined until one is picked/typed. */
  source: SftpCredentialSource | undefined;
  /** A typed `@path` to the private key's passphrase file (private_key only,
   * optional); it is also a file reference, never a pasted secret. */
  passphrasePath: string;
  /** Answer the server's keyboard-interactive prompts with the configured
   * password (password only, optional). Not a second credential: the same
   * password, offered over a different SSH authentication method. */
  keyboardInteractive: boolean;
  /** Set when the last host input was a pasted address core could not read: the
   * host field was cleared rather than keep text that may hold a password. */
  hostPasteUnreadable?: boolean;
}

/** The form's initial state, before the operator authors anything. */
export const EMPTY_SFTP_FORM: SftpConnectionFormValues = {
  host: "",
  username: "",
  remoteDirectory: "",
  outboundDirectory: "",
  port: "",
  hostKeyFingerprint: "",
  method: "password",
  source: undefined,
  passphrasePath: "",
  keyboardInteractive: false,
};

/** A partner-supplied SFTP locator: the credential-free host/port/path an accepted
 * invitation's endpoint holds. It names WHERE to connect and nothing else -- an
 * {@link SFTPEndpoint} structurally cannot hold a credential or a host-key
 * fingerprint. */
export interface SftpEndpointLocator {
  host: string;
  port?: number;
  path?: string;
}

/**
 * Seed the authoring form from a partner-supplied SFTP locator (an accepted
 * invitation's endpoint). ONLY the host, port, and remote directory pre-fill; the
 * fingerprint, credential, method, and passphrase stay EMPTY -- the operator
 * supplies every one of those. This is the accept-side pre-fill boundary: no
 * invitation field can populate a credential or the host-key fingerprint, because
 * the locator holds neither and this reads only its host/port/path. A form built
 * from this alone is unsubmittable ({@link buildAuthoringRequest} returns undefined)
 * until the operator adds the fingerprint and a credential.
 */
export function sftpFormFromLocator(
  locator: SftpEndpointLocator,
): SftpConnectionFormValues {
  return {
    ...EMPTY_SFTP_FORM,
    host: locator.host,
    port: locator.port !== undefined ? String(locator.port) : "",
    remoteDirectory: locator.path ?? "",
  };
}

/** The form fields an error can attach to. */
export type SftpFormField =
  | "host"
  | "username"
  | "remoteDirectory"
  | "outboundDirectory"
  | "port"
  | "hostKeyFingerprint"
  | "credential"
  | "passphrase"
  | "keyboardInteractive";

/** One blocking error on the form: the field and the message. */
interface SftpFormError {
  field: SftpFormField;
  message: string;
}

// The shape of a signing partner_fingerprint (43 base64url characters, no
// prefix): a UX heuristic used only to name the "you pasted a signing
// fingerprint" confusion. It is NOT the security control -- the authoritative
// host-key format check is HOST_KEY_FINGERPRINT_REGEX (imported from core, so it
// cannot drift), re-run server-side on every PUT.
const SIGNING_FINGERPRINT_SHAPE = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;

/**
 * The fingerprints the fingerprint field holds, in the order written. Neither a
 * comma nor whitespace is in the base64 alphabet a fingerprint is written in, so
 * either separates two entries without ambiguity.
 */
export function hostKeyFingerprintEntries(value: string): Array<string> {
  return value.split(/[\s,]+/).filter((entry) => entry !== "");
}

/** The fingerprint field's text for the fingerprints a configuration states. */
export function hostKeyFingerprintField(
  stated: string | ReadonlyArray<string> | undefined,
): string {
  if (stated === undefined) return "";
  return typeof stated === "string" ? stated : stated.join(", ");
}

const SFTP_URL_SCHEME = /^(sftp|ssh):\/\//i;

/** The connection fields a pasted `sftp://` or `ssh://` URL states, or null when
 * the input is not such a URL or core refuses it. */
function sftpUrlFieldsOf(input: string): SftpUrlFields | null {
  if (!SFTP_URL_SCHEME.test(input.trim())) return null;
  try {
    return parseSftpUrl(input);
  } catch {
    return null;
  }
}

/** Apply a typed change to the host field: the text is kept as typed, and a
 * value that is not a bare host is reported by the form's bare-host check. */
export function hostTyped(
  values: SftpConnectionFormValues,
  raw: string,
): SftpConnectionFormValues {
  return { ...values, host: raw, hostPasteUnreadable: false };
}

/** Apply a paste into the host field: a full `sftp://` URL is split across the
 * host, username, port, and remote-directory fields. An `sftp://` or `ssh://`
 * address core refuses, or any text holding login details (`@`), clears the
 * field and flags it, since the text may hold a password. Returns `undefined`
 * for any other text, which the input then inserts as typed. A password in the
 * URL is not read: the credential is chosen as a file. */
export function hostPasted(
  values: SftpConnectionFormValues,
  raw: string,
): SftpConnectionFormValues | undefined {
  const parsed = sftpUrlFieldsOf(raw);
  if (parsed === null) {
    if (!SFTP_URL_SCHEME.test(raw.trim()) && !raw.includes("@"))
      return undefined;
    return { ...values, host: "", hostPasteUnreadable: true };
  }
  return {
    ...values,
    hostPasteUnreadable: false,
    host: parsed.host,
    ...(parsed.username !== undefined ? { username: parsed.username } : {}),
    port: parsed.port !== undefined ? String(parsed.port) : values.port,
    remoteDirectory: parsed.path ?? values.remoteDirectory,
  };
}

// What the console says when the host field holds more than a bare host.
const BARE_HOST_REQUIREMENT =
  "Enter just the server address (like sftp.example.org) -- not a full URL " +
  "or login details.";

/** What the console says when a pasted address could not be read and the host
 * field was cleared. */
export const UNREADABLE_HOST_PASTE =
  "The pasted address could not be read and was cleared. " +
  BARE_HOST_REQUIREMENT;

/** Whether a typed credential/passphrase reference is an `@`-prefixed path. */
function isAtPath(value: string): boolean {
  return value.startsWith("@") && value.length > 1;
}

/** What the console says when a direct exchange's remote directory has a
 * `.` or `..` part, which its `sftp://` URL cannot state. */
export const DIRECT_DIRECTORY_DOT_SEGMENT_REQUIREMENT =
  "A direct exchange cannot use . or .. in this directory. Enter the path " +
  "without them, like /exchange/in.";

/** What the console says when a direct exchange's single remote directory is
 * `/`, which its `sftp://` URL states as the account's home directory. */
export const DIRECT_DIRECTORY_ROOT_REQUIREMENT =
  "A direct exchange cannot use / as this directory. Enter a directory " +
  "under it, like /exchange, or leave this blank to use the account's home " +
  "directory.";

/** {@link DIRECT_DIRECTORY_ROOT_REQUIREMENT} for the inbound half of a split
 * pair, which cannot be left blank. */
export const DIRECT_INBOUND_DIRECTORY_ROOT_REQUIREMENT =
  "A direct exchange cannot use / as this directory. Enter a directory " +
  "under it, like /exchange/in.";

/**
 * The direct-exchange refusal of a remote directory its `sftp://` URL cannot
 * state, or undefined when it has a URL form. Only the remote-directory field
 * is asked: the outbound half of a split pair travels as a flag, not in the
 * URL.
 */
function directDirectoryError(
  remoteDirectory: string,
  split: boolean,
): SftpFormError | undefined {
  if (remoteDirectory === "") return undefined;
  const fault = sftpUrlDirectoryFault(remoteDirectory);
  if (fault === undefined) return undefined;
  return {
    field: "remoteDirectory",
    message:
      fault === "dot-segment"
        ? DIRECT_DIRECTORY_DOT_SEGMENT_REQUIREMENT
        : split
          ? DIRECT_INBOUND_DIRECTORY_ROOT_REQUIREMENT
          : DIRECT_DIRECTORY_ROOT_REQUIREMENT,
  };
}

/**
 * What the console says when the operator names a separate outbound directory
 * without retain mode. It states the CLI's `--outbound-path` precondition -- a
 * split directory requires retain mode -- in the console's own terms, naming the
 * control the operator flips rather than the flag they do not have. Stating it
 * here, while they are still at the controls, is what keeps the requirement from
 * arriving as a refused job: core refuses the same combination when the config is
 * composed, and the CLI refuses it on a Direct run.
 */
export const SPLIT_DIRECTORY_RETAIN_REQUIREMENT =
  "Separate inbound and outbound directories need retain mode: nothing is " +
  "deleted after it is read, so each side keeps its own folder. Turn on " +
  '"Keep every exchange file" under "How files are handled", or clear the ' +
  "outbound directory to use one shared folder.";

/**
 * The one-line form of {@link SPLIT_DIRECTORY_RETAIN_REQUIREMENT}, for a
 * connection summary that has room for a state but not for the remedy in full
 * (which is stated where the exchange is blocked). It names the same control, so
 * the summary and the blocked create reason cannot point in different
 * directions.
 */
export const SPLIT_DIRECTORY_RETAIN_SUMMARY =
  "Its separate inbound and outbound directories need retain mode: turn " +
  '"Keep every exchange file" back on to use this connection.';

/**
 * What the console says when a split pair names only its outbound half. It lands
 * on the empty INBOUND field, the one the operator has to fill, and offers the
 * other way out of the state -- dropping back to one shared directory.
 */
export const SPLIT_DIRECTORY_BOTH_HALVES_REQUIREMENT =
  "Separate directories need both halves: enter the inbound directory, or " +
  "clear the outbound directory to use one shared folder.";

/**
 * What the console says when the two halves name one directory. Worded as
 * NAMING a different directory rather than as differing text, because core
 * refuses only the pairs its own textual comparison can see as one directory
 * -- a trailing slash or a "." segment makes two different strings one
 * folder. Core under-collapses by design: a pair that differs only
 * through ".." segments, case, or the login-home expansion of a relative
 * path is the operator's own to keep distinct, per `pathsResolveToSameDir`'s
 * stated design.
 */
export const SPLIT_DIRECTORY_DISTINCT_REQUIREMENT =
  "The outbound directory must name a different directory from the inbound " +
  "one: your partner writes to the inbound directory and you write to the " +
  "outbound one.";

/**
 * The console's wording for core's split-directory verdicts, keyed by the
 * message core produces, each with the field the operator fills to resolve it.
 * Core's refines stay the single statement of WHEN a pair is wrong; these say it
 * in the labels this form shows, because core words its rules over
 * `inbound_path` and `outbound_path` -- configuration keys the console never
 * puts in front of an operator.
 *
 * An unmapped verdict falls through in core's own words rather than being
 * swallowed; the form-model tests drive every pair shape this form can compose
 * and hold each one to a mapped message.
 */
const SPLIT_DIRECTORY_CONSOLE_ERRORS = new Map<string, SftpFormError>([
  [
    "inbound_path and outbound_path must be set together; a split " +
      "directory needs both halves",
    {
      field: "remoteDirectory",
      message: SPLIT_DIRECTORY_BOTH_HALVES_REQUIREMENT,
    },
  ],
  [
    "inbound_path and outbound_path must differ",
    {
      field: "outboundDirectory",
      message: SPLIT_DIRECTORY_DISTINCT_REQUIREMENT,
    },
  ],
]);

/**
 * Core's own verdict on a split directory pair, in the console's words and on
 * the field that resolves it, or undefined when the pair is coherent. The rules
 * over the pair -- both halves set together, the two resolving to different
 * directories -- are core's single statement, so this composes the connection
 * core would parse and asks core rather than restating any rule of its own.
 *
 * `retain_files` is set on the composed options because the caller has already
 * decided the retain precondition; leaving it off would fire core's retain
 * refine as a second, differently-worded copy of that same message. A blank
 * inbound half is OMITTED rather than sent as an empty string, so an outbound
 * directory named without an inbound one meets core's both-halves-together rule
 * instead of a min-length complaint.
 */
function splitDirectoryError(
  host: string,
  inbound: string,
  outbound: string,
): SftpFormError | undefined {
  const parsed = ConnectionConfigSchema.safeParse({
    channel: "sftp",
    server: {
      host,
      ...(inbound === "" ? {} : { inboundPath: inbound }),
      outboundPath: outbound,
    },
    options: withRetainModeImplications({ retainFiles: true }),
  });
  if (parsed.success) return undefined;
  const coreMessage = parsed.error.issues[0].message;
  return (
    SPLIT_DIRECTORY_CONSOLE_ERRORS.get(coreMessage) ?? {
      field: "outboundDirectory",
      message: coreMessage,
    }
  );
}

/**
 * What the console says when a key passphrase is set while the connection signs
 * in with a password. It states core's `privateKeyPassphrase is only valid with
 * privateKey` rule -- the same one the CLI raises against
 * `--server-private-key-passphrase` -- over the two controls the operator has:
 * the sign-in choice and the passphrase field. Showing it here is what keeps a
 * typed passphrase from being silently dropped on the way to the console.
 */
export const PASSPHRASE_REQUIRES_PRIVATE_KEY =
  'A key passphrase only decrypts a private key: choose "Private key" under ' +
  '"How Alcove signs in", or clear the passphrase reference.';

/**
 * What the console says when keyboard-interactive is armed while the connection
 * signs in with a private key. It states core's `keyboard_interactive requires
 * password` rule -- the same one the CLI raises against
 * `--server-keyboard-interactive` -- over the controls the operator has.
 */
export const KEYBOARD_INTERACTIVE_REQUIRES_PASSWORD =
  "Answering the server's prompts sends the password, so it needs one: choose " +
  '"Password" under "How Alcove signs in", or turn this off.';

/**
 * The console's wording for core's credential-coherence verdicts, keyed by the
 * message core produces, each with the field the operator changes to resolve it.
 * Core's refines stay the single statement of WHICH credential combinations are
 * coherent; these say it in the labels this form shows, because core words its
 * rules over `privateKeyPassphrase` and `keyboard_interactive` -- configuration
 * keys the console never puts in front of an operator, and which the CLI in turn
 * words as flag names.
 *
 * An unmapped verdict falls through in core's own words rather than being
 * swallowed; the form-model tests drive every credential combination this form
 * can compose and hold each one to a mapped message.
 */
const CREDENTIAL_CONSOLE_ERRORS = new Map<string, SftpFormError>([
  [
    "privateKeyPassphrase is only valid with privateKey",
    { field: "passphrase", message: PASSPHRASE_REQUIRES_PRIVATE_KEY },
  ],
  [
    "keyboard_interactive requires password; it answers the server's " +
      "keyboard-interactive prompts with that password and has no effect " +
      "without one",
    {
      field: "keyboardInteractive",
      message: KEYBOARD_INTERACTIVE_REQUIRES_PASSWORD,
    },
  ],
]);

/** A syntactically valid host and credential reference, standing in for the
 * operator's own while the credential COMBINATION is asked about. The host and
 * the credential source have their own errors above, so feeding core the real
 * ones here would answer a coherence question with an unrelated verdict. */
const CREDENTIAL_PROBE_HOST = "sftp.invalid";
const CREDENTIAL_PROBE_REF = "@/credential-file";

/**
 * Core's own verdict on the credential combination the form has composed, in the
 * console's words and on the control that resolves it, or undefined when the
 * combination is coherent. The rules over it -- a passphrase only with a private
 * key, keyboard-interactive only with a password, at most one primary method --
 * are core's single statement, re-run by the console on every `PUT` and by the
 * CLI on every run, so this composes the connection core would parse and asks
 * core rather than restating any rule of its own.
 */
function credentialCoherenceError(
  values: SftpConnectionFormValues,
): SftpFormError | undefined {
  const passphrase = values.passphrasePath.trim();
  const parsed = ConnectionConfigSchema.safeParse({
    channel: "sftp",
    server: {
      host: CREDENTIAL_PROBE_HOST,
      ...(values.method === "password"
        ? { password: CREDENTIAL_PROBE_REF }
        : { privateKey: CREDENTIAL_PROBE_REF }),
      ...(passphrase === "" ? {} : { privateKeyPassphrase: passphrase }),
      ...(values.keyboardInteractive ? { keyboardInteractive: true } : {}),
    },
  });
  if (parsed.success) return undefined;
  const coreMessage = parsed.error.issues[0].message;
  return (
    CREDENTIAL_CONSOLE_ERRORS.get(coreMessage) ?? {
      field: "credential",
      message: coreMessage,
    }
  );
}

/**
 * The first blocking error on the form, or undefined when the fields are savable.
 * Host, username, a literal fingerprint, and a credential source are required; the
 * port is optional but bounded; a typed credential/passphrase must be an `@path`.
 * Each fingerprint is validated against core's `HOST_KEY_FINGERPRINT_REGEX`, and a
 * value shaped like a signing fingerprint gets the confusion message. The two
 * companions of a sign-in method -- the key passphrase and keyboard-interactive
 * -- are held to core's rules over the combination by
 * {@link credentialCoherenceError}, so a companion left armed against the other
 * method blocks the save on its own control instead of being dropped in silence.
 *
 * `retainFiles` is the exchange's retain-mode choice as the operator has it set
 * right now ("How files are handled", the card on the same screen), read
 * only for the split-directory precondition: naming an outbound directory without
 * it is refused here rather than by the job the connection would later compose.
 *
 * `directExchange` holds the connection to what a direct exchange's command
 * line can state: one fingerprint, since the pin is a single-valued flag, and
 * a remote directory with an `sftp://` URL form ({@link directDirectoryError}).
 */
export function sftpFormError(
  values: SftpConnectionFormValues,
  retainFiles: boolean,
  directExchange = false,
): SftpFormError | undefined {
  if (values.host.trim() === "" && values.hostPasteUnreadable === true)
    return { field: "host", message: UNREADABLE_HOST_PASTE };
  if (values.host.trim() === "")
    return { field: "host", message: "Enter the SFTP server address." };
  if (!isBareSftpHost(values.host.trim()))
    return { field: "host", message: BARE_HOST_REQUIREMENT };
  if (values.username.trim() === "")
    return {
      field: "username",
      message: "Enter the username for the SFTP account.",
    };
  const outboundDirectory = values.outboundDirectory.trim();
  if (directExchange) {
    const directoryError = directDirectoryError(
      values.remoteDirectory.trim(),
      outboundDirectory !== "",
    );
    if (directoryError !== undefined) return directoryError;
  }
  // The split rules apply only when an outbound directory is named.
  if (outboundDirectory !== "") {
    if (!retainFiles)
      return {
        field: "outboundDirectory",
        message: SPLIT_DIRECTORY_RETAIN_REQUIREMENT,
      };
    const splitError = splitDirectoryError(
      values.host.trim(),
      values.remoteDirectory.trim(),
      outboundDirectory,
    );
    if (splitError !== undefined) return splitError;
  }
  const port = values.port.trim();
  if (port !== "") {
    if (!isSftpPort(Number(port)))
      return {
        field: "port",
        message: "Enter a port number between 1 and 65535.",
      };
  }
  const fingerprintError = fingerprintErrorFor(
    values.hostKeyFingerprint,
    directExchange,
  );
  if (fingerprintError !== undefined)
    return { field: "hostKeyFingerprint", message: fingerprintError };

  const source = values.source;
  if (source === undefined)
    return {
      field: "credential",
      message:
        "Choose the credential file, type a file reference, or paste " +
        "the value.",
    };
  if (source.kind === "mount" && source.subPath.length === 0)
    return {
      field: "credential",
      message:
        "Choose the credential file, type a file reference, or paste " +
        "the value.",
    };
  if (source.kind === "path" && !isAtPath(source.ref.trim()))
    return {
      field: "credential",
      message:
        "Enter the credential as an @-file reference to an absolute path " +
        "inside the console, e.g. @/secrets/sftp-password.txt.",
    };
  // A pasted value must be non-empty; whitespace is significant in a secret, so
  // it is not trimmed. An opened paste with an empty value is a raw source with an
  // empty string (not an absent source), so this dedicated message is reachable
  // and renders at the paste field.
  if (source.kind === "raw" && source.value === "")
    return {
      field: "credential",
      message: "Enter the pasted credential value, or choose a file instead.",
    };

  // The combination first, then the shape: a passphrase set against a password
  // sign-in is answered by the rule that explains it, not by a reference-format
  // complaint about a field that does not belong there at all.
  const coherenceError = credentialCoherenceError(values);
  if (coherenceError !== undefined) return coherenceError;

  if (
    values.passphrasePath.trim() !== "" &&
    !isAtPath(values.passphrasePath.trim())
  )
    return {
      field: "passphrase",
      message:
        "Enter the passphrase as an @-file reference to an absolute path " +
        "inside the console, e.g. @/secrets/key-passphrase.txt.",
    };
  return undefined;
}

/** The fingerprint field's error message, or undefined when every entry it holds
 * is a valid literal OpenSSH SHA256 host-key fingerprint. */
function fingerprintErrorFor(
  value: string,
  singleFingerprint: boolean,
): string | undefined {
  const entries = hostKeyFingerprintEntries(value);
  if (entries.length === 0) return "Enter the server's identity fingerprint.";
  if (singleFingerprint && entries.length > 1)
    return (
      "A quick exchange accepts one server identity fingerprint. Enter the " +
      "one the server presents now."
    );
  for (const [index, entry] of entries.entries()) {
    const error = fingerprintEntryError(entry);
    if (error === undefined) continue;
    return entries.length === 1
      ? error
      : `Fingerprint ${index + 1} (${fingerprintPreview(entry)}): ${error}`;
  }
  return undefined;
}

// Long enough to tell entries apart by their start, short enough that a pasted
// value is not echoed back whole.
const FINGERPRINT_PREVIEW_LENGTH = 16;

/** The start of a fingerprint entry, for naming it in a message. */
function fingerprintPreview(entry: string): string {
  return entry.length <= FINGERPRINT_PREVIEW_LENGTH
    ? entry
    : `${entry.slice(0, FINGERPRINT_PREVIEW_LENGTH)}...`;
}

/** One fingerprint entry's error message, or undefined when it is valid. */
function fingerprintEntryError(fingerprint: string): string | undefined {
  if (HOST_KEY_FINGERPRINT_REGEX.test(fingerprint)) return undefined;
  if (fingerprint.startsWith("@"))
    return "Enter a literal fingerprint, not an @-file reference.";
  if (SIGNING_FINGERPRINT_SHAPE.test(fingerprint))
    return (
      "This looks like a signing fingerprint (43 characters, no prefix), not " +
      "the server's identity fingerprint. A server identity fingerprint starts " +
      "with SHA256: -- ask whoever runs the SFTP server for it."
    );
  return (
    "Enter the server's identity fingerprint in SHA256: form (SHA256: " +
    "followed by 43 characters)."
  );
}

/**
 * Build the `PUT /api/jobs/sftp` body from valid form values, or undefined when
 * the form still has a blocking error (so the caller never submits an invalid
 * request). The credential is a secrets-mount locator, a typed `@path`, or a
 * pasted value (`kind: "raw"`), the last of which the server materializes to a
 * file. A pasted value is sent verbatim (whitespace is significant in a secret),
 * never trimmed.
 *
 * The remote directory travels in ONE of its two forms and never both: a named
 * outbound directory makes the request a split pair (`inbound_path`/
 * `outbound_path`, the remote-directory field supplying the inbound half, which
 * is the same mapping the CLI's `--outbound-path` applies), and a blank one
 * makes it the single shared `path`.
 *
 * A set companion -- the key passphrase, keyboard-interactive -- travels on the
 * value alone, not on the sign-in method beside it: the combination is already
 * coherent by the time this runs, so there is no method test here that could
 * quietly drop one the operator set.
 */
export function buildAuthoringRequest(
  values: SftpConnectionFormValues,
  retainFiles: boolean,
  directExchange = false,
): AuthoredSftpConnectionRequest | undefined {
  if (sftpFormError(values, retainFiles, directExchange) !== undefined)
    return undefined;
  const source = values.source;
  // sftpFormError guarantees a defined source; narrow for the type system.
  if (source === undefined) return undefined;
  const port = values.port.trim();
  const remoteDirectory = values.remoteDirectory.trim();
  const outboundDirectory = values.outboundDirectory.trim();
  const passphrase = values.passphrasePath.trim();
  const fingerprints = hostKeyFingerprintEntries(values.hostKeyFingerprint);
  return {
    host: values.host.trim(),
    ...(port !== "" ? { port: Number(port) } : {}),
    username: values.username.trim(),
    ...(remoteDirectory === ""
      ? {}
      : outboundDirectory === ""
        ? { path: remoteDirectory }
        : { inboundPath: remoteDirectory, outboundPath: outboundDirectory }),
    hostKeyFingerprint:
      fingerprints.length === 1 ? fingerprints[0] : fingerprints,
    credential:
      source.kind === "mount"
        ? {
            kind: "mountRef",
            mount: source.mount,
            subPath: source.subPath,
            credType: values.method,
          }
        : source.kind === "path"
          ? { kind: "ref", ref: source.ref.trim(), credType: values.method }
          : { kind: "raw", value: source.value, credType: values.method },
    ...(passphrase !== "" ? { privateKeyPassphrase: passphrase } : {}),
    ...(values.keyboardInteractive ? { keyboardInteractive: true } : {}),
  };
}
