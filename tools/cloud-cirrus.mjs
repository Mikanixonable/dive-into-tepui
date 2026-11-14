// 巻雲層だけの場どうしの微細構造の特徴量。比較の単位は (地域, 梯子) の対で、生成は
// 巻雲層だけの撮影を実写の帯 13 の箱へ載せ替えた輝度、実写は帯 13 の輝度温度から
// 切り分けた高層雲の「冷たさ」の場 (cloud-brightness-temperature)。測るのは微細構造
// (cloud-fine-structure) と同じ流儀の、帯ごとの電力割合と筋の特徴だけで、場はどちらも
// 自分の全電力・自分の分布で相対化して比べる。合成画の微細構造と違い、ここでは
// 積雲の明るさに支配されず、半透明殻そのものの構造だけが残る。
// 返す値は帯と梯子の対応付け (primary) を添えた生の特徴量で、距離への落とし方は
// cloud-distances.mjs が決める。

import { structureTensor, summarizeStructure } from './cloud-structure.mjs';
import {
  FINE_BANDS,
  FINE_PRIMARY_LADDER,
  FINE_STREAK_SCALES_KM,
  bandShares,
  orientationCorrelationLength,
  rowBandPowers,
} from './cloud-fine-structure.mjs';

// 帯を測れる条件 (cloud-fine-structure の bandMeasurable と同じ)。長い側は枠の幅に
// 収まり、短い側はナイキスト (2 px) より長いこと。
function bandMeasurable(band, frameWidthKm, kmPerPx) {
  return band.hiKm <= frameWidthKm && band.loKm >= 2 * kmPerPx;
}

// 筋のテンソルを測れる尺度 [km] (cloud-fine-structure の streakScaleMeasurable と同じ)。
// ぼかしが枠に収まり、尺度が 4 px より長いこと。
function streakScaleMeasurable(scaleKm, frameWidthKm, kmPerPx) {
  return scaleKm <= frameWidthKm / 4 && scaleKm >= 4 * kmPerPx;
}

// 1 つの対の巻雲層の特徴量。generatedLayer は層だけの撮影の輝度、referenceLayer は
// 冷たさの場で、どちらも同じ箱・同じ矩形に切り出してあること。
export function measureCirrusPair(generatedLayer, referenceLayer, kmPerPx, ladder) {
  const frameWidthKm = generatedLayer.width * kmPerPx;
  const generatedShares = bandShares(rowBandPowers(generatedLayer, kmPerPx), FINE_BANDS);
  const referenceShares = bandShares(rowBandPowers(referenceLayer, kmPerPx), FINE_BANDS);
  const bands = [];
  for (let i = 0; i < FINE_BANDS.length; i++) {
    const band = FINE_BANDS[i];
    const key = `${band.loKm}-${band.hiKm}`;
    if (!bandMeasurable(band, frameWidthKm, kmPerPx)) continue;
    bands.push({
      ...band,
      primary: FINE_PRIMARY_LADDER[key] === ladder,
      generatedShare: generatedShares[i].share,
      referenceShare: referenceShares[i].share,
    });
  }

  const rowKmPerPx = new Array(generatedLayer.height).fill(kmPerPx);
  const tensors = new Map();
  for (const scaleKm of FINE_STREAK_SCALES_KM) {
    if (!streakScaleMeasurable(scaleKm, frameWidthKm, kmPerPx)) continue;
    tensors.set(scaleKm, {
      generated: structureTensor(generatedLayer, rowKmPerPx, kmPerPx, false, scaleKm),
      reference: structureTensor(referenceLayer, rowKmPerPx, kmPerPx, false, scaleKm),
    });
  }
  const scales = [...tensors.entries()].map(([scaleKm, tensor]) => ({
    scaleKm,
    generated: summarizeStructure(tensor.generated, 0, 0, generatedLayer.width, generatedLayer.height),
    reference: summarizeStructure(tensor.reference, 0, 0, referenceLayer.width, referenceLayer.height),
  }));
  // 向きの相関長は 63 km の尺度で読む (微細構造の筋と同じ)。2000 km の梯子では
  // 遅れを 640 km まで伸ばす。
  const lThetaTensor = tensors.get(63);
  let lThetaKm = null;
  if (lThetaTensor !== undefined) {
    const generatedLTheta = orientationCorrelationLength(
      lThetaTensor.generated, kmPerPx, ladder === '2000km' ? 640 : 320);
    const referenceLTheta = orientationCorrelationLength(
      lThetaTensor.reference, kmPerPx, ladder === '2000km' ? 640 : 320);
    if (generatedLTheta !== null && referenceLTheta !== null) {
      lThetaKm = { generated: generatedLTheta.lThetaKm, reference: referenceLTheta.lThetaKm };
    }
  }
  return { bands, streak: { scales, lThetaKm } };
}
