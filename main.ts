import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

// Standalone PNG encoder. Zlib screens every variant; custom DEFLATE tries two.
// Work limits are structural: 64 KiB blocks, 16 chain links, four match records,
// and at most two optimal-parse passes. No time-based decisions are made.
const BLOCK = 65536, CHAIN = 16, RECORDS = 4;
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const CHANNELS = [1, 0, 3, 1, 2, 0, 4];
const CRC = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let v = i;
  for (let k = 0; k < 8; k++) v = (v >>> 1) ^ ((v & 1) ? 0xedb88320 : 0);
  CRC[i] = v >>> 0;
}
function crc(bytes, from, to) {
  let v = -1;
  for (let i = from; i < to; i++) v = (v >>> 8) ^ CRC[(v ^ bytes[i]) & 255];
  return (v ^ -1) >>> 0;
}
function paeth(left, above, corner) {
  const x = above - corner, y = left - corner, z = x + y;
  const ax = x < 0 ? -x : x, ay = y < 0 ? -y : y, az = z < 0 ? -z : z;
  return ax <= ay && ax <= az ? left : ay <= az ? above : corner;
}
function decode(file) {
  if (file.length < 33 || !file.subarray(0, 8).equals(SIGNATURE)) throw Error('Bad PNG signature');
  let w = 0, h = 0, ct = -1, palette = null, transparency = null, ended = false;
  const pieces = [];
  for (let p = 8; p < file.length;) {
    if (p + 12 > file.length || ended) throw Error('Truncated PNG');
    const n = file.readUInt32BE(p), end = p + n + 8;
    if (end + 4 > file.length || crc(file, p + 4, end) !== file.readUInt32BE(end)) throw Error('Bad PNG CRC');
    const type = file.toString('ascii', p + 4, p + 8), bytes = file.subarray(p + 8, end);
    if (type === 'IHDR') {
      if (n !== 13 || w || bytes[8] !== 8 || !CHANNELS[bytes[9]] || bytes[10] || bytes[11] || bytes[12]) throw Error('Unsupported IHDR');
      w = bytes.readUInt32BE(0); h = bytes.readUInt32BE(4); ct = bytes[9];
    } else if (type === 'PLTE') palette = bytes;
    else if (type === 'tRNS') transparency = bytes;
    else if (type === 'IDAT') pieces.push(bytes);
    else if (type === 'IEND') ended = true;
    else throw Error('Unsupported PNG chunk ' + type);
    p = end + 4;
  }
  if (!w || !h || !ended || !pieces.length) throw Error('Incomplete PNG');
  const bpp = CHANNELS[ct], stride = w * bpp;
  const raw = inflateSync(Buffer.concat(pieces), { maxOutputLength: h * (stride + 1) + 1 });
  if (raw.length !== h * (stride + 1)) throw Error('Incorrect inflated length');
  const samples = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    const off = y * stride, src = off + y + 1, ft = raw[src - 1];
    if (ft > 4) throw Error('Invalid filter');
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? samples[off + x - bpp] : 0;
      const b = y ? samples[off + x - stride] : 0;
      const c = y && x >= bpp ? samples[off + x - stride - bpp] : 0;
      let predictor = 0;
      if (ft === 1) predictor = a;
      else if (ft === 2) predictor = b;
      else if (ft === 3) predictor = (a + b) >>> 1;
      else if (ft === 4) predictor = paeth(a, b, c);
      samples[off + x] = raw[src + x] + predictor;
    }
  }
  const rgba = new Uint8Array(w * h * 4);
  const key = !transparency ? -1 : ct === 0 ? transparency[1] : (transparency[1] << 16) | (transparency[3] << 8) | transparency[5];
  for (let p = 0, q = 0; p < rgba.length; p += 4, q += bpp) {
    if (ct === 6) {
      rgba[p] = samples[q]; rgba[p + 1] = samples[q + 1]; rgba[p + 2] = samples[q + 2]; rgba[p + 3] = samples[q + 3];
    } else if (ct === 3) {
      const i = samples[q];
      if (!palette || i * 3 + 2 >= palette.length) throw Error('Invalid palette');
      rgba[p] = palette[i * 3]; rgba[p + 1] = palette[i * 3 + 1]; rgba[p + 2] = palette[i * 3 + 2];
      rgba[p + 3] = transparency && i < transparency.length ? transparency[i] : 255;
    } else if (ct === 2) {
      rgba[p] = samples[q]; rgba[p + 1] = samples[q + 1]; rgba[p + 2] = samples[q + 2];
      rgba[p + 3] = ((samples[q] << 16) | (samples[q + 1] << 8) | samples[q + 2]) === key ? 0 : 255;
    } else {
      rgba[p] = rgba[p + 1] = rgba[p + 2] = samples[q];
      rgba[p + 3] = ct === 4 ? samples[q + 1] : samples[q] === key ? 0 : 255;
    }
  }
  return { w, h, rgba };
}

