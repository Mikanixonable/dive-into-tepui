// 生成ツールが読み書きする最小限の PNG コーデック(依存なし)。8bit・非インターレースの
// グレー / RGB / RGBA の復号と、8bit グレー / RGB の符号化を持つ。
import { crc32, deflateSync, inflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// IHDR の colorType ごとの、画素あたりの byte 数。
const CHANNELS_OF_COLOR_TYPE = { 0: 1, 2: 3, 6: 4 };

// 8bit・非インターレースの PNG(グレー/RGB/RGBA)を { width, height, channels, data } へ。
// data は行優先で、画素ごとに channels byte。それ以外の形式は投げる。
export function decodePng(png) {
  if (!png.subarray(0, 8).equals(SIGNATURE)) throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  let channels = 0;
  const idat = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      channels = CHANNELS_OF_COLOR_TYPE[body[9]];
      if (body[8] !== 8 || channels === undefined || body[12] !== 0) {
        throw new Error(`unsupported PNG: bitDepth=${body[8]} colorType=${body[9]} interlace=${body[12]}`);
      }
    } else if (type === 'IDAT') {
      idat.push(body);
    }
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels + 1;
  const data = new Uint8Array(width * height * channels);
  // 行ごとのフィルタを解く。左の画素は channels byte 前。
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    const rowIn = y * stride + 1;
    const rowOut = y * width * channels;
    for (let i = 0; i < width * channels; i++) {
      const left = i >= channels ? data[rowOut + i - channels] : 0;
      const up = y > 0 ? data[rowOut - width * channels + i] : 0;
      const upLeft = y > 0 && i >= channels ? data[rowOut - width * channels + i - channels] : 0;
      data[rowOut + i] = (raw[rowIn + i] + predict(filter, left, up, upLeft)) & 0xff;
    }
  }
  return { width, height, channels, data };
}

// 8bit グレースケールの PNG を { width, height, data } へ。グレー以外は投げる。
export function decodeGrayPng(png) {
  const { width, height, channels, data } = decodePng(png);
  if (channels !== 1) throw new Error(`not a grayscale PNG: channels=${channels}`);
  return { width, height, data };
}

// 行フィルタ filter(0..4)が、左・上・左上の画素から立てる予測値。
function predict(filter, left, up, upLeft) {
  switch (filter) {
    case 0: return 0;
    case 1: return left;
    case 2: return up;
    case 3: return (left + up) >> 1;
    case 4: return paeth(left, up, upLeft);
    default: throw new Error(`unknown PNG filter ${filter}`);
  }
}

// Paeth 予測子。a=左、b=上、c=左上のうち、a+b-c に最も近いものを返す。
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

// 行優先のグレースケール8bit 画素列(width × height byte)を PNG のバイト列へ。
export function encodeGrayPng(width, height, gray) {
  return encodePng(width, height, gray, 1, 0);
}

// 行優先の RGB8 画素列(width × height × 3 byte)を PNG のバイト列へ。
export function encodeRgbPng(width, height, rgb) {
  return encodePng(width, height, rgb, 3, 2);
}

// channels byte/画素の走査線を、colorType の PNG として符号化する。
function encodePng(width, height, pixels, channels, colorType) {
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = filterRow(pixels, y, stride, channels);
    raw[y * (stride + 1)] = row.filter;
    row.bytes.copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, colorType, 0, 0, 0], 8);
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 行 y を 5 通りの行フィルタで差分化し、絶対差の和が最小のものを選ぶ(PNG 標準の発見的手法)。
// 差分を取らないと、生成する場のような滑らかな画像でも deflate は隣接画素の相関を使えない。
function filterRow(pixels, y, stride, channels) {
  const current = pixels.subarray(y * stride, (y + 1) * stride);
  const previous = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
  let best = null;
  for (let filter = 0; filter < 5; filter++) {
    const bytes = Buffer.alloc(stride);
    let score = 0;
    for (let i = 0; i < stride; i++) {
      const left = i >= channels ? current[i - channels] : 0;
      const up = previous ? previous[i] : 0;
      const upLeft = previous && i >= channels ? previous[i - channels] : 0;
      const value = (current[i] - predict(filter, left, up, upLeft)) & 0xff;
      bytes[i] = value;
      // 符号付きの差分としての大きさ。0 の近くへ寄った行ほど deflate が縮められる。
      score += value < 128 ? value : 256 - value;
    }
    if (best === null || score < best.score) best = { filter, bytes, score };
  }
  return best;
}

// type(4 文字)と body から、長さと CRC を添えた 1 チャンクを組む。
function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body, crc32(head.subarray(4))) >>> 0, 0);
  return Buffer.concat([head, body, crc]);
}
