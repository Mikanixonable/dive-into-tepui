// 撮影済みの run へ、blue-noise seed 0 の1パスの4帯(float と基準の尺度の符号付き PNG)を書き足す。
// 新しく撮る run は render-lab-screen-space-chain-metrics.mjs が同じものを書くので、これは古い run の補いに使う。
// 使い方: node tools/render-lab-screen-space-one-pass-bands.mjs --run=<label> [--scene=<name>]
// run の記録の走査ソース署名・ケースの署名が現在のビルドと一致するときだけ撮り、記録は書き換えない。
// 出力は runs/<run>/<ケース>/bands/ の one-pass-band-* と one-pass-bands.json。
import path from 'node:path';
import { bandScaleOf, readBands, writeOnePassBands } from './screen-space-chain-bands.mjs';
import { metricsOf, recordOf, sceneDirOf } from './screen-space-chain-runs.mjs';
import { SCENES, sceneSignatureOf, sourceSignatureOf } from './screen-space-chain-setup.mjs';
import { readFloats, seedOf, withLab } from './screen-space-lab.mjs';

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
      bands = await readBands(lab);
    });
  } catch (error) {
    // 撮影後の Chrome のプロファイル削除の EPERM は無視する。
    if (error?.code !== 'EPERM' || bands === undefined) throw error;
  }
  // 記録済みの1パスの帯和(同じ seed・同じ描画)との照合つき。
  const recorded = readFloats(path.join(sceneDirOf(run, scene.name), 'scan-one-pass-band-sum.rgba.f32'));
  const summary = writeOnePassBands(run, scene.name, bands, bandScaleOf(scene.name), recorded);
  console.log(`${run}/${scene.name}: mean band ${summary.meanBandNumber?.toFixed(3)}, recorded-sum exceed ${summary.againstRecordedBandSum.roundingExceeded.count}`);
}
