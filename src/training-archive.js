"use strict";

const encoder = new TextEncoder();

function asBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return encoder.encode(String(value ?? ""));
}

function writeU16(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
}

function writeU32(target, offset, value) {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}

let crcTable = null;
function ensureCrcTable() {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    crcTable[index] = value >>> 0;
  }
  return crcTable;
}

export function crc32(bytes) {
  const table = ensureCrcTable();
  let crc = 0xffffffff;
  for (const byte of asBytes(bytes)) crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getUTCFullYear());
  const dosTime = ((date.getUTCHours() & 0x1f) << 11)
    | ((date.getUTCMinutes() & 0x3f) << 5)
    | ((Math.floor(date.getUTCSeconds() / 2)) & 0x1f);
  const dosDate = (((year - 1980) & 0x7f) << 9)
    | (((date.getUTCMonth() + 1) & 0x0f) << 5)
    | (date.getUTCDate() & 0x1f);
  return {dosTime, dosDate};
}

function concat(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function createStoredZip(files, now = new Date()) {
  const locals = [];
  const centrals = [];
  let localOffset = 0;
  const {dosTime, dosDate} = dosDateTime(now);

  for (const file of files || []) {
    const name = asBytes(String(file?.name || "file.bin").replace(/^\/+/, ""));
    const data = asBytes(file?.data);
    const checksum = crc32(data);
    const flags = 0x0800;

    const localHeader = new Uint8Array(30 + name.length);
    writeU32(localHeader, 0, 0x04034b50);
    writeU16(localHeader, 4, 20);
    writeU16(localHeader, 6, flags);
    writeU16(localHeader, 8, 0);
    writeU16(localHeader, 10, dosTime);
    writeU16(localHeader, 12, dosDate);
    writeU32(localHeader, 14, checksum);
    writeU32(localHeader, 18, data.length);
    writeU32(localHeader, 22, data.length);
    writeU16(localHeader, 26, name.length);
    writeU16(localHeader, 28, 0);
    localHeader.set(name, 30);
    locals.push(localHeader, data);

    const centralHeader = new Uint8Array(46 + name.length);
    writeU32(centralHeader, 0, 0x02014b50);
    writeU16(centralHeader, 4, 20);
    writeU16(centralHeader, 6, 20);
    writeU16(centralHeader, 8, flags);
    writeU16(centralHeader, 10, 0);
    writeU16(centralHeader, 12, dosTime);
    writeU16(centralHeader, 14, dosDate);
    writeU32(centralHeader, 16, checksum);
    writeU32(centralHeader, 20, data.length);
    writeU32(centralHeader, 24, data.length);
    writeU16(centralHeader, 28, name.length);
    writeU16(centralHeader, 30, 0);
    writeU16(centralHeader, 32, 0);
    writeU16(centralHeader, 34, 0);
    writeU16(centralHeader, 36, 0);
    writeU32(centralHeader, 38, 0);
    writeU32(centralHeader, 42, localOffset);
    centralHeader.set(name, 46);
    centrals.push(centralHeader);
    localOffset += localHeader.length + data.length;
  }

  const centralDirectory = concat(centrals);
  const end = new Uint8Array(22);
  writeU32(end, 0, 0x06054b50);
  writeU16(end, 4, 0);
  writeU16(end, 6, 0);
  writeU16(end, 8, centrals.length);
  writeU16(end, 10, centrals.length);
  writeU32(end, 12, centralDirectory.length);
  writeU32(end, 16, localOffset);
  writeU16(end, 20, 0);
  return concat([...locals, centralDirectory, end]);
}
