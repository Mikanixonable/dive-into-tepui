// 候補比較で並べる画像の種類。種類ごとの画像は runs/<run>/<ケース>/ 内の1ファイル(帯は倍率ごとに1ファイル)。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { metricsOf, sceneDirOf } from './screen-space-chain-runs.mjs';
import { BAND_COUNT } from './screen-space-chain-bands.mjs';
import { ONE_PASS_CORRECTION_SEEDS } from './screen-space-chain-index.mjs';

export const SCAN = 'scan';
export const FULL = 'full';

// 種類の定義 { id, group, label, resolution, zoomable, fileOf(passes, zoom, metrics) }。fileOf はケースのフォルダ内のファイル名を返す
// (無ければ undefined)。zoomable な種類(帯)だけ倍率ごとにファイルがある。
// 帯の種類の系列。prefix は bands/ 内のファイル名と種類 id の接頭辞、sheet は合成シートの名前(倍率が付く)。
export const BAND_SERIES = [
  { prefix: 'converged-band', sheet: 'converged-bands', group: '収束した帯' },
  { prefix: 'converged-band-std', sheet: 'converged-std-bands', group: '帯ごとの標準偏差(パスについて)' },
  { prefix: 'one-pass-band', sheet: 'one-pass-bands', group: '1パスの帯' },
];
const bandKinds = ({ prefix, group }) => Array.from({ length: BAND_COUNT }, (_, band) => ({
  id: `${prefix}-${band}`, series: prefix, group, label: `帯${band}`, resolution: SCAN, zoomable: true,
  fileOf: (passes, zoom) => `bands/${prefix}-${band}.x${zoom}.png`,
}));
const plain = (id, group, label, resolution, fileOf) => ({ id, group, label, resolution, zoomable: false, fileOf });

export const KINDS = [
  ...BAND_SERIES.flatMap(bandKinds),
  plain('scan-one-pass-band-sum', '走査の像', '1パス・4帯和', SCAN, () => 'scan-one-pass-band-sum.signed.png'),
  plain('scan-one-pass-merged', '走査の像', '1パス・合流', SCAN, () => 'scan-one-pass-merged.signed.png'),
  plain('scan-converged-band-sum', '走査の像', '収束・4帯和', SCAN, () => 'scan-converged-band-sum.signed.png'),
  plain('scan-converged-merged', '走査の像', '収束・合流', SCAN, () => 'scan-converged-merged.signed.png'),
  plain('structure', '誤差の地図', '構造誤差', SCAN, (passes) => `structure-${passes}.png`),
  plain('structure-half-difference', '誤差の地図', '構造誤差の前後半差', SCAN, (passes) => `structure-half-difference-${passes}.png`),
  plain('noise-rms', '誤差の地図', '1パス雑音 RMS', SCAN, (passes) => `noise-rms-${passes}.png`),
  plain('max-deviation', '誤差の地図', '1パスの最大偏差', SCAN, (passes) => `max-deviation-${passes}.png`),
  plain('band-sum-invariant', '誤差の地図', '帯和の不変条件の差', SCAN, (passes, zoom, metrics) => metrics.onePassBandSum?.differenceMap),
  plain('band-sum-invariant-occlusion', '誤差の地図', '同・遮蔽のみ', SCAN, (passes, zoom, metrics) => metrics.occlusionOnlyBandSum?.differenceMap),
  plain('one-pass-correction', '補正項', '1パス', FULL, () => 'one-pass-correction.png'),
  ...ONE_PASS_CORRECTION_SEEDS.map((seed) => plain(`one-pass-correction-seed${seed}`, '補正項', `1パス (seed ${seed})`, FULL,
    () => `one-pass-correction-seed${seed}.png`)),
  plain('mean-correction', '補正項', '収束平均', FULL, (passes) => `mean-${passes}-correction.png`),
  plain('bypass-mean-correction', '補正項', '収束・鎖迂回', FULL, (passes) => `bypass-mean-${passes}-correction.png`),
  plain('one-pass-diffuse-clay', '拡散照度クレイ', '1パス', FULL, () => 'one-pass-diffuse-clay.png'),
  plain('mean-diffuse-clay', '拡散照度クレイ', '収束平均', FULL, (passes) => `mean-${passes}-diffuse-clay.png`),
  plain('bypass-mean-diffuse-clay', '拡散照度クレイ', '収束・鎖迂回', FULL, (passes) => `bypass-mean-${passes}-diffuse-clay.png`),
  plain('rois', 'ROI', 'ROI の位置', SCAN, () => 'rois.png'),
];

// run のケースにある kind の画像の、ケースのフォルダからの相対パス。無ければ null。
export function imageFileOf(kind, run, scene, zoom = 1) {
  const metrics = metricsOf(run, scene);
  const name = kind.fileOf(metrics.conditions.passes, zoom, metrics);
  return name !== undefined && existsSync(path.join(sceneDirOf(run, scene), name)) ? name : null;
}
