# samples/

Example scenarios (request bodies for `POST /v1/explorations/run`) go here.

Rules, enforced by `test/samples-hygiene.test.ts`:

- `credentials` hold placeholders such as `"<LOGIN_USER>"`, never a real value.
- Point at an example host (`https://dev.example.com/...`), not at a real system.

Reviewed, ready-to-adapt examples live in `templates/` (routines, target profiles) and `examples/`.
