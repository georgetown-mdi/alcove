import {
  COORDINATION_SERVER_CHANGED_REFUSAL,
  MOUNTED_KEY_FILE_ABSENT_REFUSAL,
  MOUNTED_KEY_FILE_INVALID_REFUSAL,
  MOUNTED_KEY_FILE_NEWER_REFUSAL,
  MOUNTED_SIGNING_IDENTITY_MISMATCH_REFUSAL,
  MOUNTED_SIGNING_PATHS_UNCONVERTED_REFUSAL,
  OPENED_CONFIGURATION_NOT_RUNNABLE_REFUSAL,
  SFTP_CREDENTIAL_CONSOLE_FILE_REFUSAL,
  SFTP_FINGERPRINT_LIST_REFUSAL,
  SFTP_URL_DIRECTORY_REFUSAL,
  SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL,
  WORKING_FOLDER_CONFIGURATION_PRESENT_REFUSAL,
  WORKING_FOLDER_CONSOLE_EXCHANGE_REFUSAL,
  WORKING_FOLDER_UNWRITABLE_REFUSAL,
} from "@jobContract/jobCreateRefusal";
import {
  ConsoleShuttingDownError,
  ExchangeBusyError,
  JobIntentUncomposableError,
  JobRendezvousRetainRequiredError,
  JobRendezvousUnavailableError,
  JobSftpCredentialConsoleOwnedError,
  JobSigningIdentityExposedError,
  MountedSigningIdentityMismatchError,
  MountedSigningPathsUnconvertedError,
  OpenedConfigurationNotRunnableError,
  SftpUnavailableError,
  SignalingServerChangedError,
  SignalingServerUnavailableError,
} from "@jobs/jobManager";
import {
  MAX_JOB_BODY_BYTES,
  gateJobRoute,
  readJobRequestBody,
} from "@jobs/routeSupport";
import {
  ZeroSetupFingerprintListError,
  ZeroSetupRemoteDirectoryError,
} from "@jobs/intentArgv";
import { jobEmptyResponse, jobJsonResponse } from "@jobs/gate";
import { JobInputNotFoundError } from "@jobs/workInputs";
import { MountedKeyFileRefusedError } from "@jobs/mountedKeyFile";
import { SigningIdentityLocationError } from "@jobs/signingIdentity";
import { WorkingFolderFilesRefusedError } from "@jobs/workingFolderExchangeFiles";
import { jobCreateIntentSchema } from "@jobContract/intentSchemas";

import { defineJobRoute } from "../jobRoute";

import type { JobCreateRefusalReason } from "@jobContract/jobCreateRefusal";
import type { MountedKeyFileFault } from "@jobs/mountedKeyFile";

const MOUNTED_KEY_FILE_REFUSALS: Record<
  MountedKeyFileFault,
  JobCreateRefusalReason
> = {
  absent: MOUNTED_KEY_FILE_ABSENT_REFUSAL,
  invalid: MOUNTED_KEY_FILE_INVALID_REFUSAL,
  newer: MOUNTED_KEY_FILE_NEWER_REFUSAL,
};

/** A create rejection naming its refusal with a token and nothing else. */
function refusalResponse(
  reason: JobCreateRefusalReason,
  status = 400,
): Response {
  return jobJsonResponse({ reason }, status);
}

/** One row of {@link CREATE_ERROR_RESPONSES}: the answer to an error of
 * `errorClass`, or undefined for any other error. */
type CreateErrorResponse = (error: unknown) => Response | undefined;

function answering<TError extends Error>(
  errorClass: abstract new (...args: Array<never>) => TError,
  respond: (error: TError) => Response,
): CreateErrorResponse {
  return (error) => (error instanceof errorClass ? respond(error) : undefined);
}

/** The answer to each error a create can throw, the first matching row
 * answering; an error no row matches is the empty 500. */
