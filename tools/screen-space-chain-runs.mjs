// 手順8-15の帯鎖の撮影物(runs/<run>/<ケース>/)の置き場・記録の読み出しと、符号付きの値の PNG 表示。
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { factorsLabelOf } from './screen-space-chain-factors.mjs';
import { HEIGHT, shotsDir, WIDTH } from './screen-space-lab.mjs';

export const OUTPUT = path.join(shotsDir, 'ssd-8-15-chain-metrics');
export const RUNS = path.join(OUTPUT, 'runs');
export const BASELINE_RUN = 'before-a';
export const SCAN_SCALE = 0.25;
export const SCAN_WIDTH = Math.round(WIDTH * SCAN_SCALE);
export const SCAN_HEIGHT = Math.round(HEIGHT * SCAN_SCALE);
export const SCAN_PIXELS = SCAN_WIDTH * SCAN_HEIGHT;

// metrics.json のあるケースを持つ run の名前。基準を先頭に、残りは名前順。
export function runLabels() {
  return readdirSync(RUNS, { withFileTypes: true })
    .filter((item) => item.isDirectory() && existsSync(path.join(RUNS, item.name, 'record.json')))
    .map((item) => item.name)
    .sort((a, b) => (a === BASELINE_RUN ? -1 : b === BASELINE_RUN ? 1 : a.localeCompare(b)));
}

export const sceneDirOf = (run, scene) => path.join(RUNS, run, scene);

// run のケース scene の metrics.json。無ければ null。
export function metricsOf(run, scene) {
  const file = path.join(sceneDirOf(run, scene), 'metrics.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
}

export const recordOf = (run) => JSON.parse(readFileSync(path.join(RUNS, run, 'record.json'), 'utf8'));

// run の帯座標の式。runs/<run>/label.txt があればその1行、無ければ記録から作る(因子を使わない run は距離だけの式)。
export function factorsLabelOfRun(run) {
  const file = path.join(RUNS, run, 'label.txt');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  const { tier, fixedFactors } = recordOf(run).conditions;
  return factorsLabelOf(tier, fixedFactors);
}

// 画素ごとに stride 成分の並び values の先頭 3 成分を、中間灰を 0 とする線形表示 0.5 + 0.5 × 値 / scale の RGB8 へ。
export function signedRgb(values, stride, scale) {
  const pixels = values.length / stride;
  const rgb = new Uint8Array(pixels * 3);
  for (let p = 0; p < pixels; p++) for (let c = 0; c < 3; c++) {
    rgb[p * 3 + c] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, values[p * stride + c] / scale)));
  }
  return rgb;
}

// 走査解像度の画素ごとに stride 成分の並びを signedRgb の写像で描いた PNG。
export const signedPng = (values, stride, scale) =>
  encodeRgbPng(SCAN_WIDTH, SCAN_HEIGHT, signedRgb(values, stride, scale));

// 非負の値 values の先頭 3 成分を、0 を黒、scale を白とする線形表示の PNG(走査解像度)。
export function unsignedPng(values, stride, scale) {
  const pixels = values.length / stride;
  const rgb = new Uint8Array(pixels * 3);
  for (let p = 0; p < pixels; p++) for (let c = 0; c < 3; c++) {
    rgb[p * 3 + c] = Math.round(255 * Math.max(0, Math.min(1, values[p * stride + c] / scale)));
  }
  return encodeRgbPng(SCAN_WIDTH, SCAN_HEIGHT, rgb);
}

export function escapeHtml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
