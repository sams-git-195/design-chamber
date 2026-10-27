// Minimal ZIP writer (docs/SPEC.md §9.5): local file headers + central directory + EOCD,
// deflate via node:zlib deflateRawSync, CRC-32 from a table, UTF-8 name flag, no zip64.
// New code, no dependency — the sizes Design Chamber exports (≤ 100 MB designs, files far
// below 4 GB) never need zip64; anything that would is refused instead of corrupted.

import { deflateRawSync } from 'node:zlib';

/** One entry of the archive. `name` uses `/` separators and is written as UTF-8. */
export type ZipEntry = { name: string; data: Uint8Array };

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
/** Version needed to extract: 2.0 (deflate). */
const VERSION_NEEDED = 20;
/** Version made by: 2.0, FAT/unknown host (0) — keeps `\` out of the semantics. */
const VERSION_MADE_BY = 20;
/** General purpose flag bit 11: names are UTF-8. */
const FLAG_UTF8 = 0x0800;
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const ZIP64_LIMIT = 0xffffffff;

const crcTable = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

/** CRC-32 (IEEE, as ZIP specifies) over `data`. */
export const crc32 = (data: Uint8Array): number => {
  let crc = -1;
  for (let i = 0; i < data.length; i += 1) crc = (crc >>> 8) ^ (crcTable[(crc ^ (data[i] ?? 0)) & 0xff] ?? 0);
  return (crc ^ -1) >>> 0;
};

/** MS-DOS time/date pair for a timestamp (ZIP has no timezone; local time is conventional). */
const dosDateTime = (date: Date): { time: number; day: number } => {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
};

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipError';
  }
}

/**
 * Build the archive bytes. Entries are written in the given order; a duplicate or empty
 * name, or anything needing zip64, throws `ZipError` instead of producing a bad archive.
 */
export const createZip = (entries: readonly ZipEntry[], now: Date = new Date()): Buffer => {
  const { time, day } = dosDateTime(now);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  const seen = new Set<string>();
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    if (entry.name.length === 0 || seen.has(entry.name)) throw new ZipError(`Bad or duplicate ZIP entry name: "${entry.name}".`);
    seen.add(entry.name);

    const crc = crc32(entry.data);
    const deflated = deflateRawSync(Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength), { level: 9 });
    const useDeflate = deflated.length < entry.data.length;
    const payload = useDeflate ? deflated : Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength);
    const method = useDeflate ? METHOD_DEFLATE : METHOD_STORE;
    if (payload.length > ZIP64_LIMIT || entry.data.length > ZIP64_LIMIT || offset > ZIP64_LIMIT) {
      throw new ZipError('This export is too large for a ZIP without zip64, which Design Chamber does not write.');
    }

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(FLAG_UTF8, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, Buffer.from(payload));

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE(VERSION_MADE_BY, 4);
    central.writeUInt16LE(VERSION_NEEDED, 6);
    central.writeUInt16LE(FLAG_UTF8, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    // extra (30), comment (32), disk (34), internal attrs (36), external attrs (38) stay 0.
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + payload.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  if (centralSize > ZIP64_LIMIT || offset > ZIP64_LIMIT) throw new ZipError('This export is too large for a ZIP without zip64.');
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  // disk numbers (4, 6) stay 0.
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, ...centrals, eocd]);
};
