# Team server (T10.1)

ScrapForAI started as one person with one API key. A team needs to know **who** did something, to give people **different powers**, and to take one person's access away **without changing everybody's**. This is what T10.1 adds: personal API keys, three roles, an audit log, and a Docker deployment for a host that stays on.

Nothing changes for a single user: the key in `.env` (`SCRAPFORAI_API_KEY`) keeps working and is now the installation's own admin, called `root`.

## Roles

| Role | Can | Cannot |
|---|---|---|
| `viewer` | Read: history, reports, evidence, health, executive panel, performance, vault items, metadata of credential sets | Start anything; change anything |
| `runner` | Everything a viewer can, plus start runs, `inspect_dom`, suites, shrinks, differentials, permission matrices, save routines, run vault items, draft bug reports, dismiss/resolve them | The writes that need the API key (below); manage people; read the audit log; change the configuration |
| `admin` | Everything, including the writes that need the API key, `/v1/team` and `/v1/audit`, and changing the configuration | |

The writes that need an **admin's key sent as a Bearer token** (a web-console session is never enough, whatever the role): the credential vault (`/v1/credentials`), target profiles, pinning evidence, schedules, webhooks, integrations, sending a bug report, saving or proving a regression-vault item (`PUT /v1/vault/:id`, `add-from-run`, `confirm-green`), manual builds, and all of `/v1/team`. A `runner` who tries gets `403 InsufficientRole`; a session gets `403 BearerTokenRequired`.

The policy is one function, `requiredRole()` in `src/team/roles.ts`, with a test table (`test/team.test.ts`).

## People and keys

```
scrapforai users create ana --role runner --name "Ana Silva"   # prints her key ONCE
scrapforai users list
scrapforai users set ana --role viewer          # takes effect on her very next request, sessions included
scrapforai users set ana --disabled true        # out now; her sessions end
scrapforai users key-create ana --label laptop --expires 2027-06-30T00:00:00Z
scrapforai users key-revoke ana <keyId>
scrapforai users delete ana
```

(Run them with the `root` key or an admin's key in the CLI's `.env`. The same operations are `POST|PATCH|DELETE /v1/team/users[/:id[/keys[/:keyId]]]`.)

- A key looks like `sfa_<keyId>_<secret>`. The `keyId` is public (it names the key in lists and in the audit log); the secret is 256 random bits. The server stores only the **SHA-256 of the key** in `<dataDir>/team/users.json`. The key is shown **once**, in the answer that creates it, with `Cache-Control: no-store`; nothing afterwards can show it again. A lost key is revoked and replaced.
- A person can have up to 10 active keys (one per machine or tool). Keys can expire.
- Use the key as `Authorization: Bearer <key>`, in the CLI's `.env` (`SCRAPFORAI_API_KEY=`), in the MCP server's `.env` (an agent should have its **own `runner` key**: then the audit log says what the agent did), or paste it in the web console's sign-in box.
- The web console signs in with the same key. The session **is the person**: their role is read again on every request, so a demotion, a disabled user or a revoked key is seen at once, not at the end of the session.
- **Team screen** (web console > Team, admins only): the same operations without the CLI. Reading (people, keys, the audit log, "verify the chain") uses your session; **every change asks for an admin API key**, typed in the box at the top of the screen and sent as a Bearer token, because a browser session alone can never create a person or a key. The key is held in the page's memory only: never stored, forgotten after 5 minutes without use, when you leave, or when the server rejects it. A new key is shown once, with a Copy button, and is wiped from the page when you hide it.
- Reserved ids: `root` (the `.env` key), `system`, `scheduler`, `anonymous`.

## Audit log

`<dataDir>/audit/audit.jsonl`, one line per event, never pruned by the server. `scrapforai audit [--user u] [--area credentials] [--method PUT] [--since ISO] [--limit N]`, `GET /v1/audit`.

Recorded: every **change** (non-GET) by a signed-in person (who, role, how, which key, from which address, method, path **without the query**, status, and the ids the answer created: `jobId`, `suiteRunId`, ... so "who ran what" leads to the evidence), sign-ins, failed sign-ins, refusals (`auth.denied`). Reads are not recorded.
**Never** recorded: request bodies, headers, query strings, keys, credential values.

Each line carries `seq`, `prev` and `hash` (a chain). `scrapforai audit verify` (`GET /v1/audit/verify`) walks it: a line that was **edited** or one **removed from the middle** is found (exit 1).

