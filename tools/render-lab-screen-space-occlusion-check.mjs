// 候補aの前後で、照り返し源を切った1パスの帯と補正項を比較する。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { packedBandsNamesOf, shotsDir, withLab, writeFloats } from './screen-space-lab.mjs';

const label = process.argv.find((arg) => arg.startsWith('--run='))?.slice('--run='.length);
const against = process.argv.find((arg) => arg.startsWith('--against='))?.slice('--against='.length);
if (!label || !/^[a-z0-9-]+$/.test(label) || (against && !/^[a-z0-9-]+$/.test(against))) {
  throw new Error('usage: node tools/render-lab-screen-space-occlusion-check.mjs --run=<label> [--against=<label>]');
}

const root = path.join(shotsDir, 'ssd-8-15-chain-metrics', 'occlusion-check');
const scenes = [
  { name: 'cornell-box', caseName: 'cornell-box', shot: 'cornell-box' },
  { name: 'bay-earth-open', caseName: 'bay', shot: 'bay-earth-open' },
];
const targets = ['band-sum', ...packedBandsNamesOf(4), 'correction'];
const tier = { scale: 0.25, sliceCount: 4, stepCount: 5, bandCount: 4, bandScale: 0.75 };

await withLab(async (lab) => {
  for (const scene of scenes) {
    const dir = path.join(root, label, scene.name);
    mkdirSync(dir, { recursive: true });
    await lab.show({ ...scene, mode: 1 });
    await lab.setTier(tier);
    await lab.setWhiteNoisePass(7000);
    await lab.render();
    const differences = {};
    for (const name of targets) {
      const actual = await lab.readFloat(name, 4);
      writeFloats(path.join(dir, `${name}.rgba.f32`), actual);
      if (!against) continue;
      const file = path.join(root, against, scene.name, `${name}.rgba.f32`);
      const bytes = readFileSync(file);
      const expected = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      if (actual.length !== expected.length) throw new Error(`${scene.name}/${name}: size changed`);
      let maximumAbsolute = 0;
      let sumAbsolute = 0;
      let differing = 0;
      for (let i = 0; i < actual.length; i++) {
        const difference = Math.abs(actual[i] - expected[i]);
        maximumAbsolute = Math.max(maximumAbsolute, difference);
        sumAbsolute += difference;
        if (difference !== 0) differing++;
      }
      differences[name] = { maximumAbsolute, meanAbsolute: sumAbsolute / actual.length, differing };
    }
    writeFileSync(path.join(dir, 'comparison.json'), JSON.stringify({ scene: scene.name, tier, whiteNoisePass: 7000,
      mode: 'occlusion', against: against ?? null, differences }, null, 2));
    console.log(`${scene.name}: ${JSON.stringify(differences)}`);
  }
});
