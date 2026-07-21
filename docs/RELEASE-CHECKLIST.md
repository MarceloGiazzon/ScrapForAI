# Release checklist

## Pre-release
- [ ] `npm run typecheck` clean
- [ ] `npm test` green
- [ ] `npm run test:smoke` green
- [ ] Version bumped in package.json and ScrapForAI.iss
- [ ] README and user manual updated
- [ ] CHANGELOG entry written

## Security gate
- [ ] `.env` and `local-api-key.txt` are NOT in `git ls-files`
- [ ] No secret appears in `git log -p`
- [ ] Default `HOST` is `127.0.0.1`
- [ ] Default `ALLOW_EVALUATE` is `false`
- [ ] Unauthenticated `/v1/runs` returns 401
- [ ] Cookie-auth `PUT /v1/config` without `X-ScrapForAI-UI` returns 403
- [ ] Path traversal via `/v1/runs/:id/artifacts/..%2f..` returns 400/404
- [ ] No CSP violations in the browser console

## Build
- [ ] `.\installer\Build-Release.ps1 -Version x.y.z` succeeds
- [ ] Installer size is within ~50 MB of the previous release
- [ ] SHA256 recorded in release notes

## Clean-machine test
- [ ] All 10 checks in PRODUCTIZATION-PLAN.md T3.5 pass
- [ ] Results recorded in docs/INSTALL-TEST-RESULTS.md

## Publish
- [ ] Git tag `vX.Y.Z`
- [ ] Installer + SHA256 attached to the release
