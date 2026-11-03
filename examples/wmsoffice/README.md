# WmsOffice: first vault items (REG-216, REG-218)

Two NPDev ledger bugs turned into runnable regression proofs, **written and verified against a real WmsOffice
FinalApp** (JWT mode, fresh database) on 2026-11-03. They are the migration path for two of the seven items whose
ScrapForAI job ids had expired (see [../../docs/T2.5-MIGRATION-TRIAGE.md](../../docs/T2.5-MIGRATION-TRIAGE.md)).

| File | What it is |
|---|---|
| `target.json` | Target profile `wmsoffice-dev` (`http://localhost:8100`, credential set `wms-admin`) |
| `routines/wms-login.json` | Login through `login.html`. Included by the two routines below |
| `routines/reg-216.json` | "New" on the Movimento selection panel lands on `MovimentoWorkbench.html?id=new`, empty-shell editor rendered, no error banner |
| `routines/reg-218.json` | Pasting a two-line CSV and clicking "Importar Contagem (Parse)" fills the `linhas` grid (2 rows) with no `JAVA_SOURCE_OPERATION_NOT_BOUND` |
| `items/REG-216.json`, `items/REG-218.json` | Vault item definitions (no evidence: that is captured by the flows) |

## What was verified, and what was not

- Both routines passed against the real app, and each **fails** when the page is not what it expects (a missing button, a
  required error banner, an invalid CSV). `confirm-green` pinned a GREEN with a signed manifest; `evidence verify` and
  `vault run --impact` were green. All of it in a **temporary** ScrapForAI data directory, **not** in your real vault.
- **No RED was captured.** The bugs were fixed on 2026-09-19 and cannot be reproduced on a fixed build, so the items carry
  `redNotCapturedReason`. They prove "still fixed", not "it was broken". Count them accordingly toward G1.
- The REG-218 routine does not check the `divergente` flag of each row: grid cells are `<input>`s, which `assertTextContains`
  cannot read, and reading them needs `evaluate`. The bug (`NOT_BOUND`, empty grid) is caught by "2 rows" plus the review message.
- WMS-12 (login to seeded panels) is not here: it needs seeded data the ledger does not describe.

## Loading them into your real vault

Run from the ScrapForAI folder, with the server up and the key in `.env`. The password never goes in a file:

```powershell
$key = (Select-String -Path .env -Pattern '^SCRAPFORAI_API_KEY=(.+)$').Matches.Groups[1].Value
$h   = @{ Authorization = "Bearer $key" }
$u   = 'http://localhost:3000'
$pw  = Read-Host 'WmsOffice admin password' -MaskInput
$cred = @{ boundOrigins = @('http://localhost:8100'); values = @{ loginUser = 'admin'; loginPassword = $pw } } | ConvertTo-Json
Invoke-RestMethod -Method Put -Uri "$u/v1/credentials/wms-admin" -Headers $h -ContentType 'application/json' -Body $cred
Invoke-RestMethod -Method Put -Uri "$u/v1/targets/wmsoffice-dev" -Headers $h -ContentType 'application/json' -Body (Get-Content examples\wmsoffice\target.json -Raw)
foreach ($r in 'wms-login','reg-216','reg-218') {
  Invoke-RestMethod -Method Put -Uri "$u/v1/routines/$r" -Headers $h -ContentType 'application/json' -Body (Get-Content "examples\wmsoffice\routines\$r.json" -Raw)
}
foreach ($i in 'REG-216','REG-218') {
  Invoke-RestMethod -Method Put -Uri "$u/v1/vault/$i" -Headers $h -ContentType 'application/json' -Body (Get-Content "examples\wmsoffice\items\$i.json" -Raw)
  npm run cli -- vault confirm-green $i --build-id <the build of the app you are testing>
}
```

The items pin the routines at **version 1**, which is what a fresh library produces. If a routine already exists in your
library, the version will differ: edit `routine.version` in the item first. `confirm-green` runs the routine and pins
evidence only if it passes (`StillRed` leaves the item untouched).

## Running WmsOffice for this

The generated FinalApp needs JWT mode and an admin user; the launcher alone starts it in API-key mode, where the login page
answers `missing_api_key`.

1. Work on a **copy** of `NPDev\Build\generated-finalapps\wmsoffice\App` (the launcher writes logs and opens the H2 database there).
2. Environment before `_ops\Run-FinalApp.ps1`: `NPDEV_AUTH_MODE=jwt`, `NPDEV_AUTH_JWT_ISSUER`, `NPDEV_AUTH_JWT_AUDIENCE`,
   `NPDEV_AUTH_JWT_PUBLICKEYPATH` and `NPDEV_AUTH_JWT_PRIVATEKEYPATH` (the `wmsoffice-keys\` pair; a throwaway RSA pair is fine for local use).
3. On an empty database: `POST /api/auth/bootstrap-admin` with `{"username","displayName","password"}`. It works once per tenant.
4. `http://localhost:8100` must be in `ALLOWED_TARGET_ORIGINS` **and** `ALLOWED_RESOURCE_ORIGINS`.

## Lessons from writing these

- **A login gate must not match the login URL.** `login.html?next=%2Fnpdev-business-ui%2F...` already contains
  `npdev-business-ui`, so `waitForUrlContains` passed while the login had failed. The gate waits for the `#concept-Area` panel instead.
- **`$targetUrl` is a whole value.** It is `http://localhost:8100/` with the slash, so `"$targetUrl/path"` is refused. Use absolute URLs.
- **Credentials are matched on the origin of the `fill`**, so the set is bound to `http://localhost:8100` only.
- Browser-reported console errors (401 on `/api/me` and friends) are the shell's pre-login probes, not defects.
