// 4帯の収束入力を1帯ずつ鎖へ再投入し、構造誤差の打ち消しを測る。
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { shotsDir, withLab } from './screen-space-lab.mjs';

const root = path.join(shotsDir, 'ssd-8-15-chain-metrics');
const runs = ['prea-k05', 'before-a', 'prea-k1', 'a'];
const width = 240, height = 135;
const roi = [30, 42, 28, 33];
const results = [];

function floats(file) {
  const bytes = readFileSync(file);
  return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

function meanProduct(a, b) {
  let sum = 0;
  for (let y = roi[1]; y < roi[1] + roi[3]; y++) for (let x = roi[0]; x < roi[0] + roi[2]; x++) {
    const offset = (y * width + x) * 4;
    for (let c = 0; c < 3; c++) sum += a[offset + c] * b[offset + c];
  }
  return sum / (roi[2] * roi[3] * 3);
}

await withLab(async (lab) => {
  for (const run of runs) {
    const dir = path.join(root, 'runs', run, 'cornell-box');
    const metrics = JSON.parse(readFileSync(path.join(dir, 'metrics.json'), 'utf8'));
    const cache = path.join(root, 'cache', 'cornell-box', metrics.cacheKey);
    const packed = Array.from({ length: 3 }, (_, index) => floats(path.join(cache, `mean-1024-packed-${index}.f32`)));
    await lab.show({ caseName: 'cornell-box', shot: 'cornell-box', mode: 2 });
    await lab.setTier(metrics.conditions.tier);
    await lab.setWhiteNoisePass(7000);
    await lab.setStageRange('all');
    await lab.render();
    const errors = [];
    for (let band = 0; band < 4; band++) {
      for (let texture = 0; texture < 3; texture++) {
        const masked = new Float32Array(packed[texture].length);
        for (let pixel = 0; pixel < width * height; pixel++) for (let channel = 0; channel < 4; channel++) {
          const packedChannel = texture * 4 + channel;
          if (Math.floor(packedChannel / 3) === band) {
            masked[pixel * 4 + channel] = packed[texture][pixel * 4 + channel];
          }
        }
        await lab.writePackedBands(texture, masked);
      }
      await lab.setStageRange('chain');
      await lab.render();
      const bandSum = await lab.readFloat('band-sum', 4);
      const merged = await lab.readFloat('merged-0', 4);
      errors.push(Float32Array.from(bandSum, (value, index) => index % 4 === 3 ? 0 : value - merged[index]));
    }
    const covariance = errors.map((a) => errors.map((b) => meanProduct(a, b)));
    const diagonal = covariance.reduce((sum, row, index) => sum + row[index], 0);
    const offDiagonal = covariance.flat().reduce((sum, value) => sum + value, 0) - diagonal;
    const totalRms = Math.sqrt(Math.max(0, diagonal + offDiagonal));
    results.push({ run, bandScale: metrics.conditions.tier.bandScale,
      perBandRms: covariance.map((row, index) => Math.sqrt(row[index])), diagonal, offDiagonal,
      totalRms, recordedRms: metrics.rois.target.structureRms, covariance });
  }
});
const file = path.join(root, 'band-debug-cornell-error.json');
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(JSON.stringify(results.map(({ run, perBandRms, diagonal, offDiagonal, totalRms, recordedRms }) =>
  ({ run, perBandRms, diagonal, offDiagonal, totalRms, recordedRms })), null, 2));
