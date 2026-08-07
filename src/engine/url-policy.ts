// Note (Phase 0 finding): the WHATWG URL parser keeps the brackets on an
// IPv6 hostname (`new URL("http://[::1]:5000").hostname === "[::1]"`, not
// "::1"), so the bracketed form is what must be allowlisted here.
const ALLOWED_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export type UrlPolicyDenialReason = "malformed_url" | "disallowed_protocol" | "disallowed_host";

export type UrlPolicyResult =
  | { allowed: true; url: URL }
  | { allowed: false; reason: UrlPolicyDenialReason; message: string };

/**
 * Phase 0 URL policy: only http(s) requests to loopback hosts are allowed.
 * Uses the WHATWG URL parser (not string prefix checks) so userinfo
 * tricks like `http://localhost@evil.com` or `http://evil.com#localhost`
 * are judged by the parsed hostname, not the raw string.
 */
export function checkUrlPolicy(rawUrl: string): UrlPolicyResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return {
      allowed: false,
      reason: "malformed_url",
      message: `"${rawUrl}" is not a valid URL`
    };
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    return {
      allowed: false,
      reason: "disallowed_protocol",
      message: `protocol "${parsed.protocol}" is not allowed; only http: and https: are permitted`
    };
  }

  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    return {
      allowed: false,
      reason: "disallowed_host",
      message: `host "${parsed.hostname}" is not in the loopback allowlist (localhost, 127.0.0.1, ::1)`
    };
  }

  return { allowed: true, url: parsed };
}

export function assertUrlPolicy(rawUrl: string): URL {
  const result = checkUrlPolicy(rawUrl);
  if (!result.allowed) {
    throw new Error(`URL policy denial (${result.reason}): ${result.message}`);
  }
  return result.url;
}
