// 撮影済みの run へ、blue-noise seed 0 の1パスの4帯(float と基準の尺度の符号付き PNG)を書き足す。
// 使い方: node tools/render-lab-screen-space-one-pass-bands.mjs --run=<label> [--scene=<name>]
// run の記録の走査ソース署名・ケースの署名が現在のビルドと一致するときだけ撮り、記録は書き換えない。
// 出力は runs/<run>/<ケース>/bands/ の one-pass-band-* と one-pass-bands.json。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { BAND_COUNT, bandScaleOf, bandStatsOf, bandsDirOf, writeBandImages } from './screen-space-chain-bands.mjs';
import { bandSumInvariant } from './screen-space-band-sum-invariant.mjs';
import { BASELINE_RUN, metricsOf, recordOf, sceneDirOf } from './screen-space-chain-runs.mjs';
import { SCENES, sceneSignatureOf, sourceSignatureOf } from './screen-space-chain-setup.mjs';
import { readFloats, seedOf, unpackedBand, withLab, writeFloats } from './screen-space-lab.mjs';

const argumentOf = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const run = argumentOf('run');
if (run === undefined) throw new Error('usage: node tools/render-lab-screen-space-one-pass-bands.mjs --run=<label> [--scene=<name>]');
const sceneName = argumentOf('scene');
const scenes = sceneName === undefined ? SCENES : SCENES.filter(({ name }) => name === sceneName);
if (scenes.length === 0) throw new Error(`unknown scene: ${sceneName}`);

const record = recordOf(run);
const { tier } = record.conditions;
const commonSignature = sourceSignatureOf(tier);
if (commonSignature !== record.scanSourceSignature) {
  throw new Error(`run ${run}: scan source signature ${record.scanSourceSignature} differs from the current build ${commonSignature}`);
}

for (const scene of scenes) {
  const metrics = metricsOf(run, scene.name);
  if (metrics === null) continue;
  if (sceneSignatureOf(scene, commonSignature) !== metrics.sceneSourceSignature) {
    throw new Error(`run ${run}/${scene.name}: scene source signature differs from the current build`);
  }
  let bands;
  try {
    await withLab(async (lab) => {
      await lab.show({ caseName: scene.caseName, shot: scene.shot, mode: 2, set: 'tuning', key: scene.name });
      await lab.setUpsampleAlphaOne(false);
      await lab.setTier(tier);
      await lab.setWhiteNoisePass(null);
      await lab.setSeed(seedOf(0));
      await lab.render();
      const packed = [];
      for (let texture = 0; texture < 3; texture++) packed.push(await lab.readFloat(`packed-bands-${texture}`, 4));
      bands = Array.from({ length: BAND_COUNT }, (_, band) => unpackedBand(packed, band));
    });
  } catch (error) {
    // 撮影後の Chrome のプロファイル削除の EPERM は無視する。
    if (error?.code !== 'EPERM' || bands === undefined) throw error;
  }
  const dir = bandsDirOf(run, scene.name);
  const scale = bandScaleOf(scene.name);
  const files = writeBandImages(dir, 'one-pass-band', bands, scale);
  for (const [band, values] of bands.entries()) writeFloats(path.join(dir, `one-pass-band-${band}.rgb.f32`), values);
  // 記録済みの1パスの帯和(同じ seed・同じ描画)との照合。
  const recorded = readFloats(path.join(sceneDirOf(run, scene.name), 'scan-one-pass-band-sum.rgba.f32'));
  const { stats } = bandSumInvariant(recorded, bands);
  const summary = { run, scene: scene.name, blueNoiseSeed: seedOf(0), scale: { baseline: BASELINE_RUN, value: scale },
    ...bandStatsOf(bands), againstRecordedBandSum: stats, files };
  writeFileSync(path.join(dir, 'one-pass-bands.json'), JSON.stringify(summary, null, 2));
  console.log(`${run}/${scene.name}: mean band ${summary.meanBandNumber?.toFixed(3)}, recorded-sum exceed ${stats.roundingExceeded.count}`);
}
