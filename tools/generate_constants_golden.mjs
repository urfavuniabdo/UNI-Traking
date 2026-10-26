#!/usr/bin/env node
/*
 * generate_constants_golden.mjs
 *
 * Reads the single source of truth (packages/shared/src/constants.ts) and emits a
 * golden JSON file that the Flutter unit test
 * (apps/mobile/test/constants_golden_test.dart) compares `traccer_constants.dart` against.
 *
 * This keeps the Dart mirror honest WITHOUT requiring a Flutter/TS toolchain: we scrape the
 * literal values out of the TS with targeted regexes. When a value changes in constants.ts,
 * re-run this and the golden + Dart must both move, otherwise the test fails.
 *
 * Usage:   node D:/UNI Track/tools/generate_constants_golden.mjs
 * Output:  D:/UNI Track/packages/shared/golden/constants.json
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..'); // tools/ -> repo root
const tsPath = join(repoRoot, 'packages', 'shared', 'src', 'constants.ts');
const outPath = join(repoRoot, 'packages', 'shared', 'golden', 'constants.json');

const src = readFileSync(tsPath, 'utf8');

/** Grab the body of `export const NAME = { ... } as const;` */
function objectBody(name) {
  const re = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\}\\s*as const;`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`object export not found: ${name}`);
  return m[1];
}

/** Grab the body of a flat `export const NAME = [ ... ]` array.
 *  Stops at the first `]` so it does not overrun into later exports
 *  (some arrays are `as const;`, some are typed without `as const`). */
function arrayBody(name) {
  const re = new RegExp(`export const ${name}(?::[^=]*)?\\s*=\\s*\\[([\\s\\S]*?)\\]`, 'm');
  const m = re.exec(src);
  if (!m) throw new Error(`array export not found: ${name}`);
  return m[1];
}

function quotedValues(body) {
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

/** Comments are prose, not config: "net displacement: 1.4 m" must never reach the golden. */
function stripComments(body) {
  return body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** MOTION: every `KEY: number` */
function numericMap(rawBody) {
  const body = stripComments(rawBody);
  const out = {};
  for (const m of body.matchAll(/([A-Za-z0-9_]+):\s*(-?\d+(?:\.\d+)?)/g)) {
    out[m[1]] = Number(m[2]);
  }
  return out;
}

/** RULE_DEFAULTS: `Number(process.env.X ?? N)` or plain literal */
function ruleDefaults(rawBody) {
  const body = stripComments(rawBody);
  const out = {};
  const lines = body.split('\n');
  for (const line of lines) {
    const envMatch = /(\w+):\s*Number\(process\.env\.\w+\s*\?\?\s*(-?\d+(?:\.\d+)?)\)/.exec(line);
    if (envMatch) {
      out[envMatch[1]] = Number(envMatch[2]);
      continue;
    }
    const numMatch = /(\w+):\s*(-?\d+(?:\.\d+)?)/.exec(line);
    if (numMatch) out[numMatch[1]] = Number(numMatch[2]);
  }
  return out;
}

/** AR_ALERT_TEXT: `KEY: { title: '...', body: '...' }` */
function arAlertText() {
  const re = /export const AR_ALERT_TEXT[^=]*=\s*\{([\s\S]*?)\n\};/m;
  const m = re.exec(src);
  if (!m) throw new Error('AR_ALERT_TEXT not found');
  const body = m[1];
  const out = {};
  for (const entry of body.matchAll(/(\w+):\s*\{\s*title:\s*'([^']*)',\s*body:\s*'([^']*)'\s*\}/g)) {
    out[entry[1]] = { title: entry[2], body: entry[3] };
  }
  return out;
}

/** MOTION_STATE_AR: `STATE: '...'` */
function motionStateAr() {
  const re = /export const MOTION_STATE_AR[^=]*=\s*\{([\s\S]*?)\n\};/m;
  const m = re.exec(src);
  if (!m) throw new Error('MOTION_STATE_AR not found');
  const out = {};
  for (const entry of m[1].matchAll(/(\w+):\s*'([^']*)'/g)) out[entry[1]] = entry[2];
  return out;
}

const golden = {
  _source: 'packages/shared/src/constants.ts',
  _generator: 'tools/generate_constants_golden.mjs',
  MOTION: numericMap(objectBody('MOTION')),
  RULE_DEFAULTS: ruleDefaults(objectBody('RULE_DEFAULTS')),
  MOTION_STATES: quotedValues(arrayBody('MOTION_STATES')),
  ALERT_TYPES: quotedValues(arrayBody('ALERT_TYPES')),
  DRIVER_VISIBLE_ALERTS: quotedValues(arrayBody('DRIVER_VISIBLE_ALERTS')),
  GEO_EVENT_KINDS: quotedValues(arrayBody('GEO_EVENT_KINDS')),
  SEVERITY: quotedValues(objectBody('SEVERITY')),
  ROLES: quotedValues(objectBody('ROLES')),
  ATTENDANCE_STATUS: Object.values(stringMap(objectBody('ATTENDANCE_STATUS'))),
  AR_ALERT_TEXT: arAlertText(),
  MOTION_STATE_AR: motionStateAr(),
};

function stringMap(body) {
  const out = {};
  for (const m of body.matchAll(/(\w+):\s*'([^']*)'/g)) out[m[1]] = m[2];
  return out;
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(golden, null, 2) + '\n', 'utf8');
process.stdout.write(`wrote ${outPath}\n`);
