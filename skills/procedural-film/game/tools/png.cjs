// png.cjs : PNG and ICO writing (and reading, for the gates) on node's zlib. No dependencies.
// docs/game-spec.md 12.4. Owner: P7.
//
//   const P = require('./png.cjs');
//   P.encode(w, h, rgba)            -> Buffer   8-bit RGBA, non-interlaced, filter chosen per row, deflate 9
//   P.decode(buf)                   -> { width, height, data }   8-bit RGBA/RGB/grey(+alpha)/palette, non-interlaced
//   P.info(buf)                     -> { width, height, bitDepth, colorType }   IHDR only
//   P.ico([{ size, png }])          -> Buffer   an ICO container with PNG payloads (Vista+ layout)
//   P.icoInfo(buf)                  -> [{ width, height, bytes, offset, png: info }]
//   P.canvas(w, h, rgba4)           -> { width, height, data }   a filled RGBA image
//   P.blit(dst, src, x, y, scale)   nearest-neighbour scale of src onto dst at (x, y); alpha 0 leaves dst
//   P.crc32(buf)
//
// The encoder is deterministic: the same pixels always give the same bytes.
'use strict';

const zlib = require('zlib');

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Encode 8-bit RGBA. Each row takes the filter with the smallest sum of absolute signed bytes. */
function encode(width, height, rgba) {
  width |= 0;
  height |= 0;
  if (width < 1 || height < 1) throw new Error(`png.encode: bad size ${width}x${height}`);
  const px = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength) : rgba);
  if (px.length !== width * height * 4) throw new Error(`png.encode: ${px.length} bytes for ${width}x${height} RGBA (want ${width * height * 4})`);
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  const zero = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const cur = px.subarray(y * stride, (y + 1) * stride);
    const up = y ? px.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0, bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const o = cand[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? cur[i - 4] : 0, b = up[i], c = i >= 4 ? up[i - 4] : 0;
        const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
        const v = (cur[i] - pred) & 255;
        o[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) {
        bestSum = sum;
        best = f;
      }
    }
    raw[y * (stride + 1)] = best;
    cand[best].copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function chunks(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) throw new Error('png: not a PNG (bad signature)');
  const out = [];
  let o = 8;
  while (o + 12 <= buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('ascii', o + 4, o + 8);
    if (o + 12 + len > buf.length) throw new Error(`png: chunk ${type} runs past the end`);
    const crc = buf.readUInt32BE(o + 8 + len);
    if (crc !== crc32(buf, o + 4, o + 8 + len)) throw new Error(`png: chunk ${type} has a bad CRC`);
    out.push({ type, data: buf.subarray(o + 8, o + 8 + len) });
    o += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

function info(buf) {
  const c = chunks(buf);
  if (!c.length || c[0].type !== 'IHDR') throw new Error('png: IHDR is not the first chunk');
  const d = c[0].data;
  return { width: d.readUInt32BE(0), height: d.readUInt32BE(4), bitDepth: d[8], colorType: d[9], interlace: d[12] };
}

/** Decode to RGBA (8-bit depth, non-interlaced; colour types 0, 2, 3, 4, 6). */
function decode(buf) {
  const c = chunks(buf);
  const hd = info(buf);
  const { width, height, bitDepth, colorType, interlace } = hd;
  if (bitDepth !== 8 || interlace !== 0) throw new Error(`png.decode: only 8-bit non-interlaced (got depth ${bitDepth}, interlace ${interlace})`);
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!chans) throw new Error(`png.decode: colour type ${colorType}`);
  const plte = c.find((x) => x.type === 'PLTE');
  const trns = c.find((x) => x.type === 'tRNS');
  const raw = zlib.inflateSync(Buffer.concat(c.filter((x) => x.type === 'IDAT').map((x) => x.data)));
  const stride = width * chans;
  if (raw.length !== (stride + 1) * height) throw new Error(`png.decode: ${raw.length} inflated bytes, want ${(stride + 1) * height}`);
  const lines = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const o = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= chans ? lines[o + i - chans] : 0;
      const b = y ? lines[o - stride + i] : 0;
      const cc = y && i >= chans ? lines[o - stride + i - chans] : 0;
      const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : f === 4 ? paeth(a, b, cc) : -1;
      if (pred < 0) throw new Error(`png.decode: filter ${f} on row ${y}`);
      lines[o + i] = (src[i] + pred) & 255;
    }
  }
  const data = Buffer.alloc(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    const s = p * chans, d = p * 4;
    if (colorType === 6) lines.copy(data, d, s, s + 4);
    else if (colorType === 2) {
      data[d] = lines[s];
      data[d + 1] = lines[s + 1];
      data[d + 2] = lines[s + 2];
      data[d + 3] = 255;
    } else if (colorType === 0 || colorType === 4) {
      data[d] = data[d + 1] = data[d + 2] = lines[s];
      data[d + 3] = colorType === 4 ? lines[s + 1] : 255;
    } else {
      const i = lines[s];
      data[d] = plte.data[i * 3];
      data[d + 1] = plte.data[i * 3 + 1];
      data[d + 2] = plte.data[i * 3 + 2];
      data[d + 3] = trns && i < trns.data.length ? trns.data[i] : 255;
    }
  }
  return { width, height, data };
}

