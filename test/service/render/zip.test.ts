import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { randomBytes } from 'node:crypto';

import { createZip, crc32, ZipError } from '../../../src/service/zip.ts';
import { readZip } from './zip-reader.ts';

describe('zip writer', () => {
  test('crc32 matches the published check value for "123456789"', () => {
    // The canonical CRC-32/ISO-HDLC check value.
    assert.equal(crc32(Buffer.from('123456789', 'utf8')) >>> 0, 0xcbf43926);
    assert.equal(crc32(Buffer.alloc(0)) >>> 0, 0);
  });

  test('round-trips text and binary entries through the reader (deflate + store, CRC verified)', () => {
    const text = Buffer.from('<!doctype html><h1>hello ✓</h1>'.repeat(50), 'utf8'); // compressible → deflate
    const binary = randomBytes(5000); // incompressible → store
    const zip = createZip([
      { name: 'design/index.html', data: text },
      { name: 'design/assets/noise.bin', data: binary },
      { name: 'design/empty.txt', data: Buffer.alloc(0) },
    ]);
    const entries = readZip(zip);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['design/index.html', 'design/assets/noise.bin', 'design/empty.txt'],
    );
    assert.ok(entries[0]?.data.equals(text));
    assert.ok(entries[1]?.data.equals(binary));
    assert.equal(entries[2]?.data.length, 0);
    // Both methods must appear: the compressible file deflated, the random one stored.
    assert.equal(entries[0]?.method, 8);
    assert.equal(entries[1]?.method, 0);
  });

  test('UTF-8 names survive the round trip (flag bit 11)', () => {
    const zip = createZip([{ name: 'design/日本語 ✓.txt', data: Buffer.from('x', 'utf8') }]);
    assert.equal(readZip(zip)[0]?.name, 'design/日本語 ✓.txt');
  });

  test('duplicate and empty names are refused', () => {
    assert.throws(() => createZip([{ name: 'a.txt', data: Buffer.alloc(1) }, { name: 'a.txt', data: Buffer.alloc(1) }]), ZipError);
    assert.throws(() => createZip([{ name: '', data: Buffer.alloc(1) }]), ZipError);
  });

  test('an empty archive is a valid ZIP with zero entries', () => {
    assert.equal(readZip(createZip([])).length, 0);
  });

  // System-reader proof (SPEC §14 WP2: "ZIP opens with system unzip"): PowerShell's
  // Expand-Archive on Windows; Info-ZIP `unzip` on Linux/macOS, else `tar -xf` (bsdtar —
  // macOS's tar — reads zip; GNU tar does not, so a machine with neither skips with a reason).
  test('the system extractor opens the archive with identical contents', async (t) => {
    const text = '<!doctype html><h1>system unzip ✓</h1>';
    const zip = createZip([
      { name: 'design/index.html', data: Buffer.from(text, 'utf8') },
      { name: 'design/assets/notes.txt', data: Buffer.from('nested folder entry', 'utf8') },
    ]);
    const work = await mkdtemp(path.join(os.tmpdir(), 'dc-zip-sys-'));
    t.after(() => rm(work, { recursive: true, force: true }));
    const zipPath = path.join(work, 'out.zip');
    const outDir = path.join(work, 'out');
    await writeFile(zipPath, zip);

    let result: { status: number | null; stderr: string };
    if (process.platform === 'win32') {
      const ps = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${outDir}' -Force`],
        { encoding: 'utf8', timeout: 60_000 },
      );
      result = { status: ps.status, stderr: ps.stderr ?? '' };
      if (ps.status !== 0) return t.skip(`Expand-Archive unavailable on this machine: ${ps.stderr?.slice(0, 200)}`);
    } else {
      await mkdir(outDir, { recursive: true });
      const unzip = spawnSync('unzip', ['-q', '-o', zipPath, '-d', outDir], { encoding: 'utf8', timeout: 60_000 });
      if (unzip.error === undefined) {
        result = { status: unzip.status, stderr: unzip.stderr ?? '' };
      } else {
        const tar = spawnSync('tar', ['-xf', zipPath, '-C', outDir], { encoding: 'utf8', timeout: 60_000 });
        result = { status: tar.status, stderr: tar.stderr ?? '' };
        if (tar.status !== 0) return t.skip(`No system unzip reader available (no unzip; tar cannot read zip): ${tar.stderr?.slice(0, 200)}`);
      }
    }
    assert.equal(result.status, 0, result.stderr);
    const extractDir = outDir;
    const extracted = await readFile(path.join(extractDir, 'design', 'index.html'), 'utf8');
    assert.equal(extracted, text);
    const nested = await readFile(path.join(extractDir, 'design', 'assets', 'notes.txt'), 'utf8');
    assert.equal(nested, 'nested folder entry');
  });
});
