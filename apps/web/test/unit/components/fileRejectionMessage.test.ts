import { describe, expect, test, vi } from "vitest";

import { fileRejectionMessage } from "@components/csvIntake";

import type { FileRejection } from "@mantine/dropzone";

function rejection(...codes: Array<string>): FileRejection {
  return {
    file: Object.assign(new File(["x"], "private-name.csv"), {
      path: "private-name.csv",
      relativePath: "private-name.csv",
    }),
    errors: codes.map((code) => ({ code, message: code })),
  };
}

function silentLog() {
  return { warn: vi.fn() };
}

describe("fileRejectionMessage", () => {
  test("a file over the size bound names the bound, for a CSV", () => {
    expect(
      fileRejectionMessage([rejection("file-too-large")], {
        maxMb: 200,
        noun: "csv",
        log: silentLog(),
      }),
    ).toBe(
      "That file is larger than the 200 MB maximum. Choose a CSV file under 200 MB.",
    );
  });

  test("a file of the wrong type says so, for a CSV", () => {
    expect(
      fileRejectionMessage([rejection("file-invalid-type")], {
        maxMb: 200,
        noun: "csv",
        log: silentLog(),
      }),
    ).toBe(
      "That file is not a supported file type. Choose a CSV file under 200 MB.",
    );
  });

  test("a file both too large and of the wrong type gets both reasons, size first", () => {
    expect(
      fileRejectionMessage([rejection("file-invalid-type", "file-too-large")], {
        maxMb: 200,
        noun: "csv",
        log: silentLog(),
      }),
    ).toBe(
      "That file is larger than the 200 MB maximum and not a supported file type. Choose a CSV file under 200 MB.",
    );
  });

  test("a code it does not map falls back to the wrong-type reason", () => {
    expect(
      fileRejectionMessage([rejection("too-many-files")], {
        maxMb: 200,
        noun: "csv",
        log: silentLog(),
      }),
    ).toBe(
      "That file is not a supported file type. Choose a CSV file under 200 MB.",
    );
  });

  test("a rejection with no error codes falls back to the wrong-type reason", () => {
    expect(
      fileRejectionMessage([rejection()], {
        maxMb: 200,
        noun: "csv",
        log: silentLog(),
      }),
    ).toBe(
      "That file is not a supported file type. Choose a CSV file under 200 MB.",
    );
  });

  test("an unmapped code beside a too-large one adds no wrong-type reason", () => {
    expect(
      fileRejectionMessage([rejection("file-too-large", "too-many-files")], {
        maxMb: 5,
        noun: "csv",
        log: silentLog(),
      }),
    ).toBe(
      "That file is larger than the 5 MB maximum. Choose a CSV file under 5 MB.",
    );
  });

  test("the JSON noun words the wrong-type reason and the choice for a JSON file", () => {
    expect(
      fileRejectionMessage([rejection("file-invalid-type")], {
        maxMb: 1,
        noun: "json",
        log: silentLog(),
      }),
    ).toBe("That file is not a JSON file. Choose a .json file under 1 MB.");
  });

  test("the JSON noun keeps the size reason and the combined reading", () => {
    const options = { maxMb: 1, noun: "json", log: silentLog() } as const;
    expect(fileRejectionMessage([rejection("file-too-large")], options)).toBe(
      "That file is larger than the 1 MB maximum. Choose a .json file under 1 MB.",
    );
    expect(
      fileRejectionMessage(
        [rejection("file-too-large", "file-invalid-type")],
        options,
      ),
    ).toBe(
      "That file is larger than the 1 MB maximum and not a JSON file. Choose a .json file under 1 MB.",
    );
  });

  test("codes across several rejections are pooled", () => {
    expect(
      fileRejectionMessage(
        [rejection("file-invalid-type"), rejection("file-too-large")],
        { maxMb: 200, noun: "csv", log: silentLog() },
      ),
    ).toBe(
      "That file is larger than the 200 MB maximum and not a supported file type. Choose a CSV file under 200 MB.",
    );
  });

  test("the log receives the file count and the distinct codes, never the file name", () => {
    const log = silentLog();
    fileRejectionMessage(
      [
        rejection("file-invalid-type", "file-too-large"),
        rejection("file-invalid-type"),
      ],
      { maxMb: 200, noun: "csv", log },
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("rejected 2 file(s):", [
      "file-invalid-type",
      "file-too-large",
    ]);
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("private-name");
  });
});
