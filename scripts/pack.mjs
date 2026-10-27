// Release zip for "Settings → Extensions → Add from zip" (docs/SPEC.md §5):
// package.json, dist/, rules/, LICENSE, README.md at the zip root → design-chamber-<version>.zip.
// One zip for every OS: dist/ is plain JS (IIFE guests + the ESM service OpenChamber runs with
// its own Node), names are `/`-separated and sorted, OS cruft is left out.
// Run `npm run build` first. Publishing the zip anywhere is owner-gated.
//
// Minimal zip writer (deflate, CRC-32 from node:zlib, UTF-8 names, no zip64). When the
// service's zip writer (src/service/zip.ts, WP2) lands, this script can import it instead.
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INCLUDE = ['package.json', 'dist', 'rules', 'LICENSE', 'README.md'];

// Desktop cruft a macOS or Windows checkout may hold; never part of the extension.
const OS_CRUFT = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

const exists = (file) => stat(file).then(() => true, () => false);

// Answers `/`-separated names whatever the OS, so the zip is the same from Windows, macOS or Linux.
const walk = async (relative) => {
  const absolute = path.join(root, ...relative.split('/'));
  if (!(await stat(absolute)).isDirectory()) return [relative];
  const entries = (await readdir(absolute, { withFileTypes: true })).filter((entry) => !OS_CRUFT.has(entry.name));
  const nested = await Promise.all(entries.map((entry) => walk(`${relative}/${entry.name}`)));
  return nested.flat();
};

for (const required of INCLUDE) {
  if (!(await exists(path.join(root, required)))) {
    throw new Error(`pack: ${required} is missing${required === 'dist' ? ' — run `npm run build` first' : ''}.`);
  }
}
for (const entry of ['dist/panel/main.js', 'dist/background/main.js', 'dist/service/main.js']) {
  if (!(await exists(path.join(root, entry)))) throw new Error(`pack: ${entry} is missing — run \`npm run build\` first.`);
}

const files = (await Promise.all(INCLUDE.map(walk))).flat().sort();
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));

// DOS date/time for "now" (zip has no time zone).
const now = new Date();
const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

const locals = [];
const centrals = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(file, 'utf8');
  const data = await readFile(path.join(root, ...file.split('/')));
  const packed = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(dosTime, 10);
  local.writeUInt16LE(dosDate, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(packed.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  locals.push(local, name, packed);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt16LE(dosTime, 12);
  central.writeUInt16LE(dosDate, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(packed.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(offset, 42);
  centrals.push(central, name);

  offset += local.length + name.length + packed.length;
}

const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralSize, 12);
end.writeUInt32LE(offset, 16);

const out = path.join(root, `design-chamber-${version}.zip`);
const zip = Buffer.concat([...locals, ...centrals, end]);
await writeFile(out, zip);
console.log(`packed ${files.length} files → ${path.relative(root, out)} (${(zip.length / 1024).toFixed(1)} kB)`);
