#!/usr/bin/env node
// Generates apps/api/prisma/schema.prisma from schema.base.prisma for the chosen provider.
// usage: node tools/gen-schema.mjs [sqlite|postgresql]
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const provider = (process.argv[2] || 'sqlite').toLowerCase();
const here = dirname(fileURLToPath(import.meta.url));
const base = join(here, '..', 'apps', 'api', 'prisma', 'schema.base.prisma');
const out = join(here, '..', 'apps', 'api', 'prisma', 'schema.prisma');

const url =
  provider === 'sqlite'
    ? 'env("DATABASE_URL")'
    : 'env("DATABASE_URL")';

const src = readFileSync(base, 'utf8').replace('__PROVIDER__', provider);
writeFileSync(out, src.replace(/url\s+=\s+env\("DATABASE_URL"\)/, `url      = ${url}`), 'utf8');
console.log(`schema.prisma generated for provider=${provider} → ${out}`);
