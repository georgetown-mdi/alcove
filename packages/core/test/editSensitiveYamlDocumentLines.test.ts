import { expect, test } from "vitest";
import YAML, { type Document } from "yaml";

import { removeUnsetPayloadReceiveNote } from "../src/config/exchangeDocument";
import { editSensitiveYamlDocument } from "../src/sensitiveFile";

// Every line an edit does not change keeps its bytes; docs/CLI.md,
// Configuration, states the exceptions pinned at the end of this file.

const LABEL = "config file /tmp/alcove.yaml";

// Formatting the yaml writer changes on a plain round trip: flow-collection
// spacing, comment padding, sequence and mapping indentation, folded-scalar
// line breaks, repeated blank lines, and number case.
const SOURCE = `# header comment

version: 1   # padded trailing
connection:   # how we connect
  channel: sftp     # two-space pad
  server: {host: example.org,  port: 22}
  tags: [a,b,  c]
  long: >-
    folded text
    here
list:
- one
- two   # c
nested:
    deep:   value
hex: 0x1F
linkage_terms:
  payload:
    send: [x,  y]   # outbound


trailer: end  #tight
`;

function edit(source: string, change: (doc: Document) => void): string {
  return editSensitiveYamlDocument(source, LABEL, change);
}

/** What the yaml writer alone renders for the edited source. */
function writerOutput(source: string, change: (doc: Document) => void): string {
  const doc = YAML.parseDocument(source);
  change(doc);
  return doc.toString();
}

test("the fixture holds formatting the yaml writer rewrites", () => {
  expect(YAML.parseDocument(SOURCE).toString()).not.toBe(SOURCE);
});

test("an edit that changes nothing returns the source byte for byte", () => {
  expect(edit(SOURCE, () => {})).toBe(SOURCE);
});

test("adding a key keeps every other line byte for byte", () => {
  expect(
    edit(SOURCE, (doc) => {
      doc.setIn(["linkage_terms", "payload", "receive"], ["z"]);
    }),
  ).toBe(
    SOURCE.replace(
      "    send: [x,  y]   # outbound\n",
      "    send: [x,  y]   # outbound\n    receive:\n      - z\n",
    ),
  );
});

test("changing a value rewrites that line only", () => {
  expect(
    edit(SOURCE, (doc) => {
      doc.setIn(["connection", "channel"], "webrtc");
    }),
  ).toBe(
    SOURCE.replace(
      "  channel: sftp     # two-space pad\n",
      "  channel: webrtc # two-space pad\n",
    ),
  );
});

test("changing a flow-map entry rewrites that flow map's line only", () => {
  expect(
    edit(SOURCE, (doc) => {
      doc.setIn(["connection", "server", "port"], 2222);
    }),
  ).toBe(
    SOURCE.replace(
      "  server: {host: example.org,  port: 22}\n",
      "  server: { host: example.org, port: 2222 }\n",
    ),
  );
});

test("deleting a key removes its lines only", () => {
  expect(
    edit(SOURCE, (doc) => {
      doc.deleteIn(["nested"]);
    }),
  ).toBe(SOURCE.replace("nested:\n    deep:   value\n", ""));
});

test("filling payload.receive drops the unset note and keeps every other line", () => {
  const note = [
    "    # receive is not set: the first exchange sets it to the payload columns your",
    "    # partner declares it sends, and later exchanges refuse a partner that sends",
    "    # a different list. Write receive: [] to receive none.",
  ].join("\n");
  const source = [
    "connection:",
    "  channel: sftp     # padded",
    "  server: {host: example.org,  port: 22}",
    "linkage_terms:",
    "  version: 1.0.0   # padded",
    "  payload:",
    "    send: [{name: x},  {name: y}]",
    note,
    "  deduplicate: {left: true,  right: false}",
    "",
  ].join("\n");
  expect(
    edit(source, (doc) => {
      doc.setIn(
        ["linkage_terms", "payload", "receive"],
        doc.createNode([{ name: "z" }]),
      );
      removeUnsetPayloadReceiveNote(doc);
    }),
  ).toBe(source.replace(`${note}\n`, "    receive:\n      - name: z\n"));
});

