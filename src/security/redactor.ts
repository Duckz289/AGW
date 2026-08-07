/**
 * Deterministic secret redaction. Runs before anything reaches the
 * timeline store (AGENT.MD: "Redaction must happen before persistence").
 *
 * Deliberately not a probabilistic/entropy-based PII detector
 * (CURRENT_TASK.md: "Do not implement an elaborate probabilistic PII
 * detector in Phase 2A") — it recognizes exactly the documented sensitive
 * key names, plus the Bearer-token form, and nothing else.
 */

export const REDACTED_PLACEHOLDER = "[REDACTED]";

/** Sensitive key names, matched case-insensitively. */
export const SENSITIVE_KEYS: readonly string[] = [
  "password",
  "passwd",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "cookie",
  "set-cookie",
  "api_key",
  "apikey",
  "secret",
  "session",
  "sessionid"
];

const SENSITIVE_KEY_SET = new Set(SENSITIVE_KEYS.map((key) => key.toLowerCase()));

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(key.toLowerCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Matches a sensitive key name followed by `=` or `:` and a value, however
// it is embedded in otherwise free text — e.g. `password=hunter2`,
// `token: abc123`, `"apiKey":"abc123"` (a quoted JSON-shaped key) — not
// only structured query strings.
//
// Group 1: an optional quote immediately before the key (re-required
//   immediately after the key via backreference \1, so `"apiKey"` matches
//   but a stray leading quote on an unrelated word does not).
// Group 2: the key name itself. `\b...\b` prevents matching a key name
//   that is merely a substring of a longer, unrelated word (e.g. "token"
//   inside "access_token" is never matched on its own, because
//   "access_token" is one contiguous run of word characters with no
//   boundary before "token").
// Group 3: the `:`/`=` separator, with optional surrounding whitespace.
// Group 4: an optional quote immediately before the value (re-required
//   immediately after, like group 1).
// Group 5: the value — optionally prefixed with a literal "Bearer ", so a
//   `key: Bearer <token>` shape (e.g. an `Authorization` value) redacts
//   the whole "Bearer <token>", not just the literal word "Bearer".
const SENSITIVE_KEY_PATTERN = new RegExp(
  `(["']?)\\b(${SENSITIVE_KEYS.map(escapeRegExp).join("|")})\\b\\1(\\s*[:=]\\s*)(["']?)((?:Bearer\\s+)?[^\\s,;"'&]+)\\4`,
  "gi"
);

// A bearer/token value not attached to one of the named keys above — e.g.
// a bare copy-pasted "Bearer xyz" string in a log line with no preceding
// key name at all. Redacted conservatively (CURRENT_TASK.md: "For values
// embedded in clearly recognizable bearer/token forms, redact
// conservatively"). Runs after SENSITIVE_KEY_PATTERN, which already
// consumes (and redacts) any "Bearer ..." that follows a recognized key,
// so this only catches genuinely standalone occurrences.
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi;

/**
 * Redacts sensitive key=value / key: value occurrences (including
 * Bearer-form values attached to a key) and standalone Bearer-form tokens
 * from free text (console messages, runtime error messages and stacks).
 * Ordinary text with no recognized sensitive pattern is returned
 * unchanged.
 */
export function redactText(text: string): string {
  const withKeysRedacted = text.replace(
    SENSITIVE_KEY_PATTERN,
    (_match: string, keyQuote: string, key: string, separator: string, valueQuote: string) =>
      `${keyQuote}${key}${keyQuote}${separator}${valueQuote}${REDACTED_PLACEHOLDER}${valueQuote}`
  );
  return withKeysRedacted.replace(BEARER_PATTERN, `Bearer ${REDACTED_PLACEHOLDER}`);
}

/**
 * Redacts sensitive query-parameter *values* from a URL, preserving the
 * rest of the URL (scheme, host, path, and any non-sensitive query
 * parameters) exactly. Only the value is replaced — the parameter name
 * stays visible so the evidence remains useful.
 *
 * Example: `http://localhost:4300/api?token=abc123&query=test` becomes
 * `http://localhost:4300/api?token=%5BREDACTED%5D&query=test` (the
 * percent-encoding is `URLSearchParams`'s own, standard encoding of
 * `[REDACTED]`, not a separate escaping step).
 */
export function redactUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    // Not a structurally parseable absolute URL: fall back to the
    // conservative free-text redactor rather than risk persisting a raw
    // secret just because the shape was unexpected.
    return redactText(rawUrl);
  }

  for (const key of [...parsed.searchParams.keys()]) {
    if (isSensitiveKey(key)) {
      parsed.searchParams.set(key, REDACTED_PLACEHOLDER);
    }
  }

  return parsed.toString();
}