function forms(rgba) {
  let grey = true, opaque = true, key = -1, keyOK = true, many = false;
  const colours = new Map();
  for (let p = 0; p < rgba.length; p += 4) {
    const r = rgba[p], g = rgba[p + 1], b = rgba[p + 2], a = rgba[p + 3];
    if (r !== g || g !== b) grey = false;
    if (a !== 255) {
      opaque = false;
      const rgb = (r << 16) | (g << 8) | b;
      if (a !== 0 || (key !== -1 && rgb !== key)) keyOK = false;
      key = rgb;
    }
    if (!many) {
      const word = (r | (g << 8) | (b << 16) | (a << 24)) >>> 0;
      const count = colours.get(word);
      if (count !== undefined) colours.set(word, count + 1);
      else if (colours.size < 256) colours.set(word, 1);
      else many = true;
    }
  }
  if (!opaque && keyOK) {
    for (let p = 0; p < rgba.length; p += 4) {
      if (rgba[p + 3] === 255 && ((rgba[p] << 16) | (rgba[p + 1] << 8) | rgba[p + 2]) === key) { keyOK = false; break; }
    }
  }
  const result = [];
  // Grey is measured independently, even if a palette is possible.
  if (grey || many) {
    const ct = grey ? (opaque || keyOK ? 0 : 4) : (opaque || keyOK ? 2 : 6);
    const bpp = CHANNELS[ct], data = ct === 6 ? rgba : new Uint8Array((rgba.length >>> 2) * bpp);
    if (ct !== 6) {
      for (let p = 0, q = 0; p < rgba.length; p += 4) {
        data[q++] = rgba[p];
        if (ct === 2) { data[q++] = rgba[p + 1]; data[q++] = rgba[p + 2]; }
        else if (ct === 4) data[q++] = rgba[p + 3];
      }
    }
    let trns = null;
    if (!opaque && keyOK) trns = ct === 0 ? Buffer.from([0, key & 255]) : Buffer.from([0, key >>> 16, 0, (key >>> 8) & 255, 0, key & 255]);
    result.push({ ct, bpp, data, plte: null, trns, name: 'channels' });
  }
  if (!many) {
    const entries = Array.from(colours, ([word, count]) => ({ word, count, r: word & 255, g: (word >>> 8) & 255, b: (word >>> 16) & 255, a: word >>> 24 }));
    let previousOrder = '';
    for (let order = 0; order < 2; order++) {
      const sorted = entries.slice().sort((a, b) => {
        const ta = a.a === 255 ? 1 : 0, tb = b.a === 255 ? 1 : 0;
        return ta - tb || (!ta && a.a - b.a) || (order ? b.count - a.count : 299 * (a.r - b.r) + 587 * (a.g - b.g) + 114 * (a.b - b.b)) || a.word - b.word;
      });
      const orderKey = sorted.map(e => e.word).join(',');
      if (orderKey === previousOrder) continue;
      previousOrder = orderKey;
      const lookup = new Map(), plte = Buffer.alloc(sorted.length * 3);
      let lastAlpha = 0;
      for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i]; lookup.set(e.word, i);
        plte[i * 3] = e.r; plte[i * 3 + 1] = e.g; plte[i * 3 + 2] = e.b;
        if (e.a !== 255) lastAlpha = i + 1;
      }
      const trns = lastAlpha ? Buffer.from(sorted.slice(0, lastAlpha).map(e => e.a)) : null;
      const data = new Uint8Array(rgba.length >>> 2);
      for (let p = 0, i = 0; p < rgba.length; p += 4, i++) data[i] = lookup.get((rgba[p] | (rgba[p + 1] << 8) | (rgba[p + 2] << 16) | (rgba[p + 3] << 24)) >>> 0);
      result.push({ ct: 3, bpp: 1, data, plte, trns, name: order ? 'palette-count' : 'palette-luminance' });
    }
  }
  return result;
}

