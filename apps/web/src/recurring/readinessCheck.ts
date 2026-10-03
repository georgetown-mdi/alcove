import {
  HandlePermissionError,
  ManagedInputFileMissingError,
  ensureHandlePermission,
  inputFileHandleIn,
} from "@psi/managed/managedInputHandle";
import {
  storedWorkingDirectoryUsable,
  workingDirectoryGrantSupported,
} from "@psi/managed/managedWorkingDirectory";
import { isInstalledRuntime } from "@utils/installedRuntime";
import { isOnline } from "@utils/networkStatus";
import { ownSignalingAddress } from "@psi/transport/signalingAddress";

import type {
  FolderReadiness,
  ReadinessReport,
  SignalingReadiness,
} from "./keepRunningModel";
import type { HandlePermissionQuery } from "@psi/managed/managedInputHandle";
import type { SignalingAddress } from "@psi/transport/signalingAddress";

/**
 * The readiness check a scheduled exchange's page offers: the checks the
 * unattended runner's next window depends on, made now without starting a
 * run: it takes no secret and writes no record, and its signaling probe names
 * no peer id.
 */

/** How long the signaling server has to accept the probe's connection. */
export const SIGNALING_PROBE_TIMEOUT_MS = 10_000;

/** The WebSocket address the PeerJS client dials for `address`. */
export function signalingSocketUrl(address: SignalingAddress): string {
  const scheme = address.secure ? "wss" : "ws";
  const port = address.port ?? (address.secure ? 443 : 80);
  return `${scheme}://${address.host}:${String(port)}${address.path}peerjs`;
}

/** The part of a WebSocket the probe uses. */
interface ProbeSocket {
  addEventListener: (
    type: "open" | "error" | "close",
    listener: () => void,
  ) => void;
  close: () => void;
}

/**
 * Whether the signaling server at `address` accepts a connection within
 * `timeoutMs`. The connection names no peer id, so the server refuses it
 * without registering anything; the accepted connection is the answer.
 */
export function probeSignalingServer(
  address: SignalingAddress,
  options: {
    timeoutMs?: number;
    createSocket?: (url: string) => ProbeSocket;
  } = {},
): Promise<boolean> {
  const createSocket =
    options.createSocket ?? ((url: string) => new WebSocket(url));
  return new Promise((resolve) => {
    let socket: ProbeSocket;
    try {
      socket = createSocket(signalingSocketUrl(address));
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (answered: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.close();
      resolve(answered);
    };
    const timer = setTimeout(
      () => settle(false),
      options.timeoutMs ?? SIGNALING_PROBE_TIMEOUT_MS,
    );
    socket.addEventListener("open", () => settle(true));
    socket.addEventListener("error", () => settle(false));
    socket.addEventListener("close", () => settle(false));
  });
}

/**
 * What the next unattended run would find in the exchange's folder: the
 * permission queried without prompting, as the unattended run queries it, and
 * the input file looked up by name without being read.
 */
export async function checkWorkingFolder(
  handle: FileSystemDirectoryHandle | undefined,
  permission?: HandlePermissionQuery,
): Promise<FolderReadiness> {
  if (!workingDirectoryGrantSupported()) return "unsupported";
  if (handle === undefined || !storedWorkingDirectoryUsable(handle))
    return "none";
  try {
    await ensureHandlePermission(handle, "unattended", "read", permission);
  } catch (error) {
    return error instanceof HandlePermissionError ? "notGranted" : "unreadable";
  }
  try {
    await inputFileHandleIn(handle);
    return "ready";
  } catch (error) {
    return error instanceof ManagedInputFileMissingError
      ? "inputMissing"
      : "unreadable";
  }
}

/** The platform readings {@link runReadinessCheck} makes, injectable for
 * tests. */
export interface ReadinessCheckDependencies {
  isInstalledRuntime: () => boolean;
  isOnline: () => boolean;
  probeSignalingServer: () => Promise<boolean>;
  checkWorkingFolder: (
    handle: FileSystemDirectoryHandle | undefined,
  ) => Promise<FolderReadiness>;
}

/** The real platform readings. */
export const browserReadinessCheck: ReadinessCheckDependencies = {
  isInstalledRuntime,
  isOnline,
  probeSignalingServer: () => {
    let address: SignalingAddress;
    try {
      address = ownSignalingAddress();
    } catch {
      return Promise.resolve(false);
    }
    return probeSignalingServer(address);
  },
  checkWorkingFolder: (handle) => checkWorkingFolder(handle),
};

/** Run every readiness check for an exchange whose folder is `handle`. */
export async function runReadinessCheck(
  handle: FileSystemDirectoryHandle | undefined,
  dependencies: ReadinessCheckDependencies = browserReadinessCheck,
): Promise<ReadinessReport> {
  const signaling: Promise<SignalingReadiness> = dependencies.isOnline()
    ? dependencies
        .probeSignalingServer()
        .then((answered) => (answered ? "answered" : "noAnswer"))
    : Promise.resolve("offline");
  const [folder, signalingResult] = await Promise.all([
    dependencies.checkWorkingFolder(handle),
    signaling,
  ]);
  return {
    installedRuntime: dependencies.isInstalledRuntime(),
    folder,
    signaling: signalingResult,
  };
}
