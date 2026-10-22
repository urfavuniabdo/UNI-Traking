#!/usr/bin/env node
// ينسخ مصدر الحقيقة الوحيد للثوابت إلى الـ API حتى لا نحتاج build-order أو workspaces.
// المصدر: packages/shared/src/constants.ts  →  apps/api/src/shared/constants.ts
// يُنفَّذ تلقائيًا عبر prestart/predev/prebuild/pretest، وأيضًا `npm run sync:shared`.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const src = join(root, 'packages', 'shared', 'src', 'constants.ts');
const outDir = join(root, 'apps', 'api', 'src', 'shared');
const out = join(outDir, 'constants.ts');

const body = readFileSync(src, 'utf8');
mkdirSync(outDir, { recursive: true });
writeFileSync(
  out,
  `/* AUTO-GENERATED من packages/shared/src/constants.ts بواسطة tools/gen-shared.mjs — لا تعدّله هنا. */\n${body}`,
  'utf8',
);
console.log(`shared constants synced → ${out}`);
