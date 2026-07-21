# GeneXus Routine Authoring Conventions (ScrapForAI)

## 1. Always gate login
After the login submit, add a `waitForUrlContains` step targeting a token unique to the
post-login page (e.g. `hwbwkw01`), with a 10-15s timeout. This fails fast and correctly
when login does not complete, instead of surfacing a confusing downstream timeout.
The GeneXus login page is `...wblogin`; the app pages are `...h<name>`.

## 2. Single session per user
This app appears to enforce one active session per user. Do not run the same login user
concurrently or immediately back-to-back - a second login can bounce back to `wblogin`
(symptom: post-submit screenshot shows the login form with the username field cleared).
Use a dedicated test user per run, sequence runs, or add a logout teardown.

## 3. Interpreting evidence (don't chase false failures)
- `net::ERR_ABORTED` entries in `networkFailures` (documents like `...apis.hhome`, theme
  images) are benign - they result from GeneXus client-side `top.location.href`
  redirects aborting in-flight requests. Filter them out when judging health.
- The reliable health signals are `consoleErrors`, `pageErrors`, your assertions, and the
  login gate. A run with empty `consoleErrors`/`pageErrors` that still "looks wrong" is
  usually a navigation/redirect artifact, not an app error.
- A "missing component" is frequently a consequence of not reaching the expected page
  (e.g. failed login). Confirm the page/URL first (via the login gate or a probe's `url`)
  before treating it as a real UI defect.
