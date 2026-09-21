// 描画テスト環境の撮影の前後比較。before と after の撮影 dir を撮影名(PNG のファイル名)ごとに比べ、
// 変化画素数・最大差・変化の外接矩形を、同じコードで撮り直した dir 群(--envelope)の揺らぎの最大
// (封筒)と並べて表にする。封筒を超えて変わった撮影は、差を増幅した画像を
// <after の親>/compare-<after の名前>/ へ書く(書く前に作り直す)。dir は相対ならリポジトリ根から。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng, encodeRgbPng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const USAGE = 'usage: node tools/render-lab-compare.mjs <before-dir> <after-dir> [--envelope <dir> <dir> ...]';
// 差分画像で RGB の差の絶対値 [LSB] に掛ける倍率。255 で飽和する。
const DIFF_GAIN = 8;

// コマンドライン引数から before・after と封筒の dir 群(どれも絶対パス)を取る。形が合わなければ使い方を投げる。
function parseArgs(args) {
  const envelopeAt = args.includes('--envelope') ? args.indexOf('--envelope') : args.length;
  const compared = args.slice(0, envelopeAt);
  const envelopeDirs = args.slice(envelopeAt + 1);
  if (compared.length !== 2 || (envelopeAt < args.length && envelopeDirs.length < 2)) throw new Error(USAGE);
  const [before, after] = compared.map((dir) => path.resolve(root, dir));
  return { before, after, envelopeDirs: envelopeDirs.map((dir) => path.resolve(root, dir)) };
}

// dir にある撮影名(PNG のファイル名から拡張子を除いたもの)を名前順で返す。
function shotNamesIn(dir) {
  return readdirSync(dir).filter((file) => file.endsWith('.png')).map((file) => file.slice(0, -4)).sort();
}

// dir の撮影 name を decodePng の形で読み、読んだパスを file に添える。
function loadShot(dir, name) {
  const file = path.join(dir, `${name}.png`);
  return { file, ...decodePng(readFileSync(file)) };
}

// 同じ形の 2 枚の差。changed はどれかのチャンネルが 1 LSB 以上違う画素の数、maxDiff はチャンネルの差の
// 最大 [LSB]、box は変わった画素の外接矩形(両端を含む画素座標。変化が無ければ null)。形が違えば投げる。
function diffOf(a, b) {
  if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
    throw new Error(`${a.file} (${a.width}x${a.height}) と ${b.file} (${b.width}x${b.height}) の形が違う`);
  }
  let changed = 0;
  let maxDiff = 0;
  let x0 = a.width;
  let y0 = a.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      // 画素の差は、チャンネルの差の最大で測る。
      const p = (y * a.width + x) * a.channels;
      let pixelDiff = 0;
      for (let c = 0; c < a.channels; c++) pixelDiff = Math.max(pixelDiff, Math.abs(a.data[p + c] - b.data[p + c]));
      if (pixelDiff === 0) continue;
      changed++;
      maxDiff = Math.max(maxDiff, pixelDiff);
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  return { changed, maxDiff, box: changed === 0 ? null : { x0, y0, x1, y1 } };
}

// 撮影 name の封筒。envelopeDirs のうち name を持つ dir の全ての組の差から、変化画素数と最大差をそれぞれ
// 最大で取る。組が無ければどちらも 0。
function envelopeOf(envelopeDirs, name) {
  const shots = envelopeDirs
    .filter((dir) => existsSync(path.join(dir, `${name}.png`)))
    .map((dir) => loadShot(dir, name));
  const envelope = { changed: 0, maxDiff: 0 };
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) {
      const diff = diffOf(shots[i], shots[j]);
      envelope.changed = Math.max(envelope.changed, diff.changed);
      envelope.maxDiff = Math.max(envelope.maxDiff, diff.maxDiff);
    }
  }
  return envelope;
}

// a と b の RGB の差の絶対値を DIFF_GAIN 倍し、255 で飽和させた RGB の PNG を返す。
function diffPng(a, b) {
  const rgb = new Uint8Array(a.width * a.height * 3);
  for (let i = 0; i < a.width * a.height; i++) {
    for (let c = 0; c < 3; c++) {
      const p = i * a.channels + c;
      rgb[i * 3 + c] = Math.min(255, Math.abs(a.data[p] - b.data[p]) * DIFF_GAIN);
    }
  }
  return encodeRgbPng(a.width, a.height, rgb);
}

function main() {
  const { before, after, envelopeDirs } = parseArgs(process.argv.slice(2));
  const beforeNames = shotNamesIn(before);
  const afterNames = shotNamesIn(after);
  const outDir = path.join(path.dirname(after), `compare-${path.basename(after)}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // 両方にある撮影を、封筒と並べて 1 行ずつ出す。
  console.log('| 撮影名 | 変化画素 | 最大差 | 外接矩形 | 封筒の変化画素 | 封筒の最大差 | 判定 |');
  console.log('| --- | ---: | ---: | --- | ---: | ---: | --- |');
  const common = beforeNames.filter((name) => afterNames.includes(name));
  let outsideCount = 0;
  for (const name of common) {
    const beforeShot = loadShot(before, name);
    const afterShot = loadShot(after, name);
    const diff = diffOf(beforeShot, afterShot);
    const envelope = envelopeOf(envelopeDirs, name);
    const outside = diff.changed > envelope.changed || diff.maxDiff > envelope.maxDiff;
    if (outside) {
      writeFileSync(path.join(outDir, `${name}.png`), diffPng(beforeShot, afterShot));
      outsideCount++;
    }
    const box = diff.box === null ? '-' : `(${diff.box.x0},${diff.box.y0})-(${diff.box.x1},${diff.box.y1})`;
    console.log(`| ${name} | ${diff.changed} | ${diff.maxDiff} | ${box} | ${envelope.changed} | ${envelope.maxDiff}`
      + ` | ${outside ? '封筒外' : '封筒内'} |`);
  }
  console.log(`\n封筒外 ${outsideCount} / ${common.length}`);
  if (outsideCount > 0) console.log(`差分画像(差 ×${DIFF_GAIN}): ${outDir}`);

  // 片方にしか無い撮影は、比べずに名前だけ挙げる。
  const added = afterNames.filter((name) => !beforeNames.includes(name));
  const removed = beforeNames.filter((name) => !afterNames.includes(name));
  if (added.length > 0) console.log(`追加(after にだけある): ${added.join(', ')}`);
  if (removed.length > 0) console.log(`消滅(before にだけある): ${removed.join(', ')}`);
}

main();
