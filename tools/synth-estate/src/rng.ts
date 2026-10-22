// REQ-QA-001 — seeded pseudo-random source. xoshiro128** seeded through splitmix32, so the same
// seed always yields the same estate byte for byte. Every generator derives its own sub-stream
// with fork(label) so adding a CI type in one generator never reshuffles another.

const UINT32 = 0x1_0000_0000;
const HEX = '0123456789abcdef';

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** FNV-1a over UTF-16 code units; turns labels and string seeds into a 32-bit seed. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** splitmix32: expands one 32-bit seed into the four xoshiro state words. */
function splitmix32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  };
}

export class Rng {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(seed: number | string) {
    const numeric = typeof seed === 'number' ? Math.floor(seed) >>> 0 : hash32(seed);
    const mix = splitmix32(numeric);
    this.s0 = mix();
    this.s1 = mix();
    this.s2 = mix();
    this.s3 = mix();
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 1;
  }

  /** Next unsigned 32-bit integer. */
  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    return this.nextU32() / UINT32;
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** Uniform float in [min, max). */
  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** True with probability p. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('pick produced an out-of-range index');
    return item;
  }

  /** Picks an index by relative weight. */
  weighted(weights: readonly number[]): number {
    let total = 0;
    for (const w of weights) total += w;
    let roll = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      roll -= weights[i] ?? 0;
      if (roll < 0) return i;
    }
    return weights.length - 1;
  }

  /** In-place Fisher–Yates shuffle; returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const a = items[i];
      const b = items[j];
      if (a !== undefined && b !== undefined) {
        items[i] = b;
        items[j] = a;
      }
    }
    return items;
  }

  /** Lower-case hexadecimal string of the given length. */
  hex(length: number): string {
    let out = '';
    while (out.length < length) {
      let word = this.nextU32();
      for (let i = 0; i < 8 && out.length < length; i++) {
        out += HEX[word & 0xf] ?? '0';
        word >>>= 4;
      }
    }
    return out;
  }

  /** Upper-case alphanumeric string (serial numbers, asset tags, circuit ids). */
  alnum(length: number, alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789'): string {
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(this.next() * alphabet.length)] ?? 'A';
    return out;
  }

  /** RFC 4122 version 4 UUID drawn from this stream, so UUIDs are reproducible per seed. */
  uuid(): string {
    const h = this.hex(32).split('');
    h[12] = '4';
    h[16] = HEX[8 + (this.nextU32() & 0x3)] ?? '8';
    const s = h.join('');
    return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20, 32);
  }

  /** Unicast, locally-unique MAC address with the given OUI (three octets). */
  mac(oui: readonly [number, number, number]): string {
    const octets = [oui[0], oui[1], oui[2], this.int(0, 255), this.int(0, 255), this.int(0, 255)];
    return octets.map((o) => o.toString(16).padStart(2, '0')).join(':');
  }

  /** Independent sub-stream keyed by label; deterministic given this stream's seed. */
  fork(label: string): Rng {
    return new Rng((hash32(label) ^ this.nextU32()) >>> 0);
  }
}
