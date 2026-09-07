// 雲のツール(cloud-lab-compare / cloud-lab-separate)が共有する、グレースケール画像
// (0..1 の Float32 場 {width, height, data})の入出力と切り出し。
import { decodePng, encodeGrayPng } from './png.mjs';

// 8bit・非インターレースの PNG(グレー/RGB/RGBA)の channel 番目(0 が R)を 0..1 の場で返す。
export function decodeChannelPng(png, channel) {
  const { width, height, channels, data } = decodePng(png);
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) out[i] = data[i * channels + channel] / 255;
  return { width, height, data: out };
}

// 8bit・非インターレースの PNG の R チャンネルを 0..1 の場で返す。
export function decodeRedPng(png) {
  return decodeChannelPng(png, 0);
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

// 正距円筒の場から、緯度 north..south・経度 west..east [°] の矩形を切り出す。経度は日付変更線を
// またがない範囲だけを受ける。
export function cropLatLonBox(field, north, south, west, east) {
  const x0 = Math.round(((west + 180) / 360) * field.width);
  const y0 = Math.round(((90 - north) / 180) * field.height);
  const w = Math.max(1, Math.round(((east + 180) / 360) * field.width) - x0);
  const h = Math.max(1, Math.round(((90 - south) / 180) * field.height) - y0);
  return cropField(field, x0, y0, w, h);
}
