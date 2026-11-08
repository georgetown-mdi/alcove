/// <reference types="vite/client" />

import { vi } from "vitest";

import { createElement } from "react";

import {
  encodeInvitation,
  endpointRequiresRetainedFiles,
  generateSharedSecret,
} from "@alcove/core";

import { AcceptorScreen } from "@exchange/AcceptorScreen";
import { DirectExchangeScreen } from "@exchange/DirectExchangeScreen";
import { InviterScreen } from "@exchange/InviterScreen";
import { Lobby } from "@exchange/Lobby";
import { NotFound } from "@components/NotFound";
import { RecoveredExchangePanel } from "@exchange/RecoveredExchangePanel";
import { VerifyReceiptScreen } from "@exchange/VerifyReceiptScreen";

import { acceptToken } from "./routeStates";

import type {
  ConnectionEndpoint,
  InvitationToken,
  LinkageTerms,
} from "@alcove/core";
import type { ReactNode } from "react";
import type { RouteState } from "./routeStates";

// The console profile's states: the console server's job API stubbed at the
// fetch boundary, and the route and card states the console's accessibility
// checks mount over it (the contrast sweep, consoleAccessibility.test.ts, and
// the console keyboard journeys). A suite using these mocks the client config
// to the console profile (consoleClientConfigMock), the router and the
// rendezvous (moduleMocks.ts), and clears the hash, local storage and the
// stubbed globals between states.

/** The one file the console's working folder holds by default. */
export const CLIENTS_FILE = {
  name: "clients.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
};

/** The console's profile of {@link CLIENTS_FILE}. */
export const CLIENTS_PROFILE = {
  ...CLIENTS_FILE,
  rowCount: 2,
  columns: ["client_id", "first_name", "last_name", "dob", "program_code"],
  sanitizedColumnPositions: [],
  dateInputFormats: [],
  columnSamples: [
    { column: "client_id", values: ["1", "2"] },
    { column: "first_name", values: ["Ann", "Bo"] },
    { column: "last_name", values: ["Lee", "Ray"] },
    { column: "dob", values: ["01/02/1990", "03/04/1985"] },
    { column: "program_code", values: ["A", "B"] },
  ],
};

/** An SFTP connection authored on the console. */
export const AUTHORED_SFTP = {
  configured: true,
  host: "sftp.example.gov",
  port: 2222,
};

/** The id the console gives a job the browser creates. */
export const CREATED_JOB_ID = "job-7";

/** What the stubbed console job API answers; each unset field answers as a
 * console with one input file and nothing else set up. */
export interface ConsoleJobApiOptions {
  /** The `GET /api/jobs/inputs` body. */
  inputs?: unknown;
  /** A status `GET /api/jobs/inputs` answers with no body instead: 404 is a
   * console started without a folder, any other a listing that failed. */
  inputsStatus?: number;
  /** The `GET /api/jobs/inputs/profile` body. */
  profile?: unknown;
  /** The connection `GET /api/jobs/sftp` reports. */
  sftp?: unknown;
  /** A status `PUT /api/jobs/sftp` answers with no body; unset, the PUT
   * authors the connection its body names. */
  sftpPutStatus?: number;
  /** The `GET /api/jobs/rendezvous` body. */
  rendezvous?: unknown;
  /** The coordination server `GET /api/jobs/webrtc` reports. */
  webrtc?: unknown;
  /** The server a `PUT /api/jobs/webrtc` sets, reported from then on. */
  webrtcSet?: unknown;
  /** The `GET /api/jobs/config` body, answered with {@link configStatus}. */
  config?: unknown;
  configStatus?: number;
  /** The job the console's single slot holds, and its status. */
  occupant?: { id: string; status: string };
}

/** A request the stubbed job API received. */
export interface CapturedJobRequest {
  url: string;
  method: string;
  body?: string;
}