What the chain does **not** do: detect lines cut off the **end** of the file, or a file rewritten end to end by someone who owns the data directory. It is tamper-*evident* for honest operations, not a witness against the machine's owner. For that, copy the log off the host regularly (and note `lastSeq`/`lastHash` from `audit verify`).
Also: if a write fails (a full disk) the request still succeeds and `[audit]` is printed on stderr; that missing line is not visible in the chain. A flood of failed sign-ins is written at most 60 per minute.
Runs started by the **scheduler** are not requests and are not in this log (their history is the schedule's). Creating or editing the schedule is.

## Deploying on an always-on host

```
cp .env.example .env        # SCRAPFORAI_API_KEY (strong, random), ALLOWED_TARGET_ORIGINS, SCRAPFORAI_VAULT_KEY (recommended), ...
export SCRAPFORAI_DOMAIN=scrap.example.com
docker compose -f docker-compose.team.yml up -d --build
```

`docker-compose.team.yml` runs the API (not published) behind Caddy (`deploy/Caddyfile`, automatic HTTPS). Why each choice:

- **TLS in front, API not published:** a key crosses the network with every request. `TRUST_PROXY=1` makes the audit log and the rate limits use the client's address and gives the session cookie `Secure`. Set `TRUST_PROXY` only when a proxy really is in front.
- **`env_file: .env`:** every setting of `.env.example` applies; the compose file only pins what a container needs (listen on `0.0.0.0`, the data volume, production).
- **One named volume** for the data directory: credential vault, `users.json`, `audit/`, evidence, signing key, schedules. Back it up. Keep `SCRAPFORAI_VAULT_KEY` **outside** that volume, or the vault key sits next to what it protects.
- `HEALTHCHECK` in the `Dockerfile`; `init: true` and `shm_size: 1gb` because Chromium needs them in a container.
- Turn on the scheduler (`SCHEDULER_ENABLED=true`, the default in this file) only if somebody has schedules: it is the reason to have a host that stays on.

### Brought up for real (2026-11-10)

`docker-compose.team.yml` was built and started from a clean checkout with a throwaway `.env` (Docker 29.9.2 on Windows 11, Docker Desktop, image `mcr.microsoft.com/playwright:v1.60.0-noble`, `caddy:2`; the first build took about 35 minutes, almost all of it pulling the Playwright image). What was observed:

- Both containers start; the app reports `healthy` through the `Dockerfile` `HEALTHCHECK`; `docker port` shows **nothing published** for the API, only Caddy's 80 and 443.
- Caddy obtained a certificate for `localhost` from its **internal** CA (so a browser or CLI must trust Caddy's local CA, as the `Caddyfile` comment says) and answers over TLS with `Strict-Transport-Security` and no `Server` header.
- Without a key the API answers 401; with the `.env` key, 200. A user created over the API got a key shown once; signing in with it set `sfa_session` with `HttpOnly; SameSite=Strict; Secure`.
- A `runner` is refused (403) on `/v1/team/users` and `/v1/audit`; a cookie-authenticated `POST` without the UI header is refused (`CsrfProtection`), a Bearer one is accepted.
- **Chromium runs inside the container:** a five-step run (open, assert, click, assert, screenshot) against a page served by the host passed in about 1.3 s, with the target allowlisted as `http://host.docker.internal:<port>`.
- The audit log recorded the denials and the run with the user and the `jobId`; `audit verify` was `ok`. After `docker restart` of the app container the user's key still worked and the chain still verified (the data volume held `users.json` and `audit/`).
- The address in the audit log was `172.18.0.1`, the Docker network gateway: on Docker Desktop for Windows the client's real address is NATed before it reaches Caddy, so this says nothing about the proxy setting. On a Linux host with a published port Caddy sees the real address.

**Not checked:** a public domain with a real certificate (Let's Encrypt), a Linux host, upgrading a running deployment, backup and restore of the volume.

**Runs as `root`:** the container's process is `uid=0`, the default of the Playwright image, and Playwright starts Chromium without its sandbox by default. The pages it opens are the ones in `ALLOWED_TARGET_ORIGINS` (your own dev and test sites), and the container holds only the data volume, but a browser exploit on one of those pages would run as root inside the container. Playwright's guidance for untrusted pages is the image's `pwuser` plus its seccomp profile; that is not done here because a volume written by an earlier root deployment would stop being writable. Keep `ALLOWED_TARGET_ORIGINS` to sites you control.

## Who may use a credential set

By default any `runner` can start a run that types any credential set. To limit a set, an admin gives it a list of user ids: in the Credentials screen ("Who may use it" → "Only the people listed"), or with `PUT /v1/credentials/<id>` and `"allowedUsers": ["ana", "ben"]` (admin key, like every change to the vault).

- **No list** (the default, and every set made before this existed): anyone who can run, as before. **A list**: those people, plus admins, plus scheduled runs. **An empty list** (`[]`): admins only. `null` on a PUT removes the restriction; **leaving `allowedUsers` out of a PUT keeps the stored list**, so editing an origin or a note never opens a restricted set.
- Every id must be a person of the team (`400 UnknownUser` otherwise), so a typo does not lock someone out silently.
- It is checked **where a run loads the set**, for the run's own set and for each actor's, whoever started it: a direct run, a routine, a suite, a permission matrix, a shrink, a differential, a snapshot, a manual build, a vault item. A person who is not on the list gets `403 CredentialSetForbidden` before any browser starts (for a background run, each variant records that error). The message does not say who may use the set. A suite or matrix keeps who started it for its whole life, so a queue is not a way in.
- **What people see:** everyone sees that a set exists, its origins and field names, and `restricted: true`; only an admin's read lists the people. Nobody ever reads a value: being on the list lets a person make a run type it, nothing more.
- **What it does not cover:** the MCP server and the CLI act with the installation key (`root`, an admin), so a person who reaches the API only through an AI agent started with that key is not limited, which is why that key must not be handed out. The sets that webhooks and integrations keep (`webhook-*`, `integration-*`) are created open; only an admin can write them and they can only be typed into the origin they are bound to, but restrict them too if a runner should not even be able to name them. A target profile has its own list (see "Limiting who may run through a target profile"); there is no rule per routine.
- The audit log records who changed a set (`PUT /v1/credentials/<id>`, with how many people are on the list, never the names or values).

### Limiting who may run through a target profile

A target profile can carry the same kind of list: `PUT /v1/targets/<id>` with `"allowedUsers": ["ana", "ben"]` (admin key). The rule is the same as for a set (no list = anyone who can run; a list = those people, admins and scheduled runs; `[]` = admins only; leaving it out of a PUT keeps the stored list; `null` removes it; ids must be people of the team). A person not on the list gets `403 TargetProfileForbidden` before any browser starts, and the message does not say who may. Everyone sees `restricted: true`; only an admin's read lists the people.

**What it does and does not do:** it restricts the use of the *profile*: its default address, its credential sets, its flags and its automatic login. It does **not** close the network: a run that gives `targetUrl` itself on an allowed origin does not name a profile, so a profile's list does not stop it. To protect a login, restrict the credential set (above); the allowed origins stay global (`ALLOWED_TARGET_ORIGINS`). There is no list on a routine: a routine version is immutable and a list inside it would be a new version for every change, and the set's list already guards every run that logs in.

## Limits to know before giving keys out

- **A `runner` can use any credential set that has no list of allowed users.** A set can be limited to some people (`allowedUsers`, see "Who may use a credential set" below), but every set made before that exists is open, and a new one is open until an admin restricts it. Values are never shown, and each set is bound to its origins.
- **A `viewer` can read evidence**: screenshots, reports, `vault/export`, signed evidence exports. Evidence is dev/QA data by design; if a run's screenshot is sensitive, `viewer` is too much.
- **No SSO, no passwords, no two-factor:** the key is the identity. Keys are long and random, there is no lockout beyond the rate limit on sign-in (10 per 15 minutes per address) and general limits.
- **Nobody can approve their own work:** not implemented (the roadmap's "four eyes" for sending a bug report or pinning is a decision for a person with an admin key, but one admin can do both).
- The installation key (`root`) is **not** a user: it cannot be disabled from the API (rotate it in `.env` and restart). Treat it as the break-glass key and use personal admin keys day to day.
- **Who started a run** is in the run itself since 2026-11-10: `startedBy` in `result.json` and the History screen's "Started by" column (also `GET /v1/runs?startedBy=<id>`), and the report's "Executed by". It is the person's id, `root` for the installation key, `system` for the scheduler; a run recorded before that has none. The audit log still has the same fact under the `jobId` and is the one nobody can edit without breaking the chain; the history is a convenience for reading.
- Not done: audit log rotation, signed audit entries, per-target roles, and the initiator in a suite's own report (each run of the suite has it).
