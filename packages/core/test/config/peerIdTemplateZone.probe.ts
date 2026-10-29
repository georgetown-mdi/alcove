// Expands a peer_id template in a process started with TZ set, for
// `peerIdTemplate.test.ts`: assigning process.env.TZ in a worker thread, where
// Stryker's runner puts the test, leaves the zone unchanged. Prints one JSON
// line: the local date and hour, to show the zone took effect, and the expansion.
//
// Usage: TZ=<zone> node --import tsx peerIdTemplateZone.probe.ts <template> <epoch ms>

import {
  expandPeerIdTemplate,
  parsePeerIdTemplate,
} from "../../src/config/peerIdTemplate";

const [template = "", epochMs = ""] = process.argv.slice(2);
const nowMs = Number(epochMs);
const parsed = parsePeerIdTemplate(template);
if (!parsed.ok) throw new Error(parsed.problem);
const local = new Date(nowMs);
console.log(
  JSON.stringify({
    local: `${local.getDate()} ${local.getHours()}`,
    expanded: expandPeerIdTemplate(parsed.parts, {
      nowMs: () => nowMs,
      randomHex: () => "0123456789abcdef",
    }),
  }),
);