// Compute all five fixed-filter images and the minsum image together.
function filterVariants(data, w, h, bpp) {
  const stride = w * bpp, size = (stride + 1) * h;
  const output = Array.from({ length: 7 }, () => new Uint8Array(size));
  const totals = new Float64Array(5);
  const pairSeen = Array.from({ length: 5 }, () => new Int32Array(65536));
  for (let y = 0; y < h; y++) {
    const start = y * stride, dst = y * (stride + 1), sums = new Float64Array(5);
    for (let t = 0; t < 5; t++) output[t][dst] = t;
    for (let x = 0; x < stride; x++) {
      const v = data[start + x], a = x >= bpp ? data[start + x - bpp] : 0;
      const b = y ? data[start + x - stride] : 0, c = y && x >= bpp ? data[start + x - stride - bpp] : 0;
      const f0 = v, f1 = (v - a) & 255, f2 = (v - b) & 255, f3 = (v - ((a + b) >>> 1)) & 255, f4 = (v - paeth(a, b, c)) & 255;
      const p = dst + x + 1;
      output[0][p] = f0; output[1][p] = f1; output[2][p] = f2; output[3][p] = f3; output[4][p] = f4;
      sums[0] += f0 < 128 ? f0 : 256 - f0; sums[1] += f1 < 128 ? f1 : 256 - f1;
      sums[2] += f2 < 128 ? f2 : 256 - f2; sums[3] += f3 < 128 ? f3 : 256 - f3; sums[4] += f4 < 128 ? f4 : 256 - f4;
    }
    let best = 0;
    for (let t = 0; t < 5; t++) { totals[t] += sums[t]; if (sums[t] < sums[best]) best = t; }
    output[5].set(output[best].subarray(dst, dst + stride + 1), dst);
    let fewest = 0x7fffffff, pairBest = 0;
    for (let t = 0; t < 5; t++) {
      const row = output[t], seen = pairSeen[t], stamp = y + 1;
      let pairs = 0;
      for (let p = dst + 2, end = dst + stride + 1; p < end; p++) {
        const pair = (row[p - 1] << 8) | row[p];
        if (seen[pair] !== stamp) { seen[pair] = stamp; pairs++; }
      }
      if (pairs < fewest) { fewest = pairs; pairBest = t; }
    }
    output[6].set(output[pairBest].subarray(dst, dst + stride + 1), dst);
  }
  const order = [0, 1, 2, 3, 4].sort((a, b) => totals[a] - totals[b] || a - b);
  return [{ data: output[5], name: 'minsum' }, { data: output[6], name: 'pairs' }, { data: lzFilters(output, stride + 1, h), name: 'lz-rows' }, ...order.map(t => ({ data: output[t], name: 'fixed-' + t }))];
}

// Screen the five row filters with the dictionary formed by the rows already
// chosen. Trial hash heads are stamped, so trials share the committed history
// without copying or modifying it. This extra variant is still deterministic.
function lzFilters(fixed, stride, rows) {
  const raw = new Uint8Array(stride * rows), history = new Int32Array(raw.length), stable = new Int32Array(65536).fill(-1);
  const trial = new Int32Array(65536), stamps = new Int32Array(65536);
  const literals = new Uint32Array(286), distances = new Uint32Array(30);
  let version = 0;
  for (let y = 0; y < rows; y++) {
    const start = y * stride, end = start + stride;
    let best = Infinity, choice = 0;
    for (let ft = 0; ft < 5; ft++) {
      raw.set(fixed[ft].subarray(start, end), start); version++;
      literals.fill(0); distances.fill(0);
      let extras = 0;
      for (let p = start; p < end;) {
        let length = 2, distance = 0;
        if (p + 2 < end) {
          const hash = ((raw[p] * 251 + raw[p + 1]) * 251 + raw[p + 2]) & 65535;
          let q = stamps[hash] === version ? trial[hash] : stable[hash];
          history[p] = q; stamps[hash] = version; trial[hash] = p;
          const floor = Math.max(0, p - 32768), limit = Math.min(258, end - p);
          for (let k = 0; q >= floor && q >= 0 && k < 16; k++, q = history[q]) {
            if (raw[p + length] !== raw[q + length] || raw[p] !== raw[q] || raw[p + 1] !== raw[q + 1] || raw[p + 2] !== raw[q + 2]) continue;
            let n = 3;
            while (n < limit && raw[p + n] === raw[q + n]) n++;
            if (n > length) { length = n; distance = p - q; if (n === limit) break; }
          }
        }
        if (distance) {
          const lc = LENGTH_CODE[length], dc = DIST_CODE[distance]; literals[257 + lc]++; distances[dc]++; extras += LENGTH_EXTRA[lc] + DIST_EXTRA[dc];
          const next = p + length;
          for (p++; p < next; p++) if (p + 2 < end) {
            const hash = ((raw[p] * 251 + raw[p + 1]) * 251 + raw[p + 2]) & 65535;
            history[p] = stamps[hash] === version ? trial[hash] : stable[hash]; stamps[hash] = version; trial[hash] = p;
          }
        } else literals[raw[p++]]++;
      }
      literals[256]++;
      const l = huffman(literals, 15), d = huffman(distances, 15), header = dynamicHeader(l, d);
      let bits = extras + header.bits;
      for (let c = 0; c < 286; c++) bits += literals[c] * l[c];
      for (let c = 0; c < 30; c++) bits += distances[c] * d[c];
      if (bits < best) { best = bits; choice = ft; }
    }
    raw.set(fixed[choice].subarray(start, end), start);
    for (let p = start; p + 2 < end; p++) {
      const hash = ((raw[p] * 251 + raw[p + 1]) * 251 + raw[p + 2]) & 65535;
      history[p] = stable[hash]; stable[hash] = p;
    }
  }
  return raw;
}

