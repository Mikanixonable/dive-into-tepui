// 映り込みのちらつきの表。render-lab:shot が撮った組の dir から、映り込みの乱数のタイルを読む位置だけを変えて撮った
// 撮影(<構図>-flicker-<k>。tools/render-lab/lab-case.ts の flickerShots)を構図ごとに読み、撮影どうしのあいだの表示の
// 揺れを表にする。読むのは PNG だけで、ブラウザは開かない。
//
// 使い方: node tools/render-lab-reflection-flicker.mjs <shots-dir>。dir は相対ならリポジトリ根から。
//
// 輝度は sRGB の 8bit の表示値を Rec.709 の重みで足した値(0..255)。揺れは撮影どうしのあいだの標準偏差で、2つ読む。
// - 画素の揺れ: 画素ごとの輝度の揺れ。1 px のディザも、塊の明滅も出る。
// - 塊の揺れ: BOX px 四方の箱で均した輝度の揺れ。箱は 1 px ずつずらした全位置で取る。1 px のディザは箱の画素数の
//   平方根ぶん均れてほとんど出ず、箱より大きな塊の明滅はそのまま出る。
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const USAGE = 'usage: node tools/render-lab-reflection-flicker.mjs <shots-dir>';

// 塊の揺れを測る箱の一辺 [px]。
const BOX = 8;
// 揺れとして数える標準偏差の下限 [8bit の輝度]。
const COUNT_THRESHOLD = 8;
// 揺れの分布の、表に出す上側の分位。
const PERCENTILE = 0.999;

const SHOT_NAME = /^(.+)-flicker-(\d+)\.png$/;

// 撮影 file の画素ごとの表示の輝度(0..255、行優先)と寸法。
function luminanceOf(dir, file) {
  const { width, height, channels, data } = decodePng(readFileSync(path.join(dir, file)));
  const luminance = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const p = i * channels;
    luminance[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  return { width, height, luminance };
}

// 画像 values(width × height、行優先)を BOX px 四方の箱で均した値。箱の左上が (x, y) の値を、
// (width − BOX + 1) × (height − BOX + 1) の行優先で返す。
function boxAveraged(values, width, height) {
  // 積分画像。(x, y) は左上の x × y 画素の和。
  const integral = new Float64Array((width + 1) * (height + 1));
  for (let y = 0; y < height; y++) {
    let row = 0;
    for (let x = 0; x < width; x++) {
      row += values[y * width + x];
      integral[(y + 1) * (width + 1) + x + 1] = integral[y * (width + 1) + x + 1] + row;
    }
  }
  const at = (u, v) => integral[v * (width + 1) + u];
  const outWidth = width - BOX + 1;
  const outHeight = height - BOX + 1;
  const averaged = new Float64Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    for (let x = 0; x < outWidth; x++) {
      const sum = at(x + BOX, y + BOX) - at(x, y + BOX) - at(x + BOX, y) + at(x, y);
      averaged[y * outWidth + x] = sum / (BOX * BOX);
    }
  }
  return averaged;
}

// 同じ長さの画像の列 images の、位置ごとの撮影どうしのあいだの標準偏差。
function deviationOf(images) {
  const count = images.length;
  const deviation = new Float64Array(images[0].length);
  for (let i = 0; i < deviation.length; i++) {
    let sum = 0;
    let squares = 0;
    for (const image of images) {
      sum += image[i];
      squares += image[i] * image[i];
    }
    const mean = sum / count;
    deviation[i] = Math.sqrt(Math.max(squares / count - mean * mean, 0));
  }
  return deviation;
}

// 揺れ deviation の最大・上側の分位・COUNT_THRESHOLD を超える位置の数。
function summaryOf(deviation) {
  const sorted = Float64Array.from(deviation).sort();
  const index = Math.min(sorted.length - 1, Math.floor(PERCENTILE * sorted.length));
  return {
    max: sorted[sorted.length - 1],
    percentile: sorted[index],
    over: deviation.reduce((count, value) => count + (value > COUNT_THRESHOLD ? 1 : 0), 0),
  };
}

function main() {
  const dirArgument = process.argv[2];
  if (dirArgument === undefined) throw new Error(USAGE);
  const dir = path.resolve(root, dirArgument);
  // 構図ごとの撮影のファイル名を、k の順に集める。
  const compositions = new Map();
  for (const file of readdirSync(dir)) {
    const match = SHOT_NAME.exec(file);
    if (match === null) continue;
    const files = compositions.get(match[1]) ?? [];
    files[Number(match[2])] = file;
    compositions.set(match[1], files);
  }
  if (compositions.size === 0) throw new Error(`no *-flicker-<k>.png in ${dir}`);

  const percentileLabel = `${(PERCENTILE * 100).toFixed(1)}%`;
  console.log(`\n| 構図 | 枚数 | 画素の揺れ 最大 | 画素 ${percentileLabel} | 画素 >${COUNT_THRESHOLD} の数 `
    + `| 塊の揺れ 最大 | 塊 ${percentileLabel} | 塊 >${COUNT_THRESHOLD} の数 |`);
  console.log('| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const [name, files] of [...compositions].sort(([a], [b]) => a.localeCompare(b))) {
    const shots = files.filter((file) => file !== undefined).map((file) => luminanceOf(dir, file));
    const { width, height } = shots[0];
    const pixel = summaryOf(deviationOf(shots.map((shot) => shot.luminance)));
    const block = summaryOf(deviationOf(shots.map((shot) => boxAveraged(shot.luminance, width, height))));
    const cells = [
      name, shots.length,
      pixel.max.toFixed(1), pixel.percentile.toFixed(1), pixel.over,
      block.max.toFixed(1), block.percentile.toFixed(1), block.over,
    ];
    console.log(`| ${cells.join(' | ')} |`);
  }
}

main();
