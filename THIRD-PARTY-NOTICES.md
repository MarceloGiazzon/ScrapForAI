# Third-party notices

ScrapForAI itself is released under the MIT License (see `LICENSE` and `package.json`). It depends on the open-source packages listed in
`package-lock.json`, each under its own license, and ships them unmodified in `node_modules`. This file records the one whose license carries an
obligation that people who distribute ScrapForAI should know about.

## axe-core (accessibility audit, T7.4)

| | |
| --- | --- |
| Package | `axe-core`, pinned to an exact version in `package.json` (currently 4.14.0) |
| Copyright | Deque Systems, Inc. |
| License | Mozilla Public License 2.0 (MPL-2.0), <https://www.mozilla.org/MPL/2.0/> |
| Source | <https://github.com/dequelabs/axe-core> |
| Where it is | `node_modules/axe-core/` (with its own `LICENSE` and `LICENSE-3RD-PARTY.txt`) |

**How ScrapForAI uses it.** The server reads `node_modules/axe-core/axe.min.js` as it is and sends it to the page under test, whole and with its
copyright header, as part of one of its built-in scripts (`src/runner/trusted/scripts/axe.ts`). Nothing of axe-core is copied into this repository,
and no file of axe-core is modified. The registry (`src/runner/trusted/registry.ts`) pins the hash of what is sent, so a different axe-core version
only runs after a person has reviewed it and pinned the new hash.

**What this means when distributing ScrapForAI** (the portable ZIP and the installer run `npm ci --omit=dev`, so the package travels as it is):

- keep `node_modules/axe-core/` complete, with its license files and the header of `axe.min.js`: the header says it must appear in every copy;
- this notice file and the `LICENSE` of ScrapForAI are copied into the `docs` folder of the packages (the MIT License requires its notice in every copy);
- MPL-2.0 applies per file. Using axe-core unmodified does not put ScrapForAI's own files under the MPL, and does not stop them being MIT. **If you modify a file of axe-core and
  distribute it, you must make that modified file available under the MPL-2.0**, and a modified bundle also stops matching the pinned hash.

Decision D7 (2026-11-04, the project owner): adopt axe-core unmodified under these conditions. Decision T10.4 (2026-11-08, the project owner):
ScrapForAI itself is MIT-licensed; a price or a service model, if there is one, is not decided by this file. This note describes what the code
does; it is not legal advice.
