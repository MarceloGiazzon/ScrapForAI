# ScrapForAI — Security

ScrapForAI drives a real browser on your machine. Treat it as a privileged tool, not as a
passive HTTP client.

## Threat model

ScrapForAI is designed for **controlled development and test sites you own or are authorised
to exercise**. It is explicitly not a general-purpose scraper for arbitrary internet targets.

What an attacker gains by reaching this API:

- **Server-side request forgery.** The runner navigates wherever it is told, from inside your
  network. This is why the target allowlist exists and why it is not optional.
- **Credential replay.** Routines carry the credentials of the site under test.
  Secrets are kept in the server-side credential vault and referenced by `credentialSet`; the MCP
  tool has no way to supply or read a value. Each set is bound to origins, so a routine cannot
  carry a vaulted password to a different allowlisted app.
  *Legacy path:* the REST API still accepts inline `credentials` (deprecated). Redaction covers
  results, logs and history, but not the request, and inline values are not origin-bound. Set
  `ALLOW_INLINE_CREDENTIALS=false` to disable the path. Never commit real credentials;
  `test/samples-hygiene.test.ts` enforces placeholders in `samples/`.
- **Arbitrary in-page JavaScript**, but only when `ALLOW_EVALUATE=true`.

The controls below exist to bound each of those.

## Controls

| Control | Where | What it stops |
|---|---|---|
| Bearer API key on every data route | `src/security/apiAuth.ts` | Unauthenticated use |
| Target origin allowlist | `src/security/validateTargetUrl.ts` | SSRF to arbitrary hosts |
| Private-IP / loopback blocks | `src/security/validateTargetUrl.ts` | Pivoting to internal services |
| Secret redaction | `src/security/redactSecrets.ts` | Credentials leaking into results, logs and history |
| Artifact path containment | `src/artifacts/artifactStore.ts` | Path traversal out of the artifact root |
| CSRF header on cookie writes | `src/security/apiAuth.ts` | Cross-site state changes via the UI session |
| Locked config fields | `src/routes/config.routes.ts` | A hijacked UI session widening the allowlist |
| Content Security Policy | `src/server.ts` | Injected scripts in the UI |
| Rate limiting | `src/server.ts`, `src/routes/auth.routes.ts` | Brute force and runaway automation |
| Credential vault | `src/vault/credentials/credentialVault.ts` | Secrets passing through the caller/LLM; plaintext at rest |
| Credential↔origin binding | `src/security/credentialBinding.ts` | A routine carrying a vaulted secret to another allowlisted origin |
| Bearer-only writes | `requireBearer` in `src/security/apiAuth.ts` | A hijacked UI session writing credentials or target profiles |
| Evidence manifest | `src/evidence/manifest.ts` | Silent edits to screenshots/results after the fact |
| Signed manifest chain | `src/evidence/signature.ts`, `chain.ts` | Forged, edited or removed pinned evidence (Ed25519 + linked hashes + sequence + high-water mark). Does not stop whoever holds the private key, nor prove the test was correct |
| Bearer-only pin + quota | `src/evidence/pin.ts` | A UI session filling the disk with never-expiring evidence |
| Target profiles stay inside the allowlist | `src/targets/targetStore.ts` | A profile widening `ALLOWED_TARGET_ORIGINS` |

None of these may be removed without replacing them with something stronger.

## `ALLOW_EVALUATE` is dangerous

`ALLOW_EVALUATE=true` lets a routine execute **arbitrary JavaScript inside the target page**,
with that page's full privileges and session. Anyone who can submit a routine can then read
or alter anything the logged-in user could.

Keep it `false` unless every one of these holds:

- The machine is local and single-user.
- The target origins are development sites you control.
- You author every routine yourself.

It is `false` by default, it is a **locked** field in the config UI (changing it requires the
bearer API key, not just a UI session), and both the Config and Status screens show a red
banner whenever it is on.

## `HOST` defaults to `127.0.0.1`

A bare-metal `npm start` binding `0.0.0.0` would expose a browser-automation engine to the
whole LAN behind a single shared secret. The default is therefore loopback.

Set `HOST=0.0.0.0` only as a deliberate decision, and put real authentication in front of it
if you do. Docker is unaffected: the container listens on `0.0.0.0` internally while
`docker-compose.yml` publishes only to `127.0.0.1` on the host.

## Bearer tokens vs. session cookies

The API is bearer-token authenticated, which makes it inherently CSRF-immune — a malicious
web page cannot make your browser attach an `Authorization` header.

The web UI needs a browser-friendly credential, so it adds a session cookie. That reintroduces
CSRF risk, mitigated as follows:

1. The API key is exchanged at `POST /v1/auth/login` for an `httpOnly; SameSite=Strict`
   cookie. The key is **never** placed in `localStorage`, `sessionStorage`, or any JavaScript
   variable, so UI code cannot read it even accidentally.
2. Cookie-authenticated, state-changing requests must carry `X-ScrapForAI-UI: 1`. Cross-origin
   pages cannot set a custom header without a CORS preflight, which the origin policy refuses.
   Bearer-authenticated requests skip this check because they do not need it.
3. **Locked fields** — `SCRAPFORAI_API_KEY`, `ALLOWED_TARGET_ORIGINS`,
   `ALLOWED_RESOURCE_ORIGINS`, `ALLOW_EVALUATE`, `HOST` — require the bearer key on the
   request. A stolen UI session alone cannot widen the SSRF allowlist or enable arbitrary
   JavaScript execution.
4. Sessions live in memory only and do not survive a restart.

## Rotating the API key

1. Generate a strong key (≥16 characters; 48 recommended):
   ```powershell
   -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
   ```
2. Set `SCRAPFORAI_API_KEY=<new key>` in `.env`.
3. Restart ScrapForAI. The key is read at startup, so the change is not live until you do.
4. Update any MCP client or script that presents the old key.

All existing UI sessions are invalidated by the restart.

Rotate immediately if the key was ever committed to version control, pasted into a chat or
ticket, or written to a file outside `.env`. Never commit `.env`.

## Reporting a vulnerability

Report privately to the maintainers rather than opening a public issue. Include the version,
reproduction steps, and what an attacker gains. Please allow time for a fix before any public
disclosure.
