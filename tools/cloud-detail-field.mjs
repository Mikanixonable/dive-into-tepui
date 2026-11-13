// 雲の細部の道具が共有する、画像から線形輝度の場を作る読み取り。細部の比較・自己検査・箱の比較が
// 同じ定義で画像を読むよう、ここに置く。
import { cropField } from './gray-image.mjs';
import { decodePng } from './png.mjs';

// measureCloudDetail と同じ、計測に使う中央切り出しの一辺の上限 [px]。
export const MAX_CROP_PX = 512;

// sRGB の 1 チャンネル(0..255)を線形輝度(0..1)へ戻す。
function srgbToLinear(byte) {
  const c = byte / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

// PNG を線形輝度の場へ。Rec.601 ではなく Rec.709 の輝度係数 — 実写の真色画像の
// モニタ輝度として読むため(cloud-detail-selftest と同じ定義)。
export function linearLuminanceField(png) {
  const { width, height, channels, data } = decodePng(png);
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    if (channels === 1) {
      out[i] = srgbToLinear(data[i]);
    } else {
      const r = srgbToLinear(data[i * channels]);
      const g = srgbToLinear(data[i * channels + 1]);
      const b = srgbToLinear(data[i * channels + 2]);
      out[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }
  return { width, height, data: out };
}

// 計測と同じ、中央からの切り出し(measureCloudDetail と同じ一辺)。
export function centerCrop(field) {
  const limit = Math.min(MAX_CROP_PX, field.width, field.height);
  const n = 1 << Math.floor(Math.log2(limit));
  return cropField(field, Math.floor((field.width - n) / 2), Math.floor((field.height - n) / 2), n, n);
}