test("added lines take the indentation of the lines around them", () => {
  const fourSpaces = [
    "connection:",
    "    channel: sftp   # created on demand",
    "    server:",
    "        provision: {url: https://provision.example.org,  mode: create}",
    "        username: alcove   # service account",
    "linkage_terms:",
    "    payload:",
    "        send:",
    "        - name: x",
    "",
  ].join("\n");
  expect(
    edit(fourSpaces, (doc) => {
      doc.setIn(["connection", "server", "host"], "sftp.example.org");
      doc.setIn(["connection", "server", "port"], 2222);
      doc.setIn(
        ["linkage_terms", "payload", "receive"],
        doc.createNode([{ name: "z" }]),
      );
    }),
  ).toBe(
    fourSpaces
      .replace(
        "        username: alcove   # service account\n",
        "        username: alcove   # service account\n" +
          "        host: sftp.example.org\n" +
          "        port: 2222\n",
      )
      .replace(
        "        - name: x\n",
        "        - name: x\n        receive:\n        - name: z\n",
      ),
  );
});

test("CRLF line breaks are kept", () => {
  const crlf = SOURCE.replaceAll("\n", "\r\n");
  expect(
    edit(crlf, (doc) => {
      doc.setIn(["linkage_terms", "payload", "receive"], ["z"]);
    }),
  ).toBe(
    crlf.replace(
      "    send: [x,  y]   # outbound\r\n",
      "    send: [x,  y]   # outbound\r\n    receive:\r\n      - z\r\n",
    ),
  );
});

// The exceptions docs/CLI.md states.

test("replacing a value drops the comment on its key's line", () => {
  expect(
    edit(SOURCE, (doc) => {
      doc.setIn(["connection"], doc.createNode({ channel: "webrtc" }));
    }),
  ).toBe(
    SOURCE.replace(
      /connection: {3}# how we connect\n[^]*?\nlist:/,
      "connection:\n  channel: webrtc\nlist:",
    ),
  );
});

test("a change inside a flow collection written across lines rewrites the whole collection", () => {
  const source = "server:\n  opts: {a: 1,\n    b: 2}\nport: 22   # p\n";
  expect(
    edit(source, (doc) => {
      doc.setIn(["server", "opts", "b"], 3);
    }),
  ).toBe("server:\n  opts: { a: 1, b: 3 }\nport: 22   # p\n");
});

test("a neighboring line the writer lays out together with the change is rewritten with it", () => {
  // The writer moves a comment on a key holding a mapping onto its own line,
  // which here joins the key's line to the change below it.
  const source = "server:   # s\n  opts: {a: 1,\n    b: 2}\nport: 22   # p\n";
  expect(
    edit(source, (doc) => {
      doc.setIn(["server", "opts", "b"], 3);
    }),
  ).toBe("server:\n  # s\n  opts: { a: 1, b: 3 }\nport: 22   # p\n");
});

test("a change the file's own layout cannot hold rewrites the whole file", () => {
  // An entry written with extra space after its dash: the changed first line
  // cannot keep the continuation line under it.
  const source = [
    "send:     # padded",
    "-   name: x",
    "    type: string",
    "keys: {a: 1,  b: 2}",
    "",
  ].join("\n");
  const change = (doc: Document): void => {
    doc.setIn(["send", 0, "name"], "q");
  };
  const output = edit(source, change);
  expect(output).toBe(writerOutput(source, change));
  expect(output).toContain("keys: { a: 1, b: 2 }");
});

test("a file with too many lines the writer restyles is rewritten whole", () => {
  // The writer lowercases a hexadecimal number, a change beyond spacing.
  const lines = (count: number): string =>
    Array.from({ length: count }, (_, index) => `k${index}: 0x1F\n`).join("");
  const change = (doc: Document): void => {
    doc.set("added", true);
  };
  const short = lines(1500);
  expect(edit(short, change)).toBe(`${short}added: true\n`);
  const long = lines(2500);
  expect(edit(long, change)).toBe(writerOutput(long, change));
});