/** The stubbed job API's handles on the job the browser creates. */
export interface ConsoleJobApi {
  captured: Array<CapturedJobRequest>;
  /** Sends one event down the most recently opened job event stream. */
  emitEvent: (event: object) => void;
  closeEvents: () => void;
  /** Sets the status the created job's status route reports. */
  setJobStatus: (status: string) => void;
  /** Whether the created job's event stream has been opened. */
  createdJobStreaming: () => boolean;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Stubs the console server's job API at the global fetch boundary, answering
 * `options` (see {@link ConsoleJobApiOptions}); any other job route answers
 * 404, and a request outside the job API reaches the real fetch. A job the
 * browser creates is {@link CREATED_JOB_ID}, running until
 * {@link ConsoleJobApi.setJobStatus} says otherwise.
 */
export function stubConsoleJobApi(
  options: ConsoleJobApiOptions = {},
): ConsoleJobApi {
  const captured: Array<CapturedJobRequest> = [];
  const encoder = new TextEncoder();
  const realFetch = window.fetch.bind(window);
  let events: ReadableStreamDefaultController<Uint8Array> | undefined;
  let createdJobStreaming = false;
  let sftp: unknown = options.sftp ?? { configured: false };
  let webrtc: unknown = options.webrtc ?? { configured: false };
  const statuses = new Map<string, string>([[CREATED_JOB_ID, "running"]]);
  if (options.occupant !== undefined)
    statuses.set(options.occupant.id, options.occupant.status);

  function jobAnswer(url: string, method: string): Response | undefined {
    for (const [id, status] of statuses) {
      const base = `/api/jobs/${id}`;
      if (url === `${base}/events`) {
        if (id === CREATED_JOB_ID) createdJobStreaming = true;
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              events = controller;
            },
          }),
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      }
      if (url === `${base}/cancel`) {
        statuses.set(id, "cancelled");
        return new Response(null, { status: 200 });
      }
      if (url === base)
        return method === "DELETE"
          ? new Response(null, { status: 204 })
          : jsonResponse({
              status,
              recordAvailable: false,
              recordUnavailableReason: "no-record",
            });
    }
    return undefined;
  }

  function answer(url: string, method: string, body?: string): Response {
    if (url === "/api/jobs/inputs")
      return options.inputsStatus !== undefined
        ? new Response(null, { status: options.inputsStatus })
        : jsonResponse(
            options.inputs ?? { configured: true, files: [CLIENTS_FILE] },
          );
    if (url.startsWith("/api/jobs/inputs/profile"))
      return jsonResponse(options.profile ?? CLIENTS_PROFILE);
    if (url === "/api/jobs/inputs/coverage") return jsonResponse({ rates: [] });
    if (url === "/api/jobs/sftp") {
      if (method === "PUT") {
        if (options.sftpPutStatus !== undefined)
          return new Response(null, { status: options.sftpPutStatus });
        const authored = JSON.parse(body ?? "{}") as Record<string, unknown>;
        sftp = {
          configured: true,
          host: authored.host,
          ...(authored.port !== undefined ? { port: authored.port } : {}),
          ...(authored.path !== undefined ? { path: authored.path } : {}),
        };
        return jsonResponse(sftp);
      }
      if (method === "DELETE") {
        sftp = { configured: false };
        return new Response(null, { status: 204 });
      }
      return jsonResponse(sftp);
    }
    if (url === "/api/jobs/rendezvous")
      return jsonResponse(options.rendezvous ?? { configured: false });
    if (url === "/api/jobs/webrtc") {
      if (method === "PUT") webrtc = options.webrtcSet ?? { configured: false };
      if (method === "DELETE") webrtc = { configured: false };
      return jsonResponse(webrtc);
    }
    if (url === "/api/jobs/slot")
      return jsonResponse(
        options.occupant !== undefined
          ? { occupied: true, id: options.occupant.id }
          : { occupied: false },
      );
    if (url === "/api/jobs/config" && method === "GET")
      return jsonResponse(
        options.config ?? {
          configured: true,
          present: false,
          carriedThrough: [],
          warnings: [],
        },
        options.configStatus ?? 200,
      );
    if (url.startsWith("/api/jobs/mounts/"))
      return jsonResponse({ configured: true, readable: true, entries: [] });
    if (url === "/api/jobs" && method === "POST")
      return jsonResponse({ id: CREATED_JOB_ID }, 201);
    return jobAnswer(url, method) ?? new Response(null, { status: 404 });
  }

  vi.stubGlobal(
    "fetch",
    (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      if (!url.startsWith("/api/jobs")) return realFetch(input, init);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      captured.push({ url, method, body });
      return Promise.resolve(answer(url, method, body));
    },
  );

  return {
    captured,
    emitEvent: (event) =>
      events?.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)),
    closeEvents: () => events?.close(),
    setJobStatus: (status) => statuses.set(CREATED_JOB_ID, status),
    createdJobStreaming: () => createdJobStreaming,
  };
}

