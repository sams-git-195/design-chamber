// A minimal ZIP reader for the writer's round-trip test: parses the central directory,
// inflates deflate entries and verifies every CRC-32. Test-only; never shipped.

import { inflateRawSync } from 'node:zlib';

import { crc32 } from '../../../src/service/zip.ts';

export type ReadZipEntry = { name: string; data: Buffer; method: number };

export class ZipReadError extends Error {}

const findEocd = (zip: Buffer): number => {
  // EOCD is 22 bytes without a comment; scan backwards for the signature.
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 65535); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) return i;
  }
  throw new ZipReadError('No end-of-central-directory record — not a ZIP.');
};

export const readZip = (zip: Buffer): ReadZipEntry[] => {
  const eocd = findEocd(zip);
  const count = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  const entries: ReadZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) throw new ZipReadError(`Bad central directory signature at entry ${i}.`);
    const method = zip.readUInt16LE(offset + 10);
    const crc = zip.readUInt32LE(offset + 16);
    const compSize = zip.readUInt32LE(offset + 20);
    const uncompSize = zip.readUInt32LE(offset + 24);
    const nameLen = zip.readUInt16LE(offset + 28);
    const extraLen = zip.readUInt16LE(offset + 30);
    const commentLen = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');

    if (zip.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipReadError(`Bad local header for ${name}.`);
    const localNameLen = zip.readUInt16LE(localOffset + 26);
    const localExtraLen = zip.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = zip.subarray(dataStart, dataStart + compSize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    if (data.length !== uncompSize) throw new ZipReadError(`Size mismatch for ${name}: ${data.length} != ${uncompSize}.`);
    if ((crc32(data) >>> 0) !== (crc >>> 0)) throw new ZipReadError(`CRC mismatch for ${name}.`);
    entries.push({ name, data, method });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
};
