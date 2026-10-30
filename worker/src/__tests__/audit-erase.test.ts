import { describe, expect, it } from "vitest";
import { replaceAddress } from "../lib/audit/erase";

describe("replaceAddress", () => {
  const email = "bob@x.com";

  it("replaces every whole occurrence, ignoring case", () => {
    expect(replaceAddress("Added Bob@X.com, then bob@x.com.", email, "T")).toBe(
      "Added T, then T.",
    );
  });

  it("leaves a longer address that contains it alone", () => {
    expect(replaceAddress("jimbob@x.com", email, "T")).toBe("jimbob@x.com");
    expect(replaceAddress("bob@x.com.au", email, "T")).toBe("bob@x.com.au");
    expect(replaceAddress("bob@x.community", email, "T")).toBe(
      "bob@x.community",
    );
  });

  it("treats regex characters in the address literally", () => {
    expect(replaceAddress("a+b@x.com", "a+b@x.com", "T")).toBe("T");
    expect(replaceAddress("bobAx.com", email, "T")).toBe("bobAx.com");
  });
});
