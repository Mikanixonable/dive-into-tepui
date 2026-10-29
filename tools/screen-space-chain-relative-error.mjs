// 帯鎖の run の構造誤差 S と雑音 N を、対称な相対誤差 2(M − B)/(|M| + |B|) で測る(手順22 段A、決めたこと 63・65)。0 に近い所への漏れと、
// もともと小さい所の全体のわずかな悪化を強く、明るい所の変調を弱く罰する。絶対誤差の scaleRms と同じく目安で、採否は画像で決める。
// 走査の解像度で色成分ごとに取り、面の画素で RMS にする。
// S は B = 帯へ分ける前の収束先・M = 収束先の鎖の出力、N は B = 収束先の鎖の出力・M = 1 パス(本番位相 0、seed 1 つ)の鎖の出力。
//   node tools/screen-space-chain-relative-error.mjs <run>...                  — 撮影ごとの S_rel・N_rel
//   node tools/screen-space-chain-relative-error.mjs --tiles=<runA>,<runB>     — S_rel²・N_rel² の A − B の 30×27 タイルごとの和(どこが違うか)
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SCAN_HEIGHT, SCAN_PIXELS, SCAN_WIDTH, sceneDirOf } from './screen-space-chain-runs.mjs';

const SCENES = ['angled-bounce', 'bay-earth-open', 'bay-dark', 'cornell-box'];
// |M| と |B| の平均がこれ未満の画素は誤差 0 として数える(表示の約 1 LSB)。run によらない値にして、run どうしの数を比べられるようにする。
const ZERO_LEVEL = 0.005;
const TILE_WIDTH = 30;
const TILE_HEIGHT = 27;

function floatsOf(run, scene, file) {
  const buffer = readFileSync(path.join(sceneDirOf(run, scene), file));
  return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

const relativeError = (m, b) => {
  const magnitude = Math.abs(m) + Math.abs(b);
  return magnitude / 2 < ZERO_LEVEL ? 0 : 2 * (m - b) / magnitude;
};

// 画素ごと・色成分ごとの S_rel² と N_rel²(面の外は 0)と、面の画素の数。
function squaredErrorsOf(run, scene) {
  const bandSum = floatsOf(run, scene, 'band-sum-1024.rgba.f32');
  const merged = floatsOf(run, scene, 'merged-1024.rgba.f32');
  const onePass = floatsOf(run, scene, 'scan-one-pass-merged.rgba.f32');
  const structure = new Float64Array(SCAN_PIXELS * 3), noise = new Float64Array(SCAN_PIXELS * 3);
  let surfacePixels = 0;
  for (let p = 0; p < SCAN_PIXELS; p++) {
    if ([0, 1, 2].every((c) => bandSum[p * 4 + c] === 0 && merged[p * 4 + c] === 0)) continue;
    surfacePixels++;
    for (let c = 0; c < 3; c++) {
      structure[p * 3 + c] = relativeError(merged[p * 4 + c], bandSum[p * 4 + c]) ** 2;
      noise[p * 3 + c] = relativeError(onePass[p * 4 + c], merged[p * 4 + c]) ** 2;
    }
  }
  return { structure, noise, surfacePixels };
}

const sumOf = (values) => values.reduce((total, value) => total + value, 0);
const hasRun = (run, scene) => existsSync(path.join(sceneDirOf(run, scene), 'merged-1024.rgba.f32'));

function printErrors(runs) {
  for (const scene of SCENES) {
    for (const run of runs.filter((r) => hasRun(r, scene))) {
      const { structure, noise, surfacePixels } = squaredErrorsOf(run, scene);
      const rms = (squares) => Math.sqrt(sumOf(squares) / (surfacePixels * 3));
      console.log(`${scene}\t${run}\tS_rel ${rms(structure).toFixed(4)}\tN_rel ${rms(noise).toFixed(4)}`);
    }
  }
}

function printTiles(runA, runB) {
  for (const scene of SCENES.filter((s) => hasRun(runA, s) && hasRun(runB, s))) {
    const a = squaredErrorsOf(runA, scene), b = squaredErrorsOf(runB, scene);
    for (const kind of ['structure', 'noise']) {
      const tiles = [];
      for (let ty = 0; ty < SCAN_HEIGHT; ty += TILE_HEIGHT) for (let tx = 0; tx < SCAN_WIDTH; tx += TILE_WIDTH) {
        let difference = 0;
        for (let y = ty; y < Math.min(SCAN_HEIGHT, ty + TILE_HEIGHT); y++) for (let x = tx; x < Math.min(SCAN_WIDTH, tx + TILE_WIDTH); x++) {
          for (let c = 0; c < 3; c++) difference += a[kind][(y * SCAN_WIDTH + x) * 3 + c] - b[kind][(y * SCAN_WIDTH + x) * 3 + c];
        }
        tiles.push({ tx, ty, difference });
      }
      const largest = [...tiles].sort((p, q) => Math.abs(q.difference) - Math.abs(p.difference)).slice(0, 5)
        .map((t) => `${t.tx},${t.ty} ${t.difference.toFixed(0)}`).join(' / ');
      console.log(`${scene}\t${kind}\tA − B ${sumOf(tiles.map((t) => t.difference)).toFixed(0)}（正 = A が悪い）\t${largest}`);
    }
  }
}

const args = process.argv.slice(2);
const tiles = args.find((arg) => arg.startsWith('--tiles='));
if (tiles) printTiles(...tiles.slice('--tiles='.length).split(','));
else printErrors(args);
