// YC trim (2026-11-01): the legacy archive is intentionally excluded from
// the trimmed repository published for Y Combinator review. This file
// replaces the original archive-preservation checks with the trim contract:
// the excluded directories must be absent, and the migration provenance
// documents that describe the original import must still be present.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));

test('YC trim excludes the legacy archive, contracts, MCP server and mobile app', () => {
  for (const p of ['archive/', 'contracts/', 'tools/mcp-server/', 'apps/mobile/']) {
    assert.equal(fs.existsSync(path.join(root, p)), false, p);
  }
});

test('migration provenance documents remain present after the trim', () => {
  for (const p of ['docs/migration/import-manifest.json', 'docs/migration/source-provenance.json']) {
    assert.equal(fs.existsSync(path.join(root, p)), true, p);
    JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
  }
});