const CREATE_ERROR_RESPONSES: ReadonlyArray<CreateErrorResponse> = [
  // The single slot is occupied: return its occupant's id (only) so the
  // browser can re-attach to the running exchange.
  answering(ExchangeBusyError, (error) =>
    jobJsonResponse({ id: error.activeJobId }, 409),
  ),
  answering(ConsoleShuttingDownError, () => jobEmptyResponse(503)),
  answering(JobSigningIdentityExposedError, () =>
    refusalResponse(SIGNING_IDENTITY_IN_RENDEZVOUS_REFUSAL),
  ),
  // A direct sftp run cannot pass on the saved connection's several host-key
  // fingerprints; the fix is in the saved connection, which the intent does
  // not state, so the body names the refusal.
  answering(ZeroSetupFingerprintListError, () =>
    refusalResponse(SFTP_FINGERPRINT_LIST_REFUSAL),
  ),
  answering(ZeroSetupRemoteDirectoryError, () =>
    refusalResponse(SFTP_URL_DIRECTORY_REFUSAL),
  ),
  answering(JobSftpCredentialConsoleOwnedError, () =>
    refusalResponse(SFTP_CREDENTIAL_CONSOLE_FILE_REFUSAL),
  ),
  // The key file beside the opened configuration is missing, is not a key
  // file, or a newer Alcove wrote it. The token says which, and nothing read
  // from the file.
  answering(MountedKeyFileRefusedError, (error) =>
    refusalResponse(MOUNTED_KEY_FILE_REFUSALS[error.fault]),
  ),
  // A signed run of the opened configuration whose own signing paths the
  // operator did not convert to the console's.
  answering(MountedSigningPathsUnconvertedError, () =>
    refusalResponse(MOUNTED_SIGNING_PATHS_UNCONVERTED_REFUSAL),
  ),
  // A signed run in place of a file signing with another identity than the
  // console's.
  answering(MountedSigningIdentityMismatchError, () =>
    refusalResponse(MOUNTED_SIGNING_IDENTITY_MISMATCH_REFUSAL),
  ),
  answering(OpenedConfigurationNotRunnableError, () =>
    refusalResponse(OPENED_CONFIGURATION_NOT_RUNNABLE_REFUSAL),
  ),
  // The working folder already holds an alcove.yaml or .alcove.key a webrtc
  // run would write when it starts: the token says whether they are the pair
  // an earlier exchange on this console left. A folder that refused the write
  // is a server-side 500, named so the operator is sent to the mount.
  answering(WorkingFolderFilesRefusedError, (error) =>
    error.fault === "present"
      ? refusalResponse(
          error.heldByConsoleExchange
            ? WORKING_FOLDER_CONSOLE_EXCHANGE_REFUSAL
            : WORKING_FOLDER_CONFIGURATION_PRESENT_REFUSAL,
        )
      : refusalResponse(WORKING_FOLDER_UNWRITABLE_REFUSAL, 500),
  ),
  // The invitation names a coordination server other than the one the
  // console holds, which a later change on another tab or a restart replaced
  // or forgot.
  answering(SignalingServerChangedError, () =>
    refusalResponse(COORDINATION_SERVER_CHANGED_REFUSAL),
  ),
  // Core refused the configuration or hand-off composed from the intent; the
  // body names the composed field and the rule it broke.
  answering(JobIntentUncomposableError, (error) =>
    jobJsonResponse({ error: error.detail }, 400),
  ),
  // A mounted input that names no regular file, a filedrop intent with no
  // rendezvous directory configured, a filedrop intent on a split-provisioned
  // console without retain mode, an sftp intent with no connection authored,
  // a webrtc intent with no coordination server authored, or a signing
  // identity location that names nothing in the secrets mount is a 400 (the
  // manager left no workdir behind).
  answering(JobInputNotFoundError, () => jobEmptyResponse(400)),
  answering(JobRendezvousUnavailableError, () => jobEmptyResponse(400)),
  answering(JobRendezvousRetainRequiredError, () => jobEmptyResponse(400)),
  answering(SftpUnavailableError, () => jobEmptyResponse(400)),
  answering(SignalingServerUnavailableError, () => jobEmptyResponse(400)),
  answering(SigningIdentityLocationError, () => jobEmptyResponse(400)),
];

