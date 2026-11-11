import { z } from "zod";

// Every page and worker entry imports this module first. Zod builds generated
// functions with `new Function`, and probes for that the moment a module builds
// an object schema, so jitless has to be on before any such module runs; the
// script policy admits no 'unsafe-eval', and a refused probe is still reported.
z.config({ jitless: true });
