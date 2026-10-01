import { describe, it, expect } from "vitest";
import { neutralizeFormula, csvField, csvRow } from "../lib/csv";

describe("neutralizeFormula", () => {
  it("leaves ordinary values alone", () => {
    expect(neutralizeFormula("alice@example.com")).toBe("alice@example.com");
    expect(neutralizeFormula("Alice")).toBe("Alice");
    expect(neutralizeFormula("")).toBe("");
  });

  it.each(["=", "+", "-", "@"])(
    "prefixes a quote when the cell starts with %s",
    (prefix) => {
      expect(neutralizeFormula(`${prefix}cmd()`)).toBe(`'${prefix}cmd()`);
    },
  );

  /**
   * Spreadsheets strip leading whitespace before deciding whether a cell is a
   * formula, so a naive `startsWith("=")` check misses `\t=HYPERLINK(...)`.
   */
  it("sees through leading control characters", () => {
    expect(neutralizeFormula("\t=cmd()")).toBe("'\t=cmd()");
    expect(neutralizeFormula("\r\n@cmd()")).toBe("'\r\n@cmd()");
  });

  it("does not treat a lone control character as a formula", () => {
    expect(neutralizeFormula("\t")).toBe("\t");
  });
});

describe("csvField", () => {
  it("quotes values containing a comma, quote or newline", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });

  it("renders null and undefined as empty", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("neutralizes and then quotes, so an injected formula is inert", () => {
    // The comma forces quoting; the leading `=` must still be neutralized.
    expect(csvField("=cmd(),x")).toBe(`"'=cmd(),x"`);
  });
});

describe("csvRow", () => {
  it("joins cells and terminates with CRLF", () => {
    expect(csvRow(["a", "b"])).toBe("a,b\r\n");
  });
});