const LENGTH_BASE = new Uint16Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258]);
const LENGTH_EXTRA = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0]);
const DIST_BASE = new Uint16Array([1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577]);
const DIST_EXTRA = new Uint8Array([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13]);
const LENGTH_CODE = new Uint8Array(259), DIST_CODE = new Uint8Array(32769), LOG = new Uint8Array(257);
for (let c = 0; c < 29; c++) for (let n = LENGTH_BASE[c]; n <= (c === 28 ? 258 : LENGTH_BASE[c + 1] - 1); n++) LENGTH_CODE[n] = c;
for (let c = 0; c < 30; c++) for (let n = DIST_BASE[c]; n <= (c === 29 ? 32768 : DIST_BASE[c + 1] - 1); n++) DIST_CODE[n] = c;
for (let n = 2; n <= 256; n++) LOG[n] = LOG[n >>> 1] + 1;

// A deterministic Huffman tree, then an exact Kraft-space repair when limiting
// lengths. Assign the repaired lengths to symbols in ascending frequency order.
function huffman(freq, limit) {
  const n = freq.length, weights = new Float64Array(n * 2 + 1), parents = new Int32Array(n * 2 + 1);
  parents.fill(-1);
  const active = [];
  for (let s = 0; s < n; s++) if (freq[s]) { weights[s] = freq[s]; active.push(s); }
  const lengths = new Uint8Array(n);
  if (!active.length) { lengths[0] = 1; return lengths; }
  if (active.length === 1) { lengths[active[0]] = 1; return lengths; }
  const heap = active.slice();
  const less = (a, b) => weights[a] < weights[b] || (weights[a] === weights[b] && a < b);
  function down(i) {
    const node = heap[i];
    for (;;) {
      let j = i * 2 + 1;
      if (j >= heap.length) break;
      if (j + 1 < heap.length && less(heap[j + 1], heap[j])) j++;
      if (!less(heap[j], node)) break;
      heap[i] = heap[j]; i = j;
    }
    heap[i] = node;
  }
  for (let i = (heap.length >>> 1) - 1; i >= 0; i--) down(i);
  function pop() { const a = heap[0], b = heap.pop(); if (heap.length) { heap[0] = b; down(0); } return a; }
  function push(a) {
    let i = heap.length; heap.push(a);
    while (i) { const p = (i - 1) >>> 1; if (!less(a, heap[p])) break; heap[i] = heap[p]; i = p; }
    heap[i] = a;
  }
  let next = n;
  while (heap.length > 1) {
    const a = pop(), b = pop(); weights[next] = weights[a] + weights[b]; parents[a] = parents[b] = next; push(next++);
  }
  const counts = new Int32Array(limit + 1);
  let space = 0;
  for (const s of active) {
    let depth = 0;
    for (let p = s; parents[p] >= 0; p = parents[p]) depth++;
    const l = Math.min(depth, limit); counts[l]++; space += 1 << (limit - l);
  }
  // Each operation preserves the number of leaves and removes one unit of
  // excess occupancy at the deepest permitted level.
  let excess = space - (1 << limit);
  while (excess > 0) {
    let b = limit - 1;
    while (b > 0 && !counts[b]) b--;
    counts[b]--; counts[b + 1] += 2; counts[limit]--; excess--;
  }
  active.sort((a, b) => freq[a] - freq[b] || a - b);
  let at = 0;
  for (let l = limit; l >= 1; l--) for (let k = 0; k < counts[l]; k++) lengths[active[at++]] = l;
  return lengths;
}
function codesOf(lengths) {
  const count = new Uint16Array(16), next = new Uint16Array(16), code = new Uint16Array(lengths.length);
  for (let i = 0; i < lengths.length; i++) count[lengths[i]]++;
  let c = 0;
  for (let n = 1; n <= 15; n++) { c = (c + (n === 1 ? 0 : count[n - 1])) << 1; next[n] = c; }
  for (let i = 0; i < lengths.length; i++) if (lengths[i]) {
    const n = lengths[i]; let v = next[n]++, r = 0;
    for (let b = 0; b < n; b++) { r = (r << 1) | (v & 1); v >>>= 1; }
    code[i] = r;
  }
  return code;
}
const FIXED_L = new Uint8Array(288), FIXED_D = new Uint8Array(32).fill(5);
for (let i = 0; i < 288; i++) FIXED_L[i] = i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8;
const FIXED_L_CODE = codesOf(FIXED_L), FIXED_D_CODE = codesOf(FIXED_D);
const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function dynamicHeader(lit, dist) {
  let nl = 286, nd = 30;
  while (nl > 257 && !lit[nl - 1]) nl--;
  while (nd > 1 && !dist[nd - 1]) nd--;
  const all = new Uint8Array(nl + nd); all.set(lit.subarray(0, nl)); all.set(dist.subarray(0, nd), nl);
  const symbols = [], extras = [], frequencies = new Uint32Array(19);
  function put(s, e) { symbols.push(s); extras.push(e); frequencies[s]++; }
  for (let p = 0; p < all.length;) {
    const v = all[p]; let run = 1;
    while (p + run < all.length && all[p + run] === v) run++;
    p += run;
    if (!v) {
      while (run >= 11) { const n = Math.min(138, run); put(18, n - 11); run -= n; }
      if (run >= 3) { const n = Math.min(10, run); put(17, n - 3); run -= n; }
      while (run--) put(0, 0);
    } else {
      put(v, 0); run--;
      while (run >= 3) { const n = Math.min(6, run); put(16, n - 3); run -= n; }
      while (run--) put(v, 0);
    }
  }
  // The code-length alphabet must be complete, including the degenerate case.
  let used = 0;
  for (const f of frequencies) if (f) used++;
  if (used === 1) for (let s = 0; s < 19; s++) if (!frequencies[s]) { frequencies[s] = 1; break; }
  const lengths = huffman(frequencies, 7), codes = codesOf(lengths);
  let nc = 19;
  while (nc > 4 && !lengths[CL_ORDER[nc - 1]]) nc--;
  let bits = 14 + nc * 3;
  for (const s of symbols) bits += lengths[s] + (s === 16 ? 2 : s === 17 ? 3 : s === 18 ? 7 : 0);
  return { nl, nd, nc, symbols, extras, lengths, codes, bits };
}
class BitWriter {
  constructor(size) { this.data = new Uint8Array(size); this.pos = 2; this.pending = 0; this.bits = 0; this.data[0] = 0x78; this.data[1] = 0x9c; }
  put(value, count) {
    this.pending |= value << this.bits; this.bits += count;
    while (this.bits >= 8) { this.data[this.pos++] = this.pending & 255; this.pending >>>= 8; this.bits -= 8; }
  }
  align() { if (this.bits) { this.data[this.pos++] = this.pending & 255; this.pending = 0; this.bits = 0; } }
}

