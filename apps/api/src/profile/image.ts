// Avatar image checks without decoding the picture: the type comes from the magic bytes (never from the client's
// Content-Type) and the size from the format header. The browser crops and re-encodes the picture to a square first.

export type AvatarMime = 'image/jpeg' | 'image/png' | 'image/webp';
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
export const AVATAR_MIN_SIDE = 64;
export const AVATAR_MAX_SIDE = 1024;

export interface ImageInfo {
  mime: AvatarMime;
  width: number;
  height: number;
}

function jpegSize(b: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return null;
}

function webpSize(b: Buffer): { width: number; height: number } | null {
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  return null;
}

/** The image type and size, or null for anything that is not a JPEG, PNG or WebP we can read the size of. */
export function inspectImage(b: Buffer): ImageInfo | null {
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.toString('ascii', 12, 16) === 'IHDR') {
    return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const s = jpegSize(b);
    return s ? { mime: 'image/jpeg', ...s } : null;
  }
  if (b.length >= 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const s = webpSize(b);
    return s ? { mime: 'image/webp', ...s } : null;
  }
  return null;
}

/** Why an upload is refused, or null when it is a square picture of an accepted type and size. */
export function avatarProblem(b: Buffer): 'too_large' | 'not_an_image' | 'not_square' | 'bad_size' | null {
  if (b.length > AVATAR_MAX_BYTES) return 'too_large';
  const info = inspectImage(b);
  if (!info) return 'not_an_image';
  if (info.width !== info.height) return 'not_square';
  if (info.width < AVATAR_MIN_SIDE || info.width > AVATAR_MAX_SIDE) return 'bad_size';
  return null;
}
