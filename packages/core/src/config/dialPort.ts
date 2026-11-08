import { z } from "zod";

/**
 * A port a server is dialed on: an integer from 1 to 65535. Port 0 asks the
 * operating system for any free port when listening and names no server when
 * dialing, so it is refused rather than copied into a connection, an
 * invitation endpoint, or a provisioned server's address.
 */
export const DialPortSchema: z.ZodType<number> = z.int().min(1).max(65535);