/** An ICO file with PNG payloads: 6-byte header, 16-byte entries, then the PNGs in order. */
function ico(images) {
  if (!images.length) throw new Error('png.ico: no images');
  const head = Buffer.alloc(6 + 16 * images.length);
  head.writeUInt16LE(0, 0); // reserved
  head.writeUInt16LE(1, 2); // type 1: icon
  head.writeUInt16LE(images.length, 4);
  let offset = head.length;
  images.forEach((im, k) => {
    const hd = info(im.png);
    if (hd.width !== im.size || hd.height !== im.size) throw new Error(`png.ico: payload ${k} is ${hd.width}x${hd.height}, not ${im.size}`);
    if (im.size < 1 || im.size > 256) throw new Error(`png.ico: size ${im.size}`);
    const e = 6 + 16 * k;
    head[e] = im.size === 256 ? 0 : im.size;
    head[e + 1] = im.size === 256 ? 0 : im.size;
    head[e + 2] = 0; // no palette
    head[e + 3] = 0;
    head.writeUInt16LE(1, e + 4); // colour planes
    head.writeUInt16LE(32, e + 6); // bits per pixel
    head.writeUInt32LE(im.png.length, e + 8);
    head.writeUInt32LE(offset, e + 12);
    offset += im.png.length;
  });
  return Buffer.concat([head, ...images.map((im) => im.png)]);
}

function icoInfo(buf) {
  if (buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 1) throw new Error('ico: bad header');
  const n = buf.readUInt16LE(4);
  const out = [];
  for (let k = 0; k < n; k++) {
    const e = 6 + 16 * k;
    const bytes = buf.readUInt32LE(e + 8);
    const offset = buf.readUInt32LE(e + 12);
    const payload = buf.subarray(offset, offset + bytes);
    out.push({ width: buf[e] || 256, height: buf[e + 1] || 256, bpp: buf.readUInt16LE(e + 6), bytes, offset, png: info(payload), payload });
  }
  return out;
}

function canvas(width, height, rgba = [0, 0, 0, 0]) {
  const data = Buffer.alloc(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = rgba[0];
    data[i + 1] = rgba[1];
    data[i + 2] = rgba[2];
    data[i + 3] = rgba[3];
  }
  return { width, height, data };
}

function blit(dst, src, x0, y0, scale = 1) {
  for (let y = 0; y < src.height * scale; y++) {
    const dy = y0 + y;
    if (dy < 0 || dy >= dst.height) continue;
    for (let x = 0; x < src.width * scale; x++) {
      const dx = x0 + x;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (((y / scale) | 0) * src.width + ((x / scale) | 0)) * 4;
      if (src.data[s + 3] === 0) continue;
      const d = (dy * dst.width + dx) * 4;
      dst.data[d] = src.data[s];
      dst.data[d + 1] = src.data[s + 1];
      dst.data[d + 2] = src.data[s + 2];
      dst.data[d + 3] = src.data[s + 3];
    }
  }
  return dst;
}

module.exports = { encode, decode, info, ico, icoInfo, canvas, blit, crc32 };

// self-test: node tools/png.cjs
if (require.main === module) {
  const img = canvas(7, 5, [0x5c, 0x94, 0xfc, 255]);
  img.data[4 * 3] = 255;
  img.data[4 * 3 + 3] = 128;
  const a = encode(img.width, img.height, img.data);
  const b = decode(a);
  const same = b.width === 7 && b.height === 5 && Buffer.compare(b.data, img.data) === 0;
  const again = Buffer.compare(a, encode(img.width, img.height, img.data)) === 0;
  const sq = canvas(7, 7, [1, 2, 3, 255]);
  const i = ico([{ size: 7, png: encode(7, 7, sq.data) }]);
  const ii = icoInfo(i);
  console.log(`[${same ? 'PASS' : 'FAIL'}] round trip 7x5 RGBA`);
  console.log(`[${again ? 'PASS' : 'FAIL'}] deterministic bytes (${a.length} B)`);
  console.log(`[${ii.length === 1 && ii[0].width === 7 && ii[0].png.width === 7 ? 'PASS' : 'FAIL'}] ico container`);
  console.log(`crc32("IEND") = ${crc32(Buffer.from('IEND')).toString(16)} (want ae426082)`);
  process.exit(same && again && crc32(Buffer.from('IEND')) === 0xae426082 ? 0 : 1);
}
