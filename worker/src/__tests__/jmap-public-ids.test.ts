import { describe, it, expect } from "vitest";
import {
  JMAP_ID_PATTERN,
  parseAnyEmailId,
  parseAttachmentBlobId,
  parseBodyPartBlobId,
  parseDraftEmailId,
  parseEmailId,
  parseRawBlobId,
  parseThreadId,
  parseUploadBlobId,
  publicAccountId,
  publicAttachmentBlobId,
  publicBodyPartBlobId,
  publicCustomMailboxId,
  publicDraftEmailId,
  publicEmailId,
  publicIdForChangeObject,
  publicIdentityId,
  publicRawBlobId,
  publicSystemMailboxId,
  publicThreadId,
  publicUploadBlobId,
  sha256Base64url,
} from "../jmap/public-ids";

const LONG_INBOX = `${"a".repeat(64)}@${"b".repeat(185)}.com`; // 254 chars

describe("JMAP public ids", () => {
  it("hashes with a known SHA-256 vector", () => {
    expect(sha256Base64url("abc")).toBe(
      "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0",
    );
  });

  it("derives a stable, valid, versioned account id", () => {
    const id = publicAccountId("user-1");
    expect(id).toMatch(JMAP_ID_PATTERN);
    expect(id).toBe(publicAccountId("user-1"));
    expect(id).not.toBe("user-1");
    expect(id).not.toBe(publicAccountId("user-2"));
    expect(id.startsWith("a")).toBe(true);
  });

  it("round-trips message ids, raw when safe and base64 otherwise", () => {
    expect(publicEmailId({ kind: "received", id: "abc_DEF-1" })).toBe(
      "Rabc_DEF-1",
    );
    expect(publicEmailId({ kind: "sent", id: "xyz" })).toBe("Sxyz");
    const odd = publicEmailId({ kind: "received", id: "has:colon@x" });
    expect(odd).toMatch(JMAP_ID_PATTERN);
    expect(parseEmailId(odd)).toEqual({ kind: "received", id: "has:colon@x" });
    expect(parseEmailId("Rabc_DEF-1")).toEqual({
      kind: "received",
      id: "abc_DEF-1",
    });
    for (const bad of ["", "R", "S", "Z1", "r!!", "received:abc"]) {
      expect(parseEmailId(bad)).toBeNull();
    }
  });

  it("keeps mailbox and identity ids valid for a 254-character inbox", () => {
    for (const role of [
      "inbox",
      "drafts",
      "sent",
      "archive",
      "junk",
      "trash",
    ] as const) {
      const id = publicSystemMailboxId(LONG_INBOX, role);
      expect(id).toMatch(JMAP_ID_PATTERN);
      expect(id.length).toBe(44);
    }
    expect(publicSystemMailboxId("A@X.com", "inbox")).toBe(
      publicSystemMailboxId("a@x.com", "inbox"),
    );
    const identity = publicIdentityId(LONG_INBOX);
    expect(identity).toMatch(JMAP_ID_PATTERN);
    expect(identity.length).toBe(44);
  });

  it("encodes custom mailbox ids raw when safe, hashed otherwise", () => {
    expect(publicCustomMailboxId("folder-1")).toBe("Mfolder-1");
    const odd = publicCustomMailboxId("bad id/with space");
    expect(odd).toMatch(JMAP_ID_PATTERN);
    expect(odd.startsWith("m")).toBe(true);
  });

  it("round-trips every thread key form", () => {
    const cases: [string, string][] = [
      ["p:person_1", "Tpperson_1"],
      ["received:msg1", "Trmsg1"],
      ["sent:msg2", "Tsmsg2"],
      ["c_0123456789abcdef", "Tcc_0123456789abcdef"],
    ];
    for (const [key, expected] of cases) {
      expect(publicThreadId(key)).toBe(expected);
      expect(parseThreadId(expected)).toBe(key);
    }
    const odd = publicThreadId("weird key:with/stuff");
    expect(odd).toMatch(JMAP_ID_PATTERN);
    expect(parseThreadId(odd)).toBe("weird key:with/stuff");
    const huge = publicThreadId(`k:${"z/".repeat(300)}`);
    expect(huge).toMatch(JMAP_ID_PATTERN);
    expect(parseThreadId(huge)).toBeNull();
    expect(parseThreadId("T")).toBeNull();
    expect(parseThreadId("nope")).toBeNull();
  });

  it("round-trips blob ids", () => {
    expect(publicAttachmentBlobId("att_1")).toBe("Aatt_1");
    expect(parseAttachmentBlobId("Aatt_1")).toBe("att_1");
    const odd = publicAttachmentBlobId("a/b");
    expect(parseAttachmentBlobId(odd)).toBe("a/b");
    expect(parseAttachmentBlobId("Pnope_text")).toBeNull();

    const email = publicEmailId({
      kind: "received",
      id: "id_with_underscores",
    });
    const part = publicBodyPartBlobId(email, "html");
    expect(part).toBe("PRid_with_underscores_html");
    expect(parseBodyPartBlobId(part)).toEqual({ emailId: email, part: "html" });
    expect(parseBodyPartBlobId("PRabc_json")).toBeNull();
  });

  it("round-trips upload blob ids and keeps them apart from attachments", () => {
    expect(publicUploadBlobId("V1StGXR8_Z5jdHi6B-myT")).toBe(
      "UV1StGXR8_Z5jdHi6B-myT",
    );
    expect(parseUploadBlobId("UV1StGXR8_Z5jdHi6B-myT")).toBe(
      "V1StGXR8_Z5jdHi6B-myT",
    );
    const odd = publicUploadBlobId("has space/and:colon");
    expect(odd).toMatch(JMAP_ID_PATTERN);
    expect(odd.startsWith("u")).toBe(true);
    expect(parseUploadBlobId(odd)).toBe("has space/and:colon");
    for (const bad of ["", "U", "u", "u!!", "Aatt_1", "Pnope_text"]) {
      expect(parseUploadBlobId(bad)).toBeNull();
    }
    // Families never decode as each other.
    expect(parseAttachmentBlobId(publicUploadBlobId("x1"))).toBeNull();
    expect(parseUploadBlobId(publicAttachmentBlobId("x1"))).toBeNull();
  });

  it("maps change-log object ids", () => {
    expect(publicIdForChangeObject("received:a1")).toBe("Ra1");
    expect(publicIdForChangeObject("sent:b2")).toBe("Sb2");
    expect(publicIdForChangeObject("mbx:f1")).toBe("Mf1");
  });

  it("round-trips draft email ids and raw-message blob ids", () => {
    expect(publicDraftEmailId("draft_1")).toBe("Ddraft_1");
    expect(parseDraftEmailId("Ddraft_1")).toBe("draft_1");
    expect(parseAnyEmailId("Ddraft_1")).toEqual({
      kind: "draft",
      id: "draft_1",
    });
    expect(parseAnyEmailId("Rabc")).toEqual({ kind: "received", id: "abc" });
    expect(parseAnyEmailId("Sabc")).toEqual({ kind: "sent", id: "abc" });
    for (const bad of ["", "D", "d!!", "Zabc", "draft:abc"]) {
      expect(parseAnyEmailId(bad)).toBeNull();
    }
    // The R/S parser stays strict: web-API shaped refs never see drafts.
    expect(parseEmailId("Ddraft_1")).toBeNull();

    expect(publicRawBlobId("content-1")).toBe("Xcontent-1");
    expect(parseRawBlobId("Xcontent-1")).toBe("content-1");
    expect(parseRawBlobId("Aatt_1")).toBeNull();
    expect(parseRawBlobId("X")).toBeNull();
  });

  it("maps draft-started threads to Td ids", () => {
    expect(publicThreadId("draft:abc_1")).toBe("Tdabc_1");
    expect(parseThreadId("Tdabc_1")).toBe("draft:abc_1");
  });

  it("accepts numeric body-part ids for every email family", () => {
    const part = publicBodyPartBlobId("Dd1", "3");
    expect(part).toBe("PDd1_3");
    expect(parseBodyPartBlobId(part)).toEqual({ emailId: "Dd1", part: "3" });
    // The part id is parsed from the end, so ids containing "_<digits>" work.
    expect(parseBodyPartBlobId("PDd_1_12")).toEqual({
      emailId: "Dd_1",
      part: "12",
    });
    expect(parseBodyPartBlobId("PRabc_text")).toEqual({
      emailId: "Rabc",
      part: "text",
    });
    expect(parseBodyPartBlobId("PDd1_x3")).toBeNull();
    expect(parseBodyPartBlobId("Pnope_3")).toBeNull();
  });

  it("maps draft change-log ids", () => {
    expect(publicIdForChangeObject("draft:d9")).toBe("Dd9");
  });
});
