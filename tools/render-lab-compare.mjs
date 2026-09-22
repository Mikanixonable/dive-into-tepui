// 描画テスト環境の撮影の前後比較。新しいコードで撮った after の 1 組を、古いコードで撮った before の組
// (1 組以上)と撮影名ごとに比べ、after に最も近い before の組とのブロック差が封筒(before どうしの
// ブロック差の最大と BLOCK_FLOOR の大きいほう)を超えた撮影を封筒外とする。封筒外の撮影は、最も近い組との
// 差を増幅した画像を <after の親>/compare-<after の名前>/ へ書く(書く前に作り直す)。dir は相対ならリポジトリ根から。
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { decodePng, encodeRgbPng } from './png.mjs';

const root = path.resolve(import.meta.dirname, '..');
const USAGE = 'usage: node tools/render-lab-compare.mjs <after-dir> <before-dir> [<before-dir> ...]';
// ブロック差を取るブロックの 1 辺 [px]。撮り直しの揺らぎは散在する少数の画素に、本物の変化はまとまった
// 領域に出るので、ブロックで平均すると前者だけが薄まる。
const BLOCK = 8;
// 封筒の下限 [LSB]。同じ挙動のコードで撮り直した組の 9 対・のべ 317 撮影で測ったブロック差の最大
// (5.28、earth-eclipse)を切り上げたもの。
const BLOCK_FLOOR = 6;
// 差分画像で RGB の差の絶対値 [LSB] に掛ける倍率。255 で飽和する。
const DIFF_GAIN = 8;

// コマンドライン引数から after と before の dir 群(どれも絶対パス)を取る。dir が 2 つ未満なら使い方を投げる。
function parseArgs(args) {
  if (args.length < 2) throw new Error(USAGE);
  const [afterDir, ...beforeDirs] = args.map((dir) => path.resolve(root, dir));
  return { afterDir, beforeDirs };
}

// dir にある撮影名(PNG のファイル名から拡張子を除いたもの)を名前順で返す。
function shotNamesIn(dir) {
  return readdirSync(dir).filter((file) => file.endsWith('.png')).map((file) => file.slice(0, -4)).sort();
}

// dir の撮影 name を decodePng の形で読み、組の名前 set(dir の名前)と読んだパス file を添える。
function loadShot(dir, name) {
  const file = path.join(dir, `${name}.png`);
  return { set: path.basename(dir), file, ...decodePng(readFileSync(file)) };
}

// 同じ形の 2 枚のブロック差 [LSB]。BLOCK 画素四方のブロック(端の半端なブロックも含む)ごとに、
// チャンネルごとの平均の差の絶対値の最大を取り、全ブロックで最大にしたもの。
function blockMaxOf(a, b) {
  let blockMax = 0;
  for (let y0 = 0; y0 < a.height; y0 += BLOCK) {
    for (let x0 = 0; x0 < a.width; x0 += BLOCK) {
      const y1 = Math.min(y0 + BLOCK, a.height);
      const x1 = Math.min(x0 + BLOCK, a.width);
      for (let c = 0; c < a.channels; c++) {
        let sum = 0;
        for (let y = y0; y < y1; y++) {
          for (let x = x0; x < x1; x++) {
            const p = (y * a.width + x) * a.channels + c;
            sum += a.data[p] - b.data[p];
          }
        }
        blockMax = Math.max(blockMax, Math.abs(sum) / ((y1 - y0) * (x1 - x0)));
      }
    }
  }
  return blockMax;
}

// 同じ形の 2 枚の差。blockMax はブロック差 [LSB]、changed はどれかのチャンネルが 1 LSB 以上違う画素の数、
// maxDiff はチャンネルの差の最大 [LSB]、box は変わった画素の外接矩形(両端を含む画素座標。変化が無ければ
// null)。形が違えば投げる。
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
  return { blockMax: blockMaxOf(a, b), changed, maxDiff, box: changed === 0 ? null : { x0, y0, x1, y1 } };
}

// beforeShots のうち afterShot に最も近い(ブロック差が最小の)撮影 shot と、その差 diff。
// beforeShots は空でないこと。
function nearestOf(afterShot, beforeShots) {
  let nearest = null;
  for (const shot of beforeShots) {
    const diff = diffOf(afterShot, shot);
    if (nearest === null || diff.blockMax < nearest.diff.blockMax) nearest = { shot, diff };
  }
  return nearest;
}

// 同じ撮影を撮った組どうしの封筒 [LSB]。全ての組のブロック差の最大と BLOCK_FLOOR の大きいほう。
function envelopeOf(shots) {
  let envelope = BLOCK_FLOOR;
  for (let i = 0; i < shots.length; i++) {
    for (let j = i + 1; j < shots.length; j++) envelope = Math.max(envelope, diffOf(shots[i], shots[j]).blockMax);
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
  const { afterDir, beforeDirs } = parseArgs(process.argv.slice(2));
  const afterNames = shotNamesIn(afterDir);
  const beforeNames = [...new Set(beforeDirs.flatMap(shotNamesIn))].sort();
  const outDir = path.join(path.dirname(afterDir), `compare-${path.basename(afterDir)}`);
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  // after にも before のどれかの組にもある撮影を、最も近い組・封筒と並べて 1 行ずつ出す。
  console.log('| 撮影名 | 最も近い組 | ブロック差 | 封筒 | 判定 | 変化画素 | 最大差 | 外接矩形 |');
  console.log('| --- | --- | ---: | ---: | --- | ---: | ---: | --- |');
  const common = afterNames.filter((name) => beforeNames.includes(name));
  let outsideCount = 0;
  for (const name of common) {
    const afterShot = loadShot(afterDir, name);
    const beforeShots = beforeDirs
      .filter((dir) => existsSync(path.join(dir, `${name}.png`)))
      .map((dir) => loadShot(dir, name));
    const { shot: nearestShot, diff } = nearestOf(afterShot, beforeShots);
    const envelope = envelopeOf(beforeShots);
    const outside = diff.blockMax > envelope;
    if (outside) {
      writeFileSync(path.join(outDir, `${name}.png`), diffPng(afterShot, nearestShot));
      outsideCount++;
    }
    const box = diff.box === null ? '-' : `(${diff.box.x0},${diff.box.y0})-(${diff.box.x1},${diff.box.y1})`;
    console.log(`| ${name} | ${nearestShot.set} | ${diff.blockMax.toFixed(2)} | ${envelope.toFixed(2)}`
      + ` | ${outside ? '封筒外' : '封筒内'} | ${diff.changed} | ${diff.maxDiff} | ${box} |`);
  }
  console.log(`\n封筒外 ${outsideCount} / ${common.length}`);
  if (outsideCount > 0) console.log(`差分画像(差 ×${DIFF_GAIN}): ${outDir}`);

  // 片方にしか無い撮影は、比べずに名前だけ挙げる。
  const added = afterNames.filter((name) => !beforeNames.includes(name));
  const removed = beforeNames.filter((name) => !afterNames.includes(name));
  if (added.length > 0) console.log(`追加(before のどの組にも無い): ${added.join(', ')}`);
  if (removed.length > 0) console.log(`消滅(after に無い): ${removed.join(', ')}`);
}

main();