/**
 * `POST /api/jobs` -- create and start an exchange job from a typed intent.
 *
 * Feature-gated. The request body is a JSON {@link JobCreateIntent},
 * discriminated on `mode` (a missing `mode` defaults to `exchange` for the
 * merged client), then on `channel` (filedrop | sftp, and webrtc on an
 * exchange): an `exchange` intent contains validated linkage terms, a shared
 * secret, and exactly one input source; a `zeroSetup` intent contains neither
 * terms nor secret (both parties infer terms from their files), only an input
 * source and bounded tuning. The server generates the job id, and for an
 * exchange composes the CLI config and key file (every path a server-chosen
 * name in the workdir; sftp connection material drawn only from the
 * operator-authored connection), while a zero-setup drives the literal
 * positional CLI form with the connection on argv (server URL plus `--server-*`
 * flags) and no config, key, or `--save`. Either way no client string reaches
 * argv or a file path.
 *
 * The console facilitates one exchange at a time: while an exchange occupies the
 * single slot, a second create is a 409 containing `{ id }` -- the occupying
 * exchange's id -- until the current exchange is deleted. The browser re-attaches
 * to that id rather than dead-ending on the "already running" alert.
 *
 * The body is read under a byte cap ({@link MAX_JOB_BODY_BYTES}) streamed off the
 * request without trusting `Content-Length`, so an oversized body is a 413 (and
 * an unparseable one a 400) before schema validation runs.
 *
 * The unavailable rejection is EMPTY-bodied: an sftp intent with no connection
 * authored, a webrtc intent with no coordination server authored, a filedrop
 * intent with no rendezvous directory, a filedrop intent
 * a split-provisioned console cannot run without retain mode, and a signing
 * identity location naming nothing in the secrets mount are each 400. The busy
 * rejection is a 409 containing only the occupying exchange's id (nothing else about
 * it), disclosed to the same-origin operator on their own loopback console.
 *
 * Some rejections hold a `{ "reason": "<token>" }` body, each a fixed token
 * and nothing else, no path, no mount name: each is about console state
 * rather than the intent, so the browser cannot otherwise say what to fix.
 * Which error answers which token, and the one on a 500 rather than a 400:
 * docs/spec/SERVER_JOB_API.md, Endpoints, `POST /api/jobs`.
 *
 * A schema-valid intent that core refuses while the CLI configuration or the
 * hand-off is composed from it is a 400 `{ "error": "<field>: <reason>" }`,
 * the field naming the composed configuration's.
 */
export const route = defineJobRoute({
  path: "/api/jobs",
  handlers: {
    POST: async ({ request }) => {
      const gate = gateJobRoute(request);
      if (gate.kind === "response") return gate.response;

      const bodyResult = await readJobRequestBody(request, MAX_JOB_BODY_BYTES);
      if (bodyResult.kind === "too-large") return jobEmptyResponse(413);
      if (bodyResult.kind === "invalid") return jobEmptyResponse(400);

      const parsed = jobCreateIntentSchema.safeParse(bodyResult.value);
      if (!parsed.success) return jobEmptyResponse(400);

      let id: string;
      try {
        id = await gate.manager.createJob(parsed.data);
      } catch (error) {
        for (const respond of CREATE_ERROR_RESPONSES) {
          const response = respond(error);
          if (response !== undefined) return response;
        }
        // Workdir creation or an input write failed (the manager has already
        // cleaned up); no internal detail crosses the boundary.
        return jobEmptyResponse(500);
      }
      return jobJsonResponse({ id }, 201);
    },
  },
});
