import { describe, expect, test } from "vitest";

import { runPipeline } from "../src/standardization";

const step = [{ function: "gmail_address" }];
const run = (value: string) => runPipeline(value, step);

describe("gmail_address", () => {
  test("removes dots and a plus tag at gmail.com", () => {
    expect(run("jane.doe+clinic@gmail.com")).toBe("janedoe@gmail.com");
    expect(run("j.a.n.e@gmail.com")).toBe("jane@gmail.com");
  });

  test("writes googlemail.com as gmail.com", () => {
    expect(run("jane.doe+clinic@googlemail.com")).toBe("janedoe@gmail.com");
    expect(run("janedoe@googlemail.com")).toBe("janedoe@gmail.com");
  });

  test("Google's worked example, with the domain joined", () => {
    // Google keeps googlemail.com in its example; this step writes gmail.com.
    expect(run("Jane.Doe+Shopping@googlemail.com")).toBe("JaneDoe@gmail.com");
  });

  test("an address with no tag loses only its dots", () => {
    expect(run("jane.doe@gmail.com")).toBe("janedoe@gmail.com");
    expect(run("janedoe@gmail.com")).toBe("janedoe@gmail.com");
  });

  test("everything from the first plus to the @ is the tag", () => {
    expect(run("jane+a+b.c@gmail.com")).toBe("jane@gmail.com");
  });

  test("matches the domain in any ASCII letter case and keeps the local part's case", () => {
    expect(run("Jane.Doe@GMAIL.COM")).toBe("JaneDoe@gmail.com");
    expect(run("jane@GoogleMail.Com")).toBe("jane@gmail.com");
  });

  test("keeps an address at any other domain as it is", () => {
    for (const value of [
      "jane.doe+x@example.com",
      "jane.doe@gmail.co",
      "jane.doe@mail.gmail.com",
      "jane.doe@gmail.com.example",
      "jane.doe@gmail.com.",
      "jane.doe@gmaiı.com",
    ])
      expect(run(value), value).toBe(value);
  });

  test("keeps a value with no @ or more than one as it is", () => {
    for (const value of ["jane.doe", "a.b@c@gmail.com", "", "+.@"])
      expect(run(value), value).toBe(value);
  });

  test("a local part of only dots and a tag folds to nothing before the @", () => {
    expect(run(".+tag@gmail.com")).toBe("@gmail.com");
    expect(run("@gmail.com")).toBe("@gmail.com");
  });
});
