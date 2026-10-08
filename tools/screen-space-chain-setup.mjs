// 手順8-15の帯鎖の撮影が共有する、ケースの定義と、撮影の入力(走査のソース・ケースの定義)の署名。
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { HEIGHT, WIDTH } from './screen-space-lab.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
export const CHUNK_PASSES = 256;
export const SCENES = [
  { name: 'bay-earth-open', caseName: 'bay', caseFile: 'tools/render-lab/bay-cases.ts', shot: 'bay-earth-open', rois: { target: [125, 30, 31, 19] } },
  { name: 'cornell-box', caseName: 'cornell-box', caseFile: 'tools/render-lab/cornell-box-case.ts', shot: 'cornell-box', rois: { target: [30, 42, 28, 33] } },
  { name: 'bay-dark', caseName: 'bay', caseFile: 'tools/render-lab/bay-cases.ts', shot: 'bay-dark', rois: { target: [105, 30, 46, 43] } },
  // 各板の内側の床。core は蝶番から 0.75 m まで、wide は 1.5 m から 4 m まで、板の中心線の幅 ±0.3 m。
  // gap は隣り合う板の隙間の真後ろの床(半径 10.3〜11.5 m、隙間の中央から ±0.5 m)。
  // カメラの投影で床の4隅を走査画素へ落とし、外接箱を内側へ丸めて、板に掛かる行を除いた。
  {
    name: 'angled-bounce', caseName: 'angled-bounce', caseFile: 'tools/render-lab/angled-bounce-case.ts', shot: 'angled-bounce',
    // 環境光と天体照を切ってあり、遮蔽のみの描画に寄与が無い。
    hasOcclusionOnly: false,
    rois: {
      'core-30': [38, 75, 11, 5], 'core-60': [80, 70, 8, 4], 'core-90': [116, 69, 8, 3],
      'core-120': [152, 70, 8, 4], 'core-150': [191, 76, 11, 4],
      'wide-30': [39, 84, 17, 25], 'wide-60': [80, 78, 12, 22], 'wide-90': [114, 77, 12, 20],
      'wide-120': [148, 78, 12, 22], 'wide-150': [184, 84, 17, 25],
      'gap-30-60': [57, 65, 14, 6], 'gap-60-90': [96, 63, 12, 4],
      'gap-90-120': [132, 63, 12, 4], 'gap-120-150': [169, 65, 14, 6],
    },
  },
];

// 走査のソースと解像度・段 tier・チャンクの署名。tier が違えば別の署名になる。
export function sourceSignatureOf(tier) {
  const hash = createHash('sha256').update('ssd-8-15-scan-source-v2');
  const files = [
    ...filesIn('src/render/pipeline/screen-space'),
    'src/render/pipeline/gbuffer.ts', 'src/render/pipeline/material-pass.ts',
    'src/render/pipeline/light-prepass.ts', 'src/render/pipeline/lit-layer.ts',
    'src/render/pipeline/render-pipeline.ts', 'src/render/pipeline/view-ray.ts',
    'src/render/pipeline/exposure.ts', 'src/render/graphics-settings.ts',
    'tools/render-lab/lab.ts', 'tools/render-lab/main.ts',
    'tools/render-lab/pass-accumulator.ts', 'tools/render-lab/lab-case.ts',
    'tools/screen-space-lab.mjs',
  ].sort();
  for (const relative of files) hash.update(relative).update(readFileSync(path.join(ROOT, relative)));
  hash.update(JSON.stringify({ width: WIDTH, height: HEIGHT, tier, chunkPasses: CHUNK_PASSES }));
  return hash.digest('hex').slice(0, 16);
}

function filesIn(folder) {
  const found = [];
  for (const item of readdirSync(path.join(ROOT, folder), { withFileTypes: true })) {
    const relative = path.join(folder, item.name);
    if (item.isDirectory()) found.push(...filesIn(relative));
    else if (item.name.endsWith('.ts')) found.push(relative);
  }
  return found;
}

// 走査のソースの署名 commonSignature のもとでの、ケースの定義の署名。
export function sceneSignatureOf(scene, commonSignature) {
  return createHash('sha256').update(commonSignature).update(JSON.stringify({ name: scene.name, caseName: scene.caseName, shot: scene.shot }))
    .update(scene.caseFile).update(readFileSync(path.join(ROOT, scene.caseFile)))
    .digest('hex').slice(0, 16);
}
