import { describe, it, expect } from "vitest";
import { verifyWebhook, UNIPILE_AUTH_HEADER } from "../src/verify.js";

const SECRET = "s3cr3t-value-abcdefghijklmnop";

describe("verifyWebhook", () => {
  it("accepts a plain-object header map with the correct secret", () => {
    expect(verifyWebhook({ "x-unipile-auth": SECRET }, SECRET)).toBe(true);
  });

  it("matches the header name case-insensitively", () => {
    expect(verifyWebhook({ "X-Unipile-Auth": SECRET }, SECRET)).toBe(true);
    expect(verifyWebhook({ "X-UNIPILE-AUTH": SECRET }, SECRET)).toBe(true);
  });

  it("accepts a Headers instance", () => {
    const h = new Headers();
    h.set(UNIPILE_AUTH_HEADER, SECRET);
    expect(verifyWebhook(h, SECRET)).toBe(true);
  });

  it("rejects a wrong secret", () => {
    expect(verifyWebhook({ "x-unipile-auth": "nope" }, SECRET)).toBe(false);
  });

  it("rejects a value of different length (constant-time guard)", () => {
    expect(verifyWebhook({ "x-unipile-auth": SECRET + "x" }, SECRET)).toBe(
      false,
    );
    expect(verifyWebhook({ "x-unipile-auth": SECRET.slice(0, -1) }, SECRET)).toBe(
      false,
    );
  });

  it("rejects a missing header", () => {
    expect(verifyWebhook({}, SECRET)).toBe(false);
    expect(verifyWebhook({ "content-type": "application/json" }, SECRET)).toBe(
      false,
    );
  });

  it("rejects an empty provided value", () => {
    expect(verifyWebhook({ "x-unipile-auth": "" }, SECRET)).toBe(false);
  });

  it("rejects when the configured secret is empty", () => {
    expect(verifyWebhook({ "x-unipile-auth": "anything" }, "")).toBe(false);
  });

  it("reads the first value when a header arrives as an array", () => {
    expect(verifyWebhook({ "x-unipile-auth": [SECRET] }, SECRET)).toBe(true);
  });
});
