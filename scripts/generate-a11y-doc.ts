import fs from 'node:fs';
import path from 'node:path';

import { renderMappingDoc } from '../src/a11y/mappingDoc.js';

// T7.7: writes docs/a11y-platform-mapping.md from src/a11y/platformGuidance.ts.
const target = path.resolve(import.meta.dirname, '..', 'docs', 'a11y-platform-mapping.md');
fs.writeFileSync(target, `${renderMappingDoc()}\n`);
console.log(`wrote ${target}`);
