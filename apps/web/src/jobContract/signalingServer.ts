/**
 * The coordination server a console webrtc job dials, as `GET` and `PUT
 * /api/jobs/webrtc` report it. Nothing in it is a credential. Contract:
 * docs/spec/SERVER_JOB_API.md, "The coordination server".
 */
export interface SignalingServerProjection {
  host: string;
  /** Absent for the scheme's default port. */
  port?: number;
  /** The server's mount, ending in `/`. */
  path: string;
  /** Whether the run dials it over `wss:`. */
  secure: boolean;
  /** The web app whose published file named the server, when the operator
   * gave the web app's address rather than the server's. */
  webAppOrigin?: string;
  /** Advisories about the address, each shown to the operator as written. */
  warnings: Array<string>;
}