// Reused scratch space keeps allocation independent of match count.
const head = new Int32Array(65536), prev = new Int32Array(BLOCK), ends = new Int32Array(32769);
const word = new Uint32Array(BLOCK), counts = new Uint8Array(BLOCK);
const matchLen = new Uint16Array(BLOCK * RECORDS), matchDist = new Uint16Array(BLOCK * RECORDS);
const backLen = new Uint16Array(BLOCK), backDist = new Uint16Array(BLOCK);
const cost = new Int32Array(BLOCK + 33), minimum = Array.from({ length: 6 }, () => new Float64Array(BLOCK + 33));
const PACK = 131072, INDEX_MASK = PACK - 1;
const lf = new Uint32Array(286), df = new Uint32Array(30);

function findMatches(bytes) {
  const n = bytes.length;
  head.fill(-1); ends.fill(0); counts.fill(0, 0, n);
  for (let p = 0; p + 3 < n; p++) word[p] = (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0;
  for (let p = 0; p + 2 < n; p++) {
    const hash = ((bytes[p] * 251 + bytes[p + 1]) * 251 + bytes[p + 2]) & 65535;
    let q = head[hash]; prev[p] = q; head[hash] = p;
    const limit = Math.min(258, n - p), floor = Math.max(0, p - 32768), base = p * RECORDS;
    let longest = 2, seen = 0, records = 0;
    while (q >= floor && q >= 0 && seen++ < CHAIN) {
      if (bytes[q + longest] === bytes[p + longest] && bytes[q] === bytes[p] && bytes[q + 1] === bytes[p + 1] && bytes[q + 2] === bytes[p + 2]) {
        const d = p - q;
        let len = Math.max(3, ends[d] - p);
        if (len > limit) len = limit;
        while (len + 4 <= limit && word[p + len] === word[q + len]) len += 4;
        while (len < limit && bytes[p + len] === bytes[q + len]) len++;
        ends[d] = p + len;
        if (len > longest) {
          if (records === RECORDS) {
            // Preserve the two nearest alternatives and the two longest ones.
            matchLen[base + 2] = matchLen[base + 3]; matchDist[base + 2] = matchDist[base + 3]; records--;
          }
          matchLen[base + records] = len; matchDist[base + records] = d; records++; longest = len;
          if (len === limit) break;
        }
      }
      q = prev[q];
    }
    counts[p] = records;
  }
}
function addMatch(len, distance) { lf[257 + LENGTH_CODE[len]]++; df[DIST_CODE[distance]]++; }
function lazyFrequencies(bytes) {
  lf.fill(0); df.fill(0);
  const n = bytes.length;
  for (let p = 0; p < n;) {
    const c = counts[p], at = p * RECORDS + c - 1, len = c ? matchLen[at] : 0;
    const nc = p + 1 < n ? counts[p + 1] : 0, next = nc ? matchLen[(p + 1) * RECORDS + nc - 1] : 0;
    if (len >= 3 && next <= len) { addMatch(len, matchDist[at]); p += len; }
    else lf[bytes[p++]]++;
  }
  lf[256] = 1;
}

// Shortest path over the bounded match alternatives. Keep the three longest
// length-code ranges of each hash-chain record, plus short matches. Sparse
// minima examine every prefix in each retained range in constant work.
function optimal(bytes, lit, dist) {
  const n = bytes.length, lc = new Int32Array(29), dc = new Int32Array(32769);
  for (let c = 0; c < 29; c++) lc[c] = (lit[c + 257] || 15) + LENGTH_EXTRA[c];
  for (let d = 1; d <= 32768; d++) dc[d] = (dist[DIST_CODE[d]] || 15) + DIST_EXTRA[DIST_CODE[d]];
  cost[n] = 0;
  for (let k = 0; k < 6; k++) minimum[k].fill(INDEX_MASK - n, n, n + 33);
  const m0 = minimum[0], m1 = minimum[1], m2 = minimum[2], m3 = minimum[3], m4 = minimum[4], m5 = minimum[5];
  for (let p = n - 1; p >= 0; p--) {
    let best = cost[p + 1] + (lit[bytes[p]] || 15), chosen = 1, distance = 0, cheaper = 0x3fffffff;
    const base = p * RECORDS, records = counts[p];
    for (let r = records - 1; r >= 0; r--) {
      const max = matchLen[base + r], d = matchDist[base + r], dbits = dc[d];
      if (dbits >= cheaper) continue;
      cheaper = dbits;
      const full = cost[p + max] + lc[LENGTH_CODE[max]] + dbits;
      if (full < best || (full === best && max > chosen)) { best = full; chosen = max; distance = d; }
      const last = LENGTH_CODE[max], first = Math.max(0, last - 2);
      for (let c = last; c >= first; c--) {
        const lo = p + LENGTH_BASE[c], hi = p + Math.min(max, c === 28 ? 258 : LENGTH_BASE[c + 1] - 1);
        const k = LOG[hi - lo + 1], table = minimum[k];
        const a = table[lo], b = table[hi - (1 << k) + 1], packed = a < b ? a : b;
        const v = Math.floor(packed / PACK) + lc[c] + dbits;
        if (v <= best) {
          const q = INDEX_MASK - (packed & INDEX_MASK);
          if (v < best || q - p > chosen) { best = v; chosen = q - p; distance = d; }
        }
      }
      if (first > 0) {
        const v = cost[p + 3] + lc[0] + dbits;
        if (v < best) { best = v; chosen = 3; distance = d; }
      }
    }
    cost[p] = best; backLen[p] = chosen; backDist[p] = distance;
    let packed = best * PACK + INDEX_MASK - p; m0[p] = packed;
    packed = Math.min(packed, m0[p + 1]); m1[p] = packed;
    packed = Math.min(packed, m1[p + 2]); m2[p] = packed;
    packed = Math.min(packed, m2[p + 4]); m3[p] = packed;
    packed = Math.min(packed, m3[p + 8]); m4[p] = packed;
    m5[p] = Math.min(packed, m4[p + 16]);
  }
  lf.fill(0); df.fill(0);
  for (let p = 0; p < n;) {
    const len = backLen[p];
    if (len === 1) lf[bytes[p]]++;
    else addMatch(len, backDist[p]);
    p += len;
  }
  lf[256] = 1;
}
function same(a, b) { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; }
function tokenBits(lit, dist) {
  let bits = 0;
  for (let i = 0; i < 286; i++) bits += lf[i] * (lit[i] + (i >= 257 ? LENGTH_EXTRA[i - 257] : 0));
  for (let i = 0; i < 30; i++) bits += df[i] * (dist[i] + DIST_EXTRA[i]);
  return bits;
}
function emitTokens(writer, bytes, lit, dist, litCode, distCode) {
  for (let p = 0; p < bytes.length;) {
    const len = backLen[p];
    if (len === 1) writer.put(litCode[bytes[p]], lit[bytes[p]]);
    else {
      const l = LENGTH_CODE[len], d = DIST_CODE[backDist[p]], sym = 257 + l;
      writer.put(litCode[sym], lit[sym]); writer.put(len - LENGTH_BASE[l], LENGTH_EXTRA[l]);
      writer.put(distCode[d], dist[d]); writer.put(backDist[p] - DIST_BASE[d], DIST_EXTRA[d]);
    }
    p += len;
  }
  writer.put(litCode[256], lit[256]);
}
function adler(bytes) {
  let a = 1, b = 0;
  for (let p = 0; p < bytes.length;) {
    const end = Math.min(p + 5552, bytes.length);
    while (p < end) { a += bytes[p++]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}
function deflate(raw, bound) {
  const writer = new BitWriter(raw.length + Math.ceil(raw.length / 65535) * 16 + 64);
  for (let start = 0; start < raw.length; start += BLOCK) {
    const bytes = raw.subarray(start, Math.min(start + BLOCK, raw.length)), final = start + bytes.length === raw.length ? 1 : 0;
    findMatches(bytes); lazyFrequencies(bytes);
    let lit = huffman(lf, 15), dist = huffman(df, 15);
    optimal(bytes, lit, dist);
    let nextLit = huffman(lf, 15), nextDist = huffman(df, 15);
    if (!same(lit, nextLit) || !same(dist, nextDist)) {
      lit = nextLit; dist = nextDist; optimal(bytes, lit, dist);
      nextLit = huffman(lf, 15); nextDist = huffman(df, 15);
    }
    lit = nextLit; dist = nextDist;
    const header = dynamicHeader(lit, dist), dynamicBits = 3 + header.bits + tokenBits(lit, dist), fixedBits = 3 + tokenBits(FIXED_L, FIXED_D);
    const storedBits = 3 + ((8 - ((writer.bits + 3) & 7)) & 7) + 32 + bytes.length * 8 + (bytes.length > 65535 ? 40 : 0);
    if (storedBits <= dynamicBits && storedBits <= fixedBits) {
      for (let p = 0; p < bytes.length; p += 65535) {
        const len = Math.min(65535, bytes.length - p);
        writer.put(final && p + len === bytes.length ? 1 : 0, 3); writer.align();
        writer.put(len, 16); writer.put((~len) & 65535, 16);
        writer.data.set(bytes.subarray(p, p + len), writer.pos); writer.pos += len;
      }
    } else if (fixedBits <= dynamicBits) {
      writer.put(final | 2, 3); emitTokens(writer, bytes, FIXED_L, FIXED_D, FIXED_L_CODE, FIXED_D_CODE);
    } else {
      writer.put(final | 4, 3); writer.put(header.nl - 257, 5); writer.put(header.nd - 1, 5); writer.put(header.nc - 4, 4);
      for (let i = 0; i < header.nc; i++) writer.put(header.lengths[CL_ORDER[i]], 3);
      for (let i = 0; i < header.symbols.length; i++) {
        const s = header.symbols[i]; writer.put(header.codes[s], header.lengths[s]);
        if (s >= 16) writer.put(header.extras[i], s === 16 ? 2 : s === 17 ? 3 : 7);
      }
      emitTokens(writer, bytes, lit, dist, codesOf(lit), codesOf(dist));
    }
    // Completed bytes can never disappear. This is a safe bound, not a filter
    // estimate: abort a candidate only after it cannot beat the incumbent file.
    if (writer.pos + 4 >= bound) return null;
  }
  writer.align();
  const checksum = adler(raw);
  writer.data[writer.pos++] = checksum >>> 24; writer.data[writer.pos++] = checksum >>> 16;
  writer.data[writer.pos++] = checksum >>> 8; writer.data[writer.pos++] = checksum;
  return writer.data.slice(0, writer.pos);
}
function chunk(type, bytes) {
  const out = Buffer.alloc(bytes.length + 12);
  out.writeUInt32BE(bytes.length, 0); out.write(type, 4, 4, 'ascii'); out.set(bytes, 8);
  out.writeUInt32BE(crc(out, 4, bytes.length + 8), bytes.length + 8);
  return out;
}
function encode(image) {
  const { w, h, rgba } = image;
  let best = null, bestSize = Infinity, bestForm = null, bestName = '', bestStream = 'zlib9';
  const screened = [], trials = [];
  for (const form of forms(rgba)) {
    const overhead = 57 + (form.plte ? form.plte.length + 12 : 0) + (form.trns ? form.trns.length + 12 : 0);
    const variants = filterVariants(form.data, w, h, form.bpp);
    const seen = [];
    for (const variant of variants) {
      const raw = variant.data;
      // Filter identities can coincide (especially one-row or constant images).
      let duplicate = false;
      for (const previous of seen) if (Buffer.from(raw.buffer, raw.byteOffset, raw.length).equals(Buffer.from(previous.buffer, previous.byteOffset, previous.length))) { duplicate = true; break; }
      if (duplicate) continue;
      seen.push(raw);
      const compressed = deflateSync(raw, { level: 9 });
      screened.push({ form, variant, overhead, compressed });
      if (compressed && compressed.length + overhead < bestSize) { best = compressed; bestSize = compressed.length + overhead; bestForm = form; bestName = form.name + '/' + variant.name; }
    }
  }
  screened.sort((a, b) => a.compressed.length - b.compressed.length);
  for (const candidate of screened.slice(0, 2)) {
    const { form, variant, overhead } = candidate, bound = bestSize - overhead;
    const custom = deflate(variant.data, bound);
    const customWins = custom !== null && custom.length < candidate.compressed.length;
    const compressed = customWins ? custom : candidate.compressed;
    trials.push(form.name + '/' + variant.name + ':custom=' + (custom ? custom.length : '>=' + bound) + ',zlib9=' + candidate.compressed.length);
    if (compressed.length + overhead < bestSize) {
      best = compressed; bestSize = compressed.length + overhead; bestForm = form;
      bestName = form.name + '/' + variant.name; bestStream = customWins ? 'custom' : 'zlib9';
    }
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(w, 0); header.writeUInt32BE(h, 4); header[8] = 8; header[9] = bestForm.ct;
  const pieces = [SIGNATURE, chunk('IHDR', header)];
  if (bestForm.plte) pieces.push(chunk('PLTE', bestForm.plte));
  if (bestForm.trns) pieces.push(chunk('tRNS', bestForm.trns));
  pieces.push(chunk('IDAT', best), chunk('IEND', Buffer.alloc(0)));
  return { png: Buffer.concat(pieces), name: bestName, stream: bestStream, trials };
}

function main() {
  // These two directory overrides are the only environment values read.
  const inputDir = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  mkdirSync(outputDir, { recursive: true });
  for (const entry of readdirSync(inputDir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    if (!entry.isDirectory()) continue;
    const image = decode(readFileSync(join(inputDir, entry.name, 'image.png')));
    const { png, name, stream, trials } = encode(image), destination = join(outputDir, entry.name);
    mkdirSync(destination, { recursive: true }); writeFileSync(join(destination, 'image.png'), png);
    console.log(entry.name + ' ' + png.length + ' ' + name + ' ' + stream + ' ' + trials.join(' '));
  }
}
if (process.argv[1] && /(?:^|\/)main\.ts$/.test(process.argv[1])) main();
export { decode, forms, filterVariants, deflate };
