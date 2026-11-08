// The rules the connection block, the invitation and the terms update share
// through one definition each: every site that applies a rule admits and
// refuses the same inputs, in its own wording.
import { describe, expect, test } from "vitest";

import * as core from "../../src/main";
import {
  MAX_RELAY_LOCATOR_URL_LENGTH,
  MAX_RELAY_REGISTRAR_URL_LENGTH,
  RelayRegistrarSchema,
  safeParseConnectionConfig,
} from "../../src/config/connection";
import { DialPortSchema } from "../../src/config/dialPort";
import type { FormatVersionPolicy } from "../../src/config/formatVersion";
import {
  decodeInvitation,
  WebRTCEndpointSchema,
} from "../../src/config/invitation";
import { SftpPortSchema } from "../../src/config/sftpUrl";
import {
  decodeTermsUpdate,
  encodeTermsUpdate,
  TermsUpdateRefusedError,
} from "../../src/config/termsUpdate";
import { getDefaultLinkageTerms } from "../../src/defaults/builtInLinkageTerms";
import { defaultStepsForType } from "../../src/defaults/builtInStandardization";
import { DEFAULT_DATE_INPUT_FORMAT } from "../../src/standardization";
import { SEMANTIC_TYPES } from "../../src/types";
import {
  fromBase64Url,
  hkdfDerive,
  hmacSha256,
  toBase64Url,
} from "../../src/utils/crypto";
import { encodeRawInvitation } from "../utils/support";

const SECRET = "A".repeat(43);
const terms = getDefaultLinkageTerms("Agency A");
const token = { version: "1", linkageTerms: terms, sharedSecret: SECRET };

async function invitationRefusal(raw: unknown): Promise<unknown> {
  try {
    await decodeInvitation(await encodeRawInvitation(raw));
  } catch (err) {
    return err;
  }
  return undefined;
}

async function authenticated(content: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(content));
  const macKey = await hkdfDerive(
    fromBase64Url(SECRET),
    "alcove-terms-update-v2:mac",
    32,
  );
  return `${toBase64Url(bytes)}.${toBase64Url(await hmacSha256(macKey, bytes))}`;
}

async function termsUpdateBody(): Promise<Record<string, unknown>> {
  const encoded = await encodeTermsUpdate({ linkageTerms: terms }, SECRET);
  return JSON.parse(
    new TextDecoder().decode(fromBase64Url(encoded.split(".")[0] as string)),
  ) as Record<string, unknown>;
}

describe("the file-sync directory rules", () => {
  const shapes: Record<string, Record<string, string>> = {
    none: {},
    path: { path: "/srv/x" },
    inboundOnly: { inbound_path: "/srv/in" },
    outboundOnly: { outbound_path: "/srv/out" },
    pair: { inbound_path: "/srv/in", outbound_path: "/srv/out" },
    pairOneDirectory: { inbound_path: "/srv/in", outbound_path: "/srv//in/" },
    pathAndInbound: { path: "/srv/x", inbound_path: "/srv/in" },
    pathAndPair: {
      path: "/srv/x",
      inbound_path: "/srv/in",
      outbound_path: "/srv/out",
    },
  };
  const camel = (dirs: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(dirs).map(([key, value]) => [
        key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
        value,
      ]),
    );
  const retained = {
    retain_files: true,
    timestamp_in_filename: true,
    lockless_rendezvous: true,
  };

  test.each(
    Object.keys(shapes).flatMap((shape) =>
      (["sftp", "filedrop"] as const).map((channel) => [channel, shape]),
    ),
  )(
    "a %s connection block and invitation endpoint agree on %s",
    async (channel, shape) => {
      const dirs = shapes[shape] as Record<string, string>;
      const connection =
        channel === "sftp"
          ? {
              channel,
              server: { host: "s.example.org", username: "u", ...dirs },
              options: retained,
            }
          : { channel, ...dirs, options: retained };
      const endpoint =
        channel === "sftp"
          ? { channel, host: "s.example.org", ...camel(dirs) }
          : { channel, ...camel(dirs) };
      const connectionAdmits = safeParseConnectionConfig(connection).success;
      const endpointRefusal = await invitationRefusal({
        ...token,
        connectionEndpoint: endpoint,
      });
      expect(endpointRefusal === undefined).toBe(connectionAdmits);
    },
  );
});

describe("the registrar url grammar", () => {
  const urls = [
    "https://registrar.example.org",
    "https://Registrar.Example.ORG:443/",
    "  https://registrar.example.org:8443  ",
    "https://registrar.example.org:0",
    "http://registrar.example.org",
    "https://user@registrar.example.org",
    "https://registrar.example.org/path",
    "https://registrar.example.org/?",
    "not a url",
    `https://${"a".repeat(1100)}.org`,
  ];

  test("both registrar fields share one length bound", () => {
    expect(MAX_RELAY_LOCATOR_URL_LENGTH).toBe(MAX_RELAY_REGISTRAR_URL_LENGTH);
  });

  test.each(urls)(
    "relay_registrar.url and a relay locator's registrar read %j alike",
    (url) => {
      const own = RelayRegistrarSchema.safeParse({ url, exchangeId: "abc" });
      const locator = safeParseConnectionConfig({
        channel: "webrtc",
        server: { host: "signal.example" },
        invitation_relay: { turn: ["turn:relay.example.org"], registrar: url },
      });
      expect(locator.success).toBe(own.success);
      if (own.success && locator.success && locator.data.channel === "webrtc")
        expect(locator.data.invitationRelay?.registrar).toBe(own.data.url);
      const problems = (
        issues: ReadonlyArray<{ message: string }> | undefined,
        name: string,
      ) =>
        (issues ?? []).map((issue) => {
          expect(issue.message.startsWith(`${name} `)).toBe(true);
          return issue.message.slice(name.length);
        });
      expect(
        problems(locator.error?.issues, "a relay locator's registrar"),
      ).toEqual(problems(own.error?.issues, "relay_registrar.url"));
    },
  );
});

