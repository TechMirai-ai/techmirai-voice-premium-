/**
 * Writes tools/vapi-test-suite/out/adaptation_splice.json: the caller-adaptation prompt delta, so
 * `build_suite.py --with-adaptation` can test this branch's prompt change on the transient targets
 * WITHOUT syncing the live assistants. Only the delta is spliced (one inserted section and three
 * reworded sentences/bullets); everything else stays exactly what is deployed. FREE: renders text
 * only, never calls Vapi.
 *
 *   npx tsx src/cli/renderAdaptationSplice.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { loadClient } from '../config/loadClient.js';
import { callerAdaptationSection } from '../vapi/promptExtraSections.js';

const CLIENT_ID = 'sakura-seikotsuin';
const OUT_DIR = path.join(process.cwd(), 'tools', 'vapi-test-suite', 'out');

const [section] = callerAdaptationSection(loadClient(CLIENT_ID));

mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  path.join(OUT_DIR, 'adaptation_splice.json'),
  JSON.stringify(
    {
      section,
      // Inserted before this heading (sections are joined with a blank line).
      insertBefore: '\n\nLeading the call:',
      // Each old string is the text the DEPLOYED prompt has today; each new string is this branch's.
      replacements: [
        {
          old: 'Go shorter for a caller who seems rushed or confused.',
          new: 'How to adapt to a rushed, confused or upset caller is set out under "Reading the caller" below.',
        },
        {
          old:
            "- Match the caller's pace through your wording. If they speak slowly, or ask you to repeat " +
            'something, use simpler words and shorter phrases and say the key point plainly. If they ' +
            'speak quickly and the call is going smoothly, stay brisk — do not slow down for no reason. ' +
            'When clarity and speed conflict, choose clarity.',
          new:
            "- Match the caller's pace through your wording; how to adapt to a rushed, confused or upset " +
            'caller is set out under "Reading the caller" below, and that section governs.',
        },
        {
          old:
            '- Caller in a hurry, outdoors, or struggling: if the caller says they are busy or driving, ' +
            'sounds rushed (short clipped answers), is somewhere noisy, or is having difficulty ' +
            'communicating, use shorter sentences, ask only the questions that are essential, and move ' +
            'the call toward its close faster than usual.',
          new:
            '- Caller in a hurry, outdoors, or struggling: handled by "Reading the caller" above — ' +
            'apply no separate shortened-call rule.',
        },
      ],
    },
    null,
    2,
  ),
);
process.stdout.write(`wrote adaptation_splice.json (${section?.length ?? 0} chars)\n`);