/** The terms an SFTP invitation to the console proposes. */
const SFTP_INVITATION_TERMS: LinkageTerms = {
  version: "1.0.0",
  identity: "County Health Department",
  date: "2026-01-01",
  algorithm: "psi",
  linkageStrategy: "cascade",
  output: { expectsOutput: false, shareWithPartner: true },
  deduplicate: false,
  linkageFields: [
    { name: "firstName", type: "first_name" },
    { name: "lastName", type: "last_name" },
  ],
  linkageKeys: [
    { name: "first", elements: [{ field: "firstName" }] },
    { name: "last", elements: [{ field: "lastName" }] },
  ],
};

/** The partner's SFTP server an SFTP invitation names. */
export const PARTNER_SFTP_ENDPOINT: ConnectionEndpoint = {
  channel: "sftp",
  host: "sftp.partner.example",
  port: 2022,
  path: "/drop",
};

/** A ready invitation to exchange over {@link PARTNER_SFTP_ENDPOINT}. */
export async function sftpAcceptToken(): Promise<string> {
  const token: InvitationToken = {
    version: "1",
    linkageTerms: SFTP_INVITATION_TERMS,
    sharedSecret: generateSharedSecret(),
    expires: new Date(Date.now() + 3600 * 1000).toISOString(),
    connectionEndpoint: PARTNER_SFTP_ENDPOINT,
    ...(endpointRequiresRetainedFiles(PARTNER_SFTP_ENDPOINT)
      ? { inviterRetainsFiles: true }
      : {}),
  };
  return encodeInvitation(token);
}

/** The acceptor's input file, whose columns match the SFTP invitation's
 * fields. */
export const COHORT_FILE = {
  name: "cohort.csv",
  sizeBytes: 4096,
  modifiedAt: 1_700_000_000_000,
};

/** The console's profile of {@link COHORT_FILE}. */
export const COHORT_PROFILE = {
  ...COHORT_FILE,
  rowCount: 2,
  columns: ["first_name", "last_name"],
  sanitizedColumnPositions: [],
  dateInputFormats: [],
  columnSamples: [
    { column: "first_name", values: ["Ann", "Bo"] },
    { column: "last_name", values: ["Lee", "Ray"] },
  ],
};

/** A console state: a route state mounted over the stubbed job API. */
export interface ConsoleState extends RouteState {
  /** What the job API answers in this state; unset, the defaults. */
  jobApi?: ConsoleJobApiOptions;
  /** Text the state shows once its cards have read the job API. */
  settled?: string;
}

/** Every declared route's landing state on the console profile. The `/saved`
 * routes redirect on the console, so they have no state here. */
