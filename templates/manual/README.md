# The living manual (T9.2)

A routine tagged `doc` is also a piece of documentation. Its steps carry a caption per language and may name an element to highlight;
`scrapforai manual build <target>` runs those routines, takes a figure for each documented step (a screenshot with the element circled in red) and
writes Markdown and HTML, in the languages you ask for, plus the list of **figures that changed since the last build**, so the person who writes the
manual reviews only those.

```jsonc
// on a step
"doc": {
  "caption": { "en": "Press Save.", "pt": "Pressione Salvar.", "es": "Pulse Guardar." },  // plain text, at least one language
  "highlight": "#save",                                                                  // optional: any selector the runner understands
  "when": "before",                                                                      // optional: before | after (default: before for click, fill, ... ; after for the rest)
  "fullPage": false                                                                      // optional: the whole page instead of the viewport
}
// on the routine: the chapter heading and introduction
"doc": { "title": { "en": "Saving an order" }, "intro": { "en": "How to ..." } }
```

Rules the server enforces: a step with `doc` needs an `id` (the figure is named after it); `doc` is not allowed in a `teardown` or inside a `parallel`
branch; a figure is never taken **after** a step that types a vault value (`valueFromCredential`), so a password or API key is never in a picture; a caption
that looks like a secret is refused when the routine is saved. `doc` does nothing in an ordinary run: figures are only taken for `manual build`
(`options.docFigures`, also `docFigures` on `POST /v1/routines/:id/run` to preview one routine: the figures are in the run's screenshots, named `doc-<step id>`).

## What a build does

- Runs every **active** routine of the target profile that is tagged `doc` (draft, quarantined and retired ones are listed as skipped), through the job queue,
  with the credential lock. Generated values use a fixed seed, so the same routine takes the same figure on every build.
- **All or nothing.** If any routine fails, or a `highlight` matches no visible element, NOTHING is written and the previous manual stays as it was. The
  error names the routine and the step. A manual with the new figures of the routines that passed and the old figure of the one that did not would look
  complete and be partly wrong.
- Writes `<MANUAL_OUTPUT_DIR>/<target>/` (default `<dataDir>/manual`): `manual.json` (build, figures with their hashes, what changed, captions missing in a
  language), `figures/<routine>/<step>.png`, and a folder per language with `index`, one page per routine (`.md`, `.html`) and `figures-changed.md`.
  A build removes only the files the previous `manual.json` listed; anything else you put in that folder stays.
- The HTML is one file per page: no script, CSP `default-src 'none'`, dark mode, images next to the pages (open it from disk or serve the folder).
- A caption that is not written in a requested language is shown in another one, **marked** ("no Spanish text yet; shown in English"), and listed in
  `manual.json`. The chapter heading falls back to the routine's own `title`.

## "Which figures changed?"

Each figure is described by its sha256 and by a small perceptual fingerprint: the picture reduced to a 32 x 32 grid of mean grey level. The new build is
compared with the previous `manual.json`, figure by figure (by `<routine>/<step id>`): **changed** (another size, or an area moved by 6 or more levels of 255),
**new**, **removed**, **differ slightly** (the bytes differ but no area moved: most likely rendering noise) and unchanged. `scrapforai manual build` prints
the list and `<lang>/figures-changed.md` keeps it. It is a review aid, not an image-diff product: a change of one character in a long line can land in
"differ slightly", which is why that group is listed instead of hidden.

**What makes a figure change for no reason.** A page that shows a clock, a counter, the list of recent runs or any data that moves will change on every
build. Build the manual against a **stable, seeded environment**, take the figure after a `setClock` with a fixed time when the page shows dates, and
prefer an element that does not move (`highlight` on a stable heading) over one inside live data. Run against the ScrapForAI console itself the History,
Health and Performance figures change on every build for exactly this reason: they show the runs of the builds before.

## The first client: ScrapForAI's own console

`templates/manual/scrapforai-console/` documents the web console: how to sign in (4 figures) and one figure for each screen (7). Everything is in the
three languages. It is **not** a template with placeholders: save it as it is.

```text
# 1. The console must be running with UI_ENABLED=true and its own origin in ALLOWED_TARGET_ORIGINS (and ALLOWED_RESOURCE_ORIGINS).
# 2. The target profile (change baseUrl if the console is not on port 3000) and the credential set that holds the API key (bearer only; the value is never read back):
PUT  /v1/targets/scrapforai-console       <- templates/manual/scrapforai-console/target.json
POST /v1/credentials/scrapforai-console   <- { "boundOrigins": ["http://127.0.0.1:3000"], "values": { "apiKey": "<the API key>" } }
# 3. The routines (one PUT each; the id is the file name without .routine.json):
PUT  /v1/routines/01-sign-in              <- templates/manual/scrapforai-console/01-sign-in.routine.json
PUT  /v1/routines/02-screens              <- templates/manual/scrapforai-console/02-screens.routine.json
# 4. Build (set MANUAL_OUTPUT_DIR to where the manual should live):
scrapforai manual build scrapforai-console --lang en,pt,es --build-id <version>
scrapforai manual show scrapforai-console
```

The API key is typed by the routine from the vault; the figure of that step is taken **before** it is typed (the field is empty in the picture) and the key
appears in no generated file (checked on a real build). The hand-written manual in `_userManual/` is not touched by any of this: the generated chapters
are figures and captions, not prose, and replacing the prose is a decision for whoever owns that manual.

## Not done

Building a subset of the routines (a build always writes the whole manual, so a subset would delete the other chapters), a schedule kind or an MCP tool
for it (a build starts browsers and writes files: it is a person's or a pipeline's decision), an arrow instead of a border, a figure per language (one set of
figures is shared by every language: the application under test is in one language), PDF output, localizing the routine `title`/`description` beyond
`doc.title` and `doc.intro`, and a web console screen.