describe("the dial port", () => {
  const ports: unknown[] = [0, 1, 22, 65535, 65536, -1, 1.5, "22"];

  test("the SFTP port is the dial port", () => {
    expect(SftpPortSchema).toBe(DialPortSchema);
  });

  test.each(ports)("every dial-port site reads %j alike", async (port) => {
    const admitted = DialPortSchema.safeParse(port).success;
    expect(
      WebRTCEndpointSchema.safeParse({ channel: "webrtc", host: "h", port })
        .success,
    ).toBe(admitted);
    expect(
      (await invitationRefusal({
        ...token,
        connectionEndpoint: { channel: "sftp", host: "s.example.org", port },
      })) === undefined,
    ).toBe(admitted);
    expect(
      safeParseConnectionConfig({
        channel: "sftp",
        server: { host: "s.example.org", username: "u", port },
      }).success,
    ).toBe(admitted);
    expect(
      safeParseConnectionConfig({
        channel: "webrtc",
        server: {
          host: "signal.example",
          provision: { mode: "start", host: "p.example.org", port },
        },
      }).success,
    ).toBe(admitted);
  });

  test("the webrtc server port still admits 0", () => {
    expect(
      safeParseConnectionConfig({
        channel: "webrtc",
        server: { host: "signal.example", port: 0 },
      }).success,
    ).toBe(true);
  });
});

describe("the format version text", () => {
  test.each(["0", "01", "1.0", " 1", "1 ", "+1", "1000000000", "１"])(
    "the invitation and the terms update both refuse version %j as unreadable",
    async (version) => {
      const invitation = await invitationRefusal({ ...token, version });
      expect(invitation).toBeDefined();
      expect(
        (invitation as { issues?: unknown[] }).issues?.length,
      ).toBeGreaterThan(0);
      const update = decodeTermsUpdate(
        await authenticated({ ...(await termsUpdateBody()), version }),
        SECRET,
      );
      await expect(update).rejects.toBeInstanceOf(TermsUpdateRefusedError);
      await expect(update).rejects.toMatchObject({
        check: "format",
        madeByNewerAlcove: false,
      });
    },
  );

  test("both read version 1", async () => {
    expect(await invitationRefusal(token)).toBeUndefined();
    await expect(
      decodeTermsUpdate(await authenticated(await termsUpdateBody()), SECRET),
    ).resolves.toBeDefined();
  });
});

describe("the refusals after a body parses", () => {
  const withDroppedTerm = { ...terms, future_field: 1 };

  test("the invitation lists a dropped terms member before a version the fields need", async () => {
    const refusal = (await invitationRefusal({
      ...token,
      linkageTerms: withDroppedTerm,
      connectionEndpoint: {
        channel: "sftp",
        host: "s.example.org",
        relayUrl: "wss://relay.example.org/sftp",
      },
    })) as { issues: Array<{ message: string }> };
    expect(refusal.issues.map((issue) => issue.message)).toEqual([
      expect.stringContaining('"future_field"'),
      expect.stringContaining("needs version 2"),
    ]);
  });

  test("the terms update states the dropped terms member, the first of the two", async () => {
    const policy: FormatVersionPolicy = {
      current: 2,
      features: [
        {
          path: ["linkageTerms", "identity"],
          name: "linkageTerms.identity",
          version: 2,
        },
      ],
    };
    const update = decodeTermsUpdate(
      await authenticated({
        ...(await termsUpdateBody()),
        linkageTerms: withDroppedTerm,
      }),
      SECRET,
      policy,
    );
    await expect(update).rejects.toMatchObject({
      check: "format",
      madeByNewerAlcove: true,
      message: expect.stringContaining('"future_field"'),
    });

    const versionOnly = decodeTermsUpdate(
      await authenticated(await termsUpdateBody()),
      SECRET,
      policy,
    );
    await expect(versionOnly).rejects.toMatchObject({
      message: expect.stringContaining("needs version 2"),
    });
  });
});

describe("the default pipeline table", () => {
  test.each(SEMANTIC_TYPES)("a %s column's pipeline", (type) => {
    const steps = defaultStepsForType(type);
    if (type === "identifier" || type === "other")
      expect(steps).toBeUndefined();
    else expect(steps?.length).toBeGreaterThan(0);
  });

  test.each(["__proto__", "constructor", "toString", "hasOwnProperty", ""])(
    "a name that is no semantic type, %j, has none",
    (type) => {
      expect(defaultStepsForType(type)).toBeUndefined();
    },
  );

  test("the date of birth pipeline parses the default input format when given none", () => {
    expect(defaultStepsForType("date_of_birth")).toEqual(
      defaultStepsForType("date_of_birth", {
        dateInputFormat: DEFAULT_DATE_INPUT_FORMAT,
      }),
    );
    expect(defaultStepsForType("date_of_birth")).not.toEqual(
      defaultStepsForType("date_of_birth", { dateInputFormat: "YYYY-MM-DD" }),
    );
  });
});

test("the camelizing terms schema and its width bound stay off the main entry point", () => {
  expect(Object.keys(core)).not.toContain("InvitationLinkageTermsSchema");
  expect(Object.keys(core)).not.toContain("PARAMS_WIDTH_BOUND");
  expect(Object.keys(core)).not.toContain("parsedBodyRefusals");
});