export const CONSOLE_ROUTE_STATES: ReadonlyArray<ConsoleState> = [
  {
    route: "/",
    state: "no exchange running",
    heading: /./,
    node: () =>
      Promise.resolve(
        createElement(
          "div",
          null,
          createElement(RecoveredExchangePanel),
          createElement(Lobby),
        ),
      ),
  },
  {
    route: "/quick",
    state: "landing",
    heading: /./,
    node: () => Promise.resolve(createElement(Lobby)),
  },
  {
    route: "/exchange",
    state: "first step",
    heading: "Your file",
    settled: "Choose a file from your folder",
    node: () => Promise.resolve(createElement(InviterScreen)),
  },
  {
    route: "/accept",
    state: "terms review",
    heading: /County Health Department/,
    node: async () => {
      window.location.hash = await acceptToken();
      return createElement(AcceptorScreen);
    },
  },
  {
    route: "/accept",
    state: "an invitation that cannot be read",
    heading: "Accept an invitation",
    node: () => {
      window.location.hash = "not-an-invitation";
      return Promise.resolve(createElement(AcceptorScreen));
    },
  },
  {
    route: "/verify",
    state: "nothing loaded",
    heading: "Verify an exchange record",
    node: () => Promise.resolve(createElement(VerifyReceiptScreen)),
  },
  {
    route: "/direct",
    state: "landing",
    heading: /./,
    settled: "Choose a file from your folder",
    node: () => Promise.resolve(createElement(DirectExchangeScreen)),
  },
  {
    route: "(not found)",
    state: "an address no route matches",
    heading: "Page not found",
    node: () => Promise.resolve(createElement(NotFound)),
  },
];

function inviterScreen(): Promise<ReactNode> {
  return Promise.resolve(createElement(InviterScreen));
}

/** The console's own cards in the empty, error and running states a page
 * lands in from what the console answers, with no input from the operator.
 * The states only input reaches are the console keyboard journeys'. */
export const CONSOLE_CARD_STATES: ReadonlyArray<ConsoleState> = [
  {
    route: "/exchange",
    state: "the working folder holds no usable files",
    heading: "Your file",
    jobApi: { inputs: { configured: true, files: [] } },
    settled: "No usable files in your folder",
    node: inviterScreen,
  },
  {
    route: "/exchange",
    state: "no input folder is configured",
    heading: "Your file",
    jobApi: { inputs: { configured: false, files: [] } },
    settled: "No input folder configured",
    node: inviterScreen,
  },
  {
    route: "/exchange",
    state: "the working folder cannot be read",
    heading: "Your file",
    jobApi: { inputs: { configured: true, readable: false, files: [] } },
    settled: "Could not read your folder",
    node: inviterScreen,
  },
  {
    route: "/exchange",
    state: "the file listing failed",
    heading: "Your file",
    jobApi: { inputsStatus: 500 },
    settled: "Could not list your folder",
    node: inviterScreen,
  },
  {
    route: "/exchange",
    state: "the console was started without a folder",
    heading: "Your file",
    jobApi: { inputsStatus: 404 },
    settled: "This console was started without a folder",
    node: inviterScreen,
  },
  {
    route: "/exchange",
    state: "an exchange from an earlier visit still running",
    heading: "Your file",
    jobApi: { occupant: { id: "job-live", status: "running" } },
    settled: "An exchange started from this console is still running",
    node: inviterScreen,
  },
  {
    route: "/exchange",
    state: "an exchange from an earlier visit finished",
    heading: "Your file",
    jobApi: { occupant: { id: "job-live", status: "succeeded" } },
    settled: "An exchange started from this console has finished",
    node: inviterScreen,
  },
  {
    route: "/exchange",
    state: "an exchange from an earlier visit stopped",
    heading: "Your file",
    jobApi: { occupant: { id: "job-live", status: "failed" } },
    settled: "An exchange started from this console stopped",
    node: inviterScreen,
  },
  {
    route: "/accept",
    state: "terms review of an invitation over the partner's SFTP server",
    heading: /County Health Department/,
    jobApi: { inputs: { configured: true, files: [COHORT_FILE] } },
    node: async () => {
      window.location.hash = await sftpAcceptToken();
      return createElement(AcceptorScreen);
    },
  },
];
