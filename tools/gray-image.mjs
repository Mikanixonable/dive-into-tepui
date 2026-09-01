// 雲の統計・分離ツール(cloud-lab-compare / cloud-lab-separate)が共有する、グレースケール画像
// (0..1 の Float32 場 {width, height, data})の入出力と基本演算。
import { inflateSync } from 'node:zlib';
import { encodeGrayPng } from './png.mjs';

// 8bit・非インターレースの PNG(グレー/RGB/RGBA)の R チャンネルを 0..1 の場で返す。
// tools/png.mjs はグレーの復号しか持たず、撮影はキャンバス由来の RGBA を書くのでここで解く。
export function decodeRedPng(png) {
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
      channels = { 0: 1, 2: 3, 6: 4 }[body[9]];
      if (body[8] !== 8 || channels === undefined || body[12] !== 0) {
        throw new Error(`unsupported PNG: depth=${body[8]} colorType=${body[9]} interlace=${body[12]}`);
      }
    } else if (type === 'IDAT') idat.push(body);
    offset += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels + 1;
  const data = new Uint8Array(width * height * channels);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    const rowIn = y * stride + 1;
    const rowOut = y * width * channels;
    for (let i = 0; i < width * channels; i++) {
      const value = raw[rowIn + i];
      const left = i >= channels ? data[rowOut + i - channels] : 0;
      const up = y > 0 ? data[rowOut - width * channels + i] : 0;
      const upLeft = y > 0 && i >= channels ? data[rowOut - width * channels + i - channels] : 0;
      let predictor;
      if (filter === 0) predictor = 0;
      else if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
      } else throw new Error(`unknown PNG filter ${filter}`);
      data[rowOut + i] = (value + predictor) & 0xff;
    }
  }
  const red = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) red[i] = data[i * channels] / 255;
  return { width, height, data: red };
}

// 場を 0..255 に量子化したグレースケール PNG のバイト列。
export function fieldToGrayPng(field) {
  const bytes = Uint8Array.from(field.data, (v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
  return encodeGrayPng(field.width, field.height, bytes);
}

// 場から (x0, y0) 起点の w × h を切り出す。
export function cropField(field, x0, y0, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    out.set(field.data.subarray((y0 + y) * field.width + x0, (y0 + y) * field.width + x0 + w), y * w);
  }
  return { width: w, height: h, data: out };
}

// 半径 radius の箱ぼかしを縦横に 1 回ずつ。移動平均なので半径によらず O(画素数)。
// wrapX は経度の巻き付き(正距円筒)用で、縦と wrap しない横は端の値を伸ばす。
export function boxBlur(field, radius, wrapX) {
  const { width, height, data } = field;
  const n = 2 * radius + 1;
  const clampW = (x) => (wrapX ? (x + width * 4) % width : Math.min(width - 1, Math.max(0, x)));
  const tmp = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    let sum = 0;
    for (let dx = -radius; dx <= radius; dx++) sum += data[row + clampW(dx)];
    for (let x = 0; x < width; x++) {
      tmp[row + x] = sum / n;
      sum += data[row + clampW(x + 1 + radius)] - data[row + clampW(x - radius)];
    }
  }
  const clampH = (y) => Math.min(height - 1, Math.max(0, y));
  const out = new Float32Array(width * height);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let dy = -radius; dy <= radius; dy++) sum += tmp[clampH(dy) * width + x];
    for (let y = 0; y < height; y++) {
      out[y * width + x] = sum / n;
      sum += tmp[clampH(y + 1 + radius) * width + x] - tmp[clampH(y - radius) * width + x];
    }
  }
  return { width, height, data: out };
}
