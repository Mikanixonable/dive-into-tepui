// 描画品質設定「テクスチャ解像度」の段が読む縮小版画像を src/assets へ生成する。
// 段ごとの幅の上限(中 4096 / 低 2048 px)より原寸が大きい画像だけ、<元の名前>-<幅>.<拡張子>
// を作る。データ画像(png)は色空間を変えずに画素値のまま縮小する。
//
// 天体の明るさの倍率(albedoScale・平均輝度)は原寸で測られているので、その画像については元画像と
// 縮小版の緯度重み付き線形平均の Rec.709 輝度を比べ、相対差が 1% を超えたら非 0 で終了する
// (正距円筒なので行ごとの重みは cos(緯度))。
import sharp from 'sharp';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const assetsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'assets');

// 段ごとの幅の上限 [px]。原寸と同じ幅になる段は縮小版を作らない。
const WIDTH_CAPS = [4096, 2048];
const JPEG_QUALITY = 90;
const LUMINANCE_TOLERANCE = 0.01;

// 縮小版を作る対象。data: true は色を持たない符号化済みデータ(png)。calibrated: true は、平均輝度から
// 天体の明るさの倍率を測った画像で、縮小版の平均輝度が 1% 以内に収まらなければならない。星野は
// 平均輝度に較正された量を持たず、暗い背景の 8 bit への丸めで数 % 動くので、差を出すだけにする。
const TARGETS = [
  { file: 'earth.jpg', data: false, calibrated: true },
  { file: '8k_stars.jpg', data: false, calibrated: false },
  { file: '8k_moon.jpg', data: false, calibrated: true },
  { file: 'earth-smoothness.png', data: true, calibrated: false },
  { file: 'cloud-field.png', data: true, calibrated: false },
];

// sRGB の 0..1 を線形へ戻す。
function srgbToLinear(value) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

// 線形の 0..1 を sRGB へ。
function linearToSrgb(value) {
  return value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055;
}

const SRGB_TO_LINEAR = Float32Array.from({ length: 256 }, (_, index) => srgbToLinear(index / 255));

// sRGB の色画像を、線形の光に戻した factor×factor 画素の箱平均で縮めた sharp を返す。箱平均は
// 線形の平均輝度を保つ — sRGB のまま平均すると、星のような孤立した明るい点が暗くなる。
async function downscaleSrgb(file, factor) {
  const { data, info } = await sharp(file).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  const outWidth = width / factor;
  const outHeight = height / factor;
  const out = Buffer.alloc(outWidth * outHeight * channels);
  const area = factor * factor;
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      for (let channel = 0; channel < channels; channel++) {
        let sum = 0;
        for (let dy = 0; dy < factor; dy++) {
          const row = (y * factor + dy) * width;
          for (let dx = 0; dx < factor; dx++) sum += SRGB_TO_LINEAR[data[(row + x * factor + dx) * channels + channel]];
        }
        out[(y * outWidth + x) * channels + channel] = Math.round(linearToSrgb(sum / area) * 255);
      }
    }
  }
  return sharp(out, { raw: { width: outWidth, height: outHeight, channels } });
}

// 画像の緯度重み付き(正距円筒:行ごとの重み cos(緯度))線形平均の Rec.709 輝度。
// sRGB 値は線形へ戻してから畳む。
async function weightedLuminance(file) {
  const { data, info } = await sharp(file).raw().toBuffer({ resolveWithObject: true });
  const { width, height, channels } = info;
  let numerator = 0;
  let denominator = 0;
  for (let y = 0; y < height; y++) {
    const latitude = Math.PI * (0.5 - (y + 0.5) / height);
    const weight = Math.cos(latitude);
    let row = 0;
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * channels;
      row += 0.2126 * srgbToLinear(data[offset] / 255)
        + 0.7152 * srgbToLinear(data[offset + 1] / 255)
        + 0.0722 * srgbToLinear(data[offset + 2] / 255);
    }
    numerator += weight * row / width;
    denominator += weight;
  }
  return numerator / denominator;
}

let failed = false;
for (const { file, data, calibrated } of TARGETS) {
  const sourcePath = path.join(assetsDir, file);
  const { width: sourceWidth } = await sharp(sourcePath).metadata();
  const stem = file.slice(0, file.lastIndexOf('.'));
  const extension = file.slice(file.lastIndexOf('.'));
  const sourceLuminance = data ? null : await weightedLuminance(sourcePath);
  for (const cap of WIDTH_CAPS) {
    if (cap >= sourceWidth) continue;
    const outPath = path.join(assetsDir, `${stem}-${cap}${extension}`);
    const resized = data
      ? sharp(sourcePath).resize(cap, null, { kernel: 'linear' })
      : await downscaleSrgb(sourcePath, sourceWidth / cap);
    await (extension === '.png' ? resized.png() : resized.jpeg({ quality: JPEG_QUALITY })).toFile(outPath);
    if (data) {
      console.log(`${file} -> ${stem}-${cap}${extension}`);
      continue;
    }
    const variantLuminance = await weightedLuminance(outPath);
    const relative = (variantLuminance - sourceLuminance) / sourceLuminance;
    console.log(
      `${file} -> ${stem}-${cap}${extension}: luminance ${sourceLuminance.toFixed(6)} ->`
      + ` ${variantLuminance.toFixed(6)} (${(relative * 100).toFixed(3)}%)`,
    );
    if (calibrated && Math.abs(relative) > LUMINANCE_TOLERANCE) {
      console.error(`${stem}-${cap}${extension}: 元画像との輝度の相対差が 1% を超えている`);
      failed = true;
    }
  }
}
if (failed) process.exit(1);
