// 雲のツール(cloud-lab-compare / cloud-lab-separate)が共有する、グレースケール画像
// (0..1 の Float32 場 {width, height, data})の入出力と切り出し。
import { decodePng, encodeGrayPng } from './png.mjs';

// 8bit・非インターレースの PNG(グレー/RGB/RGBA)の R チャンネルを 0..1 の場で返す。
export function decodeRedPng(png) {
  const { width, height, channels, data } = decodePng(png);
  const red = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) red[i] = data[i * channels] / 255;
  return { width, height, data: red };
}

// 0..1 の値を 8bit へ丸める。範囲の外は端で止める。
export function quantize(value) {
  return Math.round(Math.min(1, Math.max(0, value)) * 255);
}

// 場を 0..255 に量子化したグレースケール PNG のバイト列。
export function fieldToGrayPng(field) {
  return encodeGrayPng(field.width, field.height, Uint8Array.from(field.data, quantize));
}

// 場から (x0, y0) 起点の w × h を切り出す。
export function cropField(field, x0, y0, w, h) {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    out.set(field.data.subarray((y0 + y) * field.width + x0, (y0 + y) * field.width + x0 + w), y * w);
  }
  return { width: w, height: h, data: out };
}

