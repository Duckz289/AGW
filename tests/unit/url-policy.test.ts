import { describe, expect, it } from "vitest";
import { checkUrlPolicy } from "../../src/engine/url-policy.ts";

describe("url policy", () => {
  it("accepts loopback hosts", () => {
    expect(checkUrlPolicy("http://localhost:3000").allowed).toBe(true);
    expect(checkUrlPolicy("http://127.0.0.1:4300/path").allowed).toBe(true);
    expect(checkUrlPolicy("http://[::1]:5000").allowed).toBe(true);
    expect(checkUrlPolicy("https://localhost").allowed).toBe(true);
  });

  it("rejects external domains", () => {
    const result = checkUrlPolicy("https://example.com");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("disallowed_host");
  });

  it("rejects userinfo/host tricks by judging the parsed hostname, not the raw string", () => {
    const result = checkUrlPolicy("http://localhost@evil.com/");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("disallowed_host");
  });

  it("rejects malformed URLs", () => {
    const result = checkUrlPolicy("not a url");
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("malformed_url");
  });

  it("rejects file:, data: and javascript: protocols", () => {
    for (const url of ["file:///etc/passwd", "data:text/html,<script>1</script>", "javascript:alert(1)"]) {
      const result = checkUrlPolicy(url);
      expect(result.allowed, `${url} should be denied`).toBe(false);
      if (!result.allowed) expect(result.reason).toBe("disallowed_protocol");
    }
  });
});
