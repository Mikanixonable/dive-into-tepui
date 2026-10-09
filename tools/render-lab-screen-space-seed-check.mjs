// 同じ走査ノイズで、帯数1のrawと帯数4の帯和が一致するかを確認する。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeRgbPng } from './png.mjs';
import { HEIGHT, shotsDir, WIDTH, withLab, writeFloats } from './screen-space-lab.mjs';

const outDir = path.join(shotsDir, 'ssd-8-15-reference');
const scenes = [
  { id: 'bay-earth-open', caseName: 'bay', shot: 'bay-earth-open' },
  { id: 'cornell-box', caseName: 'cornell-box', shot: 'cornell-box' },
  { id: 'bay-dark', caseName: 'bay', shot: 'bay-dark' },
];
const baseTier = { scale: 0.25, sliceCount: 4, stepCount: 5, bandScale: 3 / 4 };
const rawTier = { ...baseTier, bandCount: 1 };
const chainTier = { ...baseTier, bandCount: 4 };
const scanWidth = Math.round(WIDTH * rawTier.scale);
const scanHeight = Math.round(HEIGHT * rawTier.scale);
mkdirSync(outDir, { recursive: true });
const results = [];

for (const scene of scenes) {
  let succeeded = false;
  try {
    await withLab(async (lab) => {
      try {
        await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 2, set: 'tuning', key: scene.id });
        await lab.setWhiteNoisePass(0);
        await lab.setTier(rawTier);
        await lab.setStageRange('scan');
        await lab.render();
        const raw = await lab.readFloat('band-sum', 4);
        await lab.setTier(chainTier);
        await lab.render();
        const chain = await lab.readFloat('band-sum', 4);
        if (raw.length !== chain.length) throw new Error(`${scene.id}: scan outputs have different sizes`);
        const difference = new Float32Array(raw.length);
        let maximum = 0, sum = 0, squareSum = 0, changed = 0;
        for (let p = 0; p < raw.length; p += 4) {
          for (let c = 0; c < 3; c++) {
            const delta = raw[p + c] - chain[p + c];
            difference[p + c] = delta;
            maximum = Math.max(maximum, Math.abs(delta));
            sum += Math.abs(delta);
            squareSum += delta * delta;
            if (delta !== 0) changed++;
          }
          difference[p + 3] = 1;
        }
        writeFloats(path.join(outDir, scene.id, 'same-seed-raw-scan.rgba.f32'), raw);
        writeFloats(path.join(outDir, scene.id, 'same-seed-chain-band-sum.rgba.f32'), chain);
        writeFloats(path.join(outDir, scene.id, 'same-seed-band-sum-difference.rgba.f32'), difference);
        const pixelCount = raw.length / 4 * 3;
        results.push({
          scene: scene.id, whiteNoisePass: 0, rawTier, chainTier,
          dimensions: [scanWidth, scanHeight], comparedRgbValues: pixelCount,
          maximumAbsoluteDifference: maximum, meanAbsoluteDifference: sum / pixelCount,
          rmsDifference: Math.sqrt(squareSum / pixelCount), changedRgbValues: changed,
        });
        succeeded = true;
      } finally {
        await lab.setWhiteNoisePass(null);
        await lab.setStageRange('all');
      }
    });
  } catch (error) {
    if (error?.code !== 'EPERM' || !succeeded) throw error;
    console.warn(`${scene.id}: comparison saved; Chrome temp profile cleanup returned EPERM`);
  }
  writeFileSync(path.join(outDir, 'same-seed-band-sum-check.json'), JSON.stringify({ results }, null, 2));
}

const scale = Math.max(1e-12, ...results.map((result) => result.maximumAbsoluteDifference));
for (const result of results) {
  const fileBytes = readFileSync(path.join(outDir, result.scene, 'same-seed-band-sum-difference.rgba.f32'));
  const bytes = new Float32Array(fileBytes.buffer.slice(fileBytes.byteOffset, fileBytes.byteOffset + fileBytes.byteLength));
  const rgb = new Uint8Array(result.dimensions[0] * result.dimensions[1] * 3);
  for (let p = 0; p < result.dimensions[0] * result.dimensions[1]; p++) for (let c = 0; c < 3; c++) {
    rgb[p * 3 + c] = Math.round(127.5 + 127.5 * Math.max(-1, Math.min(1, bytes[p * 4 + c] / scale)));
  }
  writeFileSync(path.join(outDir, result.scene, 'same-seed-band-sum-difference.png'),
    encodeRgbPng(result.dimensions[0], result.dimensions[1], rgb));
}
const summary = JSON.parse(readFileSync(path.join(outDir, 'same-seed-band-sum-check.json'), 'utf8'));
summary.differenceScale = scale;
writeFileSync(path.join(outDir, 'same-seed-band-sum-check.json'), JSON.stringify(summary, null, 2));
