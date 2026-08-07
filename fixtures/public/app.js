const form = document.getElementById("login-form");
const errorMessage = document.getElementById("error-message");
const appRoot = document.getElementById("app-root");

// Chromium does not compute an accessible *name* from text content alone
// for role="alert" (or role="status") elements — verified directly:
// getByRole("alert", { name: <text> }) matches 0 elements without an
// explicit aria-label, even though the same text is visible and the
// bare role matches. Setting aria-label alongside textContent keeps the
// element's accessible name in sync with what it visibly says, so
// element_visible-by-role-and-name checks (used by Phase 2B's
// FM-SERVER-ERROR-NOT-SHOWN checker fixture) resolve correctly.
function showError(text) {
  errorMessage.hidden = false;
  errorMessage.textContent = text;
  errorMessage.setAttribute("aria-label", text);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const emailInput = document.getElementById("email");
  const passwordInput = document.getElementById("password");
  const forceError = document.getElementById("force-error").checked;

  errorMessage.hidden = true;
  errorMessage.textContent = "";
  errorMessage.removeAttribute("aria-label");

  let response;
  try {
    response = await fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: emailInput.value,
        password: passwordInput.value,
        forceError
      })
    });
  } catch (err) {
    showError("Network error while logging in.");
    console.error("Fixture: login request failed", err);
    return;
  }

  if (response.status === 500) {
    showError("Server error, please try again.");
    console.error("Fixture: login returned HTTP 500");
    return;
  }

  if (!response.ok) {
    showError("Login failed.");
    return;
  }

  appRoot.innerHTML = "<h1>Dashboard</h1><p>You are logged in.</p>";
});

document.getElementById("console-log-button").addEventListener("click", () => {
  console.log("Fixture: simulated console log");
});

document.getElementById("console-error-button").addEventListener("click", () => {
  console.error("Fixture: simulated console error");
});

document.getElementById("throw-error-button").addEventListener("click", () => {
  // Phase 4A fail-on-bug/pass-on-fix toggle: "fixed" mode is injected by
  // the fixture server as a global before this script loads (see
  // fixtures/server.ts::serveStatic). Absent (undefined) or "buggy" both
  // preserve the original, always-throws Phase 0-3B behavior.
  if (window.__WEBCHECK_FIXTURE_MODE__ === "fixed") return;
  throw new Error("Fixture: simulated uncaught exception");
});

document.getElementById("rerender-button").addEventListener("click", () => {
  const oldInput = document.getElementById("email");
  const newInput = document.createElement("input");
  newInput.id = "email";
  newInput.name = "email";
  newInput.type = "email";
  newInput.setAttribute("data-testid", "email-input");
  newInput.placeholder = "you@example.com";
  newInput.autocomplete = "username";
  newInput.value = oldInput.value;
  oldInput.replaceWith(newInput);
});

document.getElementById("transport-fail-button").addEventListener("click", async () => {
  try {
    await fetch("/api/transport-fail");
  } catch (err) {
    console.error("Fixture: transport failure triggered", err);
  }
});

// Evidence-pipeline fixtures below: deterministic sentinel values (never
// real secrets) for proving the redactor scrubs console text and network
// URLs before anything reaches the timeline. See CURRENT_TASK.md /
// tests/integration/evidence-secrets.test.ts.
document.getElementById("log-sensitive-button").addEventListener("click", () => {
  console.error(
    "Fixture: auth failed for password=WEBCHECK_TEST_PASSWORD_7f4a token=WEBCHECK_TEST_TOKEN_91ce"
  );
});

document.getElementById("sensitive-request-button").addEventListener("click", async () => {
  try {
    await fetch("/api/sensitive?token=WEBCHECK_TEST_TOKEN_91ce&apikey=WEBCHECK_TEST_APIKEY_a273&query=test");
  } catch (err) {
    console.error("Fixture: sensitive request failed", err);
  }
});

// Phase 2B checker fixtures below.

// Deliberately never hides the indicator again and never shows any
// success state — a fixture-level "bug" for ST-INFINITE-LOADING to
// detect (with the loading indicator declared via flow.checks).
document.getElementById("infinite-loading-button").addEventListener("click", () => {
  document.getElementById("loading-indicator").hidden = false;
});

// Starts a request and aborts it synchronously, before any response can
// arrive — a legitimate cancellation (net::ERR_ABORTED), not a defect.
// NW-TRANSPORT-FAILURE must never flag this.
document.getElementById("cancel-request-button").addEventListener("click", () => {
  const controller = new AbortController();
  const request = fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "cancelled@example.com", password: "unused" }),
    signal: controller.signal
  }).catch(() => {
    // Expected: aborting rejects the fetch promise itself too.
  });
  controller.abort();
  void request;
});
