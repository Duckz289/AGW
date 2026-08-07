import { describe, expect, it } from "vitest";
import { redactText, redactUrl } from "../../src/security/redactor.ts";

describe("redactText", () => {
  it("redacts a password key while preserving the key name", () => {
    const result = redactText("password=hunter2");
    expect(result).toBe("password=[REDACTED]");
    expect(result).not.toContain("hunter2");
  });

  it("redacts a quoted, JSON-shaped sensitive key", () => {
    const result = redactText('{"apiKey":"a273secret","query":"test"}');
    expect(result).toBe('{"apiKey":"[REDACTED]","query":"test"}');
    expect(result).not.toContain("a273secret");
  });

  it("redacts an Authorization: Bearer <token> form, removing the whole token", () => {
    const result = redactText("Authorization: Bearer abc.def-ghi_123");
    expect(result).toBe("Authorization: [REDACTED]");
    expect(result).not.toContain("abc.def-ghi_123");
  });

  it("redacts a standalone Bearer-form token with no preceding key", () => {
    const result = redactText("saw header value Bearer standaloneToken123 in the request");
    expect(result).toContain("Bearer [REDACTED]");
    expect(result).not.toContain("standaloneToken123");
  });

  it("preserves ordinary console text with no sensitive pattern", () => {
    const text = "Fixture: simulated console error";
    expect(redactText(text)).toBe(text);
  });

  it("does not false-positive on a key name that is only a substring of a longer word", () => {
    const text = "this contains tokenized but not as a real key, should be untouched";
    expect(redactText(text)).toBe(text);
  });

  it("redacts multiple distinct sensitive keys in the same text", () => {
    const result = redactText("password=WEBCHECK_TEST_PASSWORD_7f4a token=WEBCHECK_TEST_TOKEN_91ce");
    expect(result).toBe("password=[REDACTED] token=[REDACTED]");
  });
});

describe("redactUrl", () => {
  it("redacts a sensitive query parameter value while preserving the rest of the URL", () => {
    const result = redactUrl("http://localhost:4300/api?token=abc123&query=test");
    const parsed = new URL(result);
    expect(parsed.origin).toBe("http://localhost:4300");
    expect(parsed.pathname).toBe("/api");
    expect(parsed.searchParams.get("token")).toBe("[REDACTED]");
    expect(result).not.toContain("abc123");
  });

  it("preserves a harmless query parameter untouched", () => {
    const result = redactUrl("http://localhost:4300/api?token=abc123&query=test");
    const parsed = new URL(result);
    expect(parsed.searchParams.get("query")).toBe("test");
  });

  it("leaves a URL with no sensitive query parameters unchanged in meaning", () => {
    const result = redactUrl("http://127.0.0.1:4300/styles.css");
    expect(new URL(result).href).toBe("http://127.0.0.1:4300/styles.css");
  });

  it("falls back to text redaction for a value that is not a parseable absolute URL", () => {
    const result = redactUrl("not a valid url with token=shouldstillberedacted");
    expect(result).not.toContain("shouldstillberedacted");
  });
});
