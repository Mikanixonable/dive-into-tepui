// レポートの sections から、生成と実写の「距離」を家族ごとに 1 数へ落とす純粋関数。
// 距離はすべて無次元で 0 が一致 — 帯の平均のずれ、階調の分布のずれ、塊の形のずれ、のように
// 家族ごとに物差しを正規化し、モデル変更の前後で「どの家族がどれだけ実写へ近づいたか」を
// 機械的に比べられるようにする。sections だけから計算するので、過去のレポートにも同じ
// 定義で後から計算できる (距離の定義を変えたら履歴全体へ適用し直せる)。
//
// 総和の index は家族の平均で、追跡用の指数にすぎない。判定は家族ごとに行うこと —
// 1 つの家族の悪化を、平均が他の改善で隠すためではない。

import { orientationDifferenceDeg } from './cloud-fine-structure.mjs';
import { FINE_MOTION_TAU_CENSOR_HOURS, windRelativeAlignment } from './cloud-fine-motion.mjs';

const mean = (values) => (values.length === 0 ? 0 : values.reduce((sum, v) => sum + v, 0) / values.length);
const absLogRatio = (generated, reference) => Math.abs(Math.log(generated / reference));

// 帯状平均の距離。緯度帯の全域が |lat| 70° より極側にある帯は除く — 帯は 5.625° 刻み
// (半幅 2.8125°)なので中心緯度の絶対値が 72.8125° を超える帯が該当する。実写の「厚い雲」は
// 極で氷床の明るさを拾っており雲の量ではないため、その帯の参照値を距離に入れると氷の量を
// 雲の量として比べることになる。±70.3125° の帯は境界をまたぎ厚みが帯状の値と同程度なので残す。
const ZONAL_POLAR_LIMIT_DEG = 70;
const ZONAL_BAND_HALF_WIDTH_DEG = 2.8125;

function zonalDistance(zonal) {
  let squaredError = 0;
  let squaredReference = 0;
  for (const band of zonal) {
    if (Math.abs(band.latitudeDeg) - ZONAL_BAND_HALF_WIDTH_DEG > ZONAL_POLAR_LIMIT_DEG) continue;
    squaredError += (band.means.coverage - band.means.thick) ** 2;
    squaredReference += band.means.thick ** 2;
  }
  return Math.sqrt(squaredError) / Math.max(1e-9, Math.sqrt(squaredReference));
}

function toneDistance(toneGlobe) {
  const byKey = new Map(toneGlobe.map((row) => [row.key, row]));
  const coverage = byKey.get('coverage');
  const thick = byKey.get('thick');
  if (!coverage || !thick) return 0;
  let l1 = 0;
  for (let i = 0; i < coverage.shares.length; i++) l1 += Math.abs(coverage.shares[i] - thick.shares[i]);
  return l1 / 2;
}

function spectrumDistance(spectrumGlobe) {
  const terms = [];
  for (const entry of spectrumGlobe) {
    for (const bucket of entry.buckets) {
      if (bucket.ratio > 0) terms.push(Math.log2(bucket.ratio) ** 2);
    }
  }
  return Math.sqrt(mean(terms));
}

function structureDistance(structureGlobe, structureCaps) {
  const pairs = [['thick', 'coverage'], ['veil', 'translucent']];
  const terms = [];
  const collect = (rows) => {
    for (const row of rows) {
      const byField = new Map(row.fields.map((field) => [field.field, field]));
      for (const [referenceKey, generatedKey] of pairs) {
        const reference = byField.get(referenceKey);
        const generated = byField.get(generatedKey);
        if (!reference || !generated) continue;
        terms.push(Math.abs(generated.coherence - reference.coherence));
        terms.push(Math.abs(generated.r - reference.r));
      }
    }
  };
  for (const band of structureGlobe) collect(band.rows);
  for (const cap of structureCaps) collect(cap.rows);
  return mean(terms);
}

function shapeFaceDistance(reference, generated) {
  return mean([
    absLogRatio(generated.count, reference.count),
    absLogRatio(generated.areaKm2.median, reference.areaKm2.median),
    Math.abs(generated.largestShare - reference.largestShare),
    absLogRatio(generated.perimeterPerArea, reference.perimeterPerArea),
    Math.abs(generated.holeAreaShare - reference.holeAreaShare),
  ]);
}

function shapesDistance(shapes) {
  const faces = [shapeFaceDistance(shapes.globe.reference, shapes.globe.generated)];
  for (const cap of shapes.caps) faces.push(shapeFaceDistance(cap.reference, cap.generated));
  return mean(faces);
}

function terrainDistance(terrain) {
  const byField = new Map(terrain.map((entry) => [entry.field, entry]));
  const pairs = [['thick', 'coverage'], ['veil', 'translucent'], ['photo', 'composite']];
  const terms = [];
  for (const [referenceKey, generatedKey] of pairs) {
    const reference = byField.get(referenceKey);
    const generated = byField.get(generatedKey);
    if (!reference || !generated) continue;
    terms.push(Math.abs(generated.cloudinessCorr - reference.cloudinessCorr));
    terms.push(Math.abs(generated.elevationCorr - reference.elevationCorr));
  }
  return mean(terms);
}

function capMeansDistance(capMeans) {
  const terms = [];
  for (const cap of capMeans) {
    terms.push(Math.abs(cap.means.coverage - cap.means.thick));
    terms.push(Math.abs(cap.means.composite - cap.means.photo));
  }
  return mean(terms);
}

function motionConsistencyDistance(drift) {
  const terms = [];
  for (const band of drift) {
    const angleTerm = band.angleDeg === null ? 0 : band.angleDeg / 180;
    const speedTerm = band.speedRatio === null || band.speedRatio <= 0 ? 0 : Math.abs(Math.log2(band.speedRatio));
    terms.push((angleTerm + speedTerm) / 2);
  }
  return mean(terms);
}

// 実物の動きと生成の動きの距離。箱ごとに、相関曲線の差(時刻 0 を除く各時刻の |Δ相関| の
// 平均)と、移流ベクトルの差(向きの差と速さ比)を項とする。移流は生成の composite 対 実物
// 赤外で比べる(積雲の不透明度は参考値で、距離には入れない)。片方の速さだけが 0 のとき、向きの差
// と速さ比はどちらも「最も違う」として 1 とする。
function motionReferenceDistance(referenceMotion) {
  const terms = [];
  for (const box of referenceMotion.boxes) {
    const reference = box.reference;
    const generated = box.generated.composite;
    let corrDiff = 0;
    let count = 0;
    for (let i = 1; i < reference.correlations.length; i++) {
      corrDiff += Math.abs(reference.correlations[i] - generated.correlations[i]);
      count++;
    }
    terms.push(count > 0 ? corrDiff / count : 0);
    const refSpeed = reference.drift.driftSpeedMs;
    const genSpeed = generated.drift.driftSpeedMs;
    const dot = reference.drift.driftMs.east * generated.drift.driftMs.east
      + reference.drift.driftMs.north * generated.drift.driftMs.north;
    const angleTerm = refSpeed > 0 && genSpeed > 0
      ? Math.acos(Math.min(1, Math.max(-1, dot / (refSpeed * genSpeed)))) / Math.PI
      : (refSpeed === 0 && genSpeed === 0 ? 0 : 1);
    const speedTerm = refSpeed > 0 && genSpeed > 0
      ? Math.abs(Math.log2(genSpeed / refSpeed))
      : (refSpeed === genSpeed ? 0 : 1);
    terms.push((angleTerm + speedTerm) / 2);
  }
  return mean(terms);
}

// 雲頂高度の分布の距離。地域・部位ごとに、生成の雲頂分位と MODIS の雲頂分位を比べる。
// 中央値と四分位幅のずれを 5000 m で割って無次元化し、高さ帯の割合のずれと平均する。
// 雲のある面積は入れない — 生成は被覆率 > 0.3、実写は MODIS の雲マスクと、「雲がある」
// の定義が違うため。面積のずれは capMeans と zonal が既に測っている。
// 実写の above12 は 0 で固定される — カラーマップが 12000 m で切れ、それ以上は 1 色に
// 潰れるため、12000 m 超の割合を実写側は持たない。above12 の項は、生成の 12000 m 超の
// 割合を 0 と比べる片側の項になる。
const CLOUD_TOP_SCALE_M = 5000;

function cloudTopDistance(generated, reference) {
  const referenceByKey = new Map(reference.entries.map((entry) => [`${entry.region}/${entry.part}`, entry.stats]));
  const terms = [];
  for (const entry of generated) {
    const ref = referenceByKey.get(`${entry.region}/${entry.part}`);
    if (!ref) continue;
    const gen = entry.stats;
    terms.push(
      Math.abs(gen.median - ref.median) / CLOUD_TOP_SCALE_M,
      Math.abs(gen.iqr - ref.iqr) / CLOUD_TOP_SCALE_M,
      Math.abs(gen.below3 - ref.below3),
      Math.abs(gen.middle - ref.middle),
      Math.abs(gen.above9 - ref.above9),
      Math.abs(gen.above12 - ref.above12),
    );
  }
  return mean(terms);
}

// 微細構造の距離。描画の撮影と実写の高解像度参照を、尺度帯 [2000–200 / 200–20 / 20–2 km]
// ごとに比べる。帯の電力割合・箱次元・空隙率・帯域成分の形を項にし、主の梯子で測った帯だけを
// 入れる (2000 km の梯子での 200–20 km 帯は交叉確認で、距離には入れない)。
// 項が 1 つも無ければ測れない (null) とし、0 (一致) とは区別する。
function fineSpectrumDistance(fineStructure) {
  const terms = [];
  const logRatio = (generated, reference) => Math.abs(
    Math.log2(Math.max(1e-9, generated) / Math.max(1e-9, reference)));
  for (const pair of fineStructure.pairs) {
    if (pair.distance === false) continue;
    for (const band of pair.visible.bands) {
      if (!band.primary) continue;
      terms.push(logRatio(band.generatedShare, band.referenceShare));
      if (band.boxDimension !== null) {
        terms.push(Math.abs(band.boxDimension.generated - band.boxDimension.reference));
      }
      if (band.lacunarity !== null) {
        terms.push(Math.abs(band.lacunarity.generated - band.lacunarity.reference));
      }
      const generated = band.components.generated;
      const reference = band.components.reference;
      terms.push(
        Math.abs(Math.log2(Math.max(1, generated.count) / Math.max(1, reference.count))),
        logRatio(generated.medianAreaKm2, reference.medianAreaKm2),
        Math.abs(generated.largestShare - reference.largestShare),
        logRatio(generated.perimeterPerArea, reference.perimeterPerArea),
      );
    }
  }
  return terms.length === 0 ? null : mean(terms);
}

// 巻雲の筋の距離。向きのずれ (90° のずれを 1 とする — 既存の structure 家族は向きの
// 値を比べず、90° のずれも 0 のずれと同じに扱っていた)、向きの相関長 Lθ の比、
// 帯ごとの揃いのずれを項にする。向きと Lθ は 63 km の尺度・400 km の梯子で読む。
// 項が 1 つも無ければ測れない (null) とし、0 (一致) とは区別する。
function fineStreaksDistance(fineStructure) {
  const terms = [];
  for (const pair of fineStructure.pairs) {
    if (pair.distance === false || pair.streak === null) continue;
    if (pair.ladder === '400km') {
      const scale63 = pair.streak.scales.find((scale) => scale.scaleKm === 63);
      if (scale63 !== undefined) {
        terms.push(orientationDifferenceDeg(
          scale63.generated.orientationDeg, scale63.reference.orientationDeg) / 90);
      }
      const lTheta = pair.streak.lThetaKm;
      if (lTheta !== null && lTheta.generated !== null && lTheta.reference !== null) {
        terms.push(Math.abs(Math.log2(lTheta.generated / lTheta.reference)));
      }
    }
    for (const band of pair.visible.bands) {
      if (!band.primary) continue;
      const centerKm = Math.sqrt(band.loKm * band.hiKm);
      let nearest = null;
      for (const scale of pair.streak.scales) {
        if (nearest === null
          || Math.abs(Math.log(scale.scaleKm / centerKm)) < Math.abs(Math.log(nearest.scaleKm / centerKm))) {
          nearest = scale;
        }
      }
      if (nearest !== null) {
        terms.push(Math.abs(nearest.generated.coherence - nearest.reference.coherence));
      }
    }
  }
  return terms.length === 0 ? null : mean(terms);
}
// 巻雲層だけの電力割合の距離。巻雲層だけの撮影と、帯 13 の輝度温度から切り分けた
// 高層雲の冷たさの場を、尺度帯ごとに比べる。項は主の梯子で測った帯だけ (微細構造の
// 電力割合と同じ取り方)。合成画の fineSpectrum と違い、積雲の明るさが混ざらないので、
// 半透明殻そのものの帯域配分がそのまま出る。
// 項が 1 つも無ければ測れない (null) とし、0 (一致) とは区別する。
function cirrusSpectrumDistance(cirrusStructure) {
  const terms = [];
  const logRatio = (generated, reference) => Math.abs(
    Math.log2(Math.max(1e-9, generated) / Math.max(1e-9, reference)));
  for (const pair of cirrusStructure.pairs) {
    if (pair.distance === false) continue;
    for (const band of pair.bands) {
      if (!band.primary) continue;
      terms.push(logRatio(band.generatedShare, band.referenceShare));
    }
  }
  return terms.length === 0 ? null : mean(terms);
}

// 巻雲層だけの筋の距離。項の作りは fineStreaksDistance と同じ: 向きのずれ (90° を 1)、
// 向きの相関長 Lθ の比、帯ごとの揃いのずれ。向きと Lθ は 63 km の尺度・400 km の梯子。
// 項が 1 つも無ければ測れない (null) とし、0 (一致) とは区別する。
function cirrusStreaksDistance(cirrusStructure) {
  const terms = [];
  for (const pair of cirrusStructure.pairs) {
    if (pair.distance === false || pair.streak === null) continue;
    if (pair.ladder === '400km') {
      const scale63 = pair.streak.scales.find((scale) => scale.scaleKm === 63);
      if (scale63 !== undefined) {
        terms.push(orientationDifferenceDeg(
          scale63.generated.orientationDeg, scale63.reference.orientationDeg) / 90);
      }
      const lTheta = pair.streak.lThetaKm;
      if (lTheta !== null && lTheta.generated !== null && lTheta.reference !== null) {
        terms.push(Math.abs(Math.log2(lTheta.generated / lTheta.reference)));
      }
    }
    for (const band of pair.bands) {
      if (!band.primary) continue;
      const centerKm = Math.sqrt(band.loKm * band.hiKm);
      let nearest = null;
      for (const scale of pair.streak.scales) {
        if (nearest === null
          || Math.abs(Math.log(scale.scaleKm / centerKm)) < Math.abs(Math.log(nearest.scaleKm / centerKm))) {
          nearest = scale;
        }
      }
      if (nearest !== null) {
        terms.push(Math.abs(nearest.generated.coherence - nearest.reference.coherence));
      }
    }
  }
  return terms.length === 0 ? null : mean(terms);
}
// 1/e 交差時間の比。null は梯子の端 (8 h) を超えて 1/e を切らなかった (打ち切り) こと。
// 片方だけ打ち切りなら端の値を代わりにし (下限のずれ)、両方打ち切りなら比べようが無い
// ので項を落とす (0 とは区別する)。
function tauLogRatio(generated, reference) {
  if (generated === null && reference === null) return null;
  const g = generated ?? FINE_MOTION_TAU_CENSOR_HOURS;
  const r = reference ?? FINE_MOTION_TAU_CENSOR_HOURS;
  return Math.abs(Math.log2(g / r));
}

// 2 つの移流ベクトル (東・北成分 [m/s]) の向きの差 [°]。どちらかの速さが 0 なら測れない。
function driftVectorAngle(a, b) {
  const speedA = Math.hypot(a.east, a.north);
  const speedB = Math.hypot(b.east, b.north);
  if (speedA <= 0 || speedB <= 0) return null;
  return (Math.acos(Math.min(1, Math.max(-1, (a.east * b.east + a.north * b.north)
    / (speedA * speedB)))) * 180) / Math.PI;
}

// 微細な動きの距離。帯域別の移流 (向き・速さ) と生滅 (1/e 交差時間) を、生成と実写で
// 比べる。主の梯子で測った帯だけを入れる (fineSpectrum と同じ取り方)。風に対する移流の
// 関係 (向きのずれ・速さ比) の生成と実写のずれも項に入れる — 移流そのもののずれと
// 2 重に数えるが、風に乗っているかどうかがモデルへの手がかりになるため。
// 項が 1 つも無ければ測れない (null) とし、0 (一致) とは区別する。
function fineMotionDistance(fineMotion) {
  const terms = [];
  for (const pair of fineMotion.pairs) {
    if (pair.distance === false) continue;
    for (const band of pair.bands) {
      if (!band.primary) continue;
      const g = band.generated;
      const r = band.reference;
      const angle = driftVectorAngle(g.drift.driftMs, r.drift.driftMs);
      if (angle !== null) terms.push(angle / 180);
      // 速さのずれ。片方が 0 でも測れるよう、速さの差を大きい方の速さで割る (0 が一致、
      // 1 が片方だけ静止)。向きの項が 0 の移流では定義できない分も、この項が拾う。
      const maxSpeed = Math.max(g.drift.driftSpeedMs, r.drift.driftSpeedMs);
      if (maxSpeed > 0) {
        terms.push(Math.abs(g.drift.driftSpeedMs - r.drift.driftSpeedMs) / maxSpeed);
      }
      const tau = tauLogRatio(g.tauHours, r.tauHours);
      if (tau !== null) terms.push(tau);
      if (g.drift.angleDeg !== null && r.drift.angleDeg !== null) {
        terms.push(Math.abs(g.drift.angleDeg - r.drift.angleDeg) / 180);
      }
      // 速さ比はどちらかの移流が 0 だと比が 0 になり log2(0) = -∞ になるので、その項は落とす
      // (移流が無いことは向きの項と τ の項で既に表れる)。
      if (g.drift.speedRatio !== null && g.drift.speedRatio > 0
        && r.drift.speedRatio !== null && r.drift.speedRatio > 0) {
        terms.push(Math.abs(Math.log2(g.drift.speedRatio / r.drift.speedRatio)));
      }
    }
  }
  return terms.length === 0 ? null : mean(terms);
}

// 陸海の層別の距離。帯域別の生滅 (1/e 交差時間) を陸のタイルと海のタイルに分けて比べ、
// 陸海のコントラスト (陸の τ − 海の τ) のずれも項に入れる。タイルが無い類 (海だけの対の
// 陸など) の項は落とす。陸のタイルが 1 つも無い対では海の項だけが残る。
// 項が 1 つも無ければ測れない (null) とし、0 (一致) とは区別する。
function fineStrataDistance(fineMotion) {
  const terms = [];
  for (const pair of fineMotion.pairs) {
    if (pair.distance === false) continue;
    for (const band of pair.strata) {
      if (!band.primary) continue;
      const g = band.generated;
      const r = band.reference;
      if (g === null || r === null) continue;
      const landOk = g.land.tiles > 0 && r.land.tiles > 0;
      const seaOk = g.sea.tiles > 0 && r.sea.tiles > 0;
      if (landOk) {
        const landTau = tauLogRatio(g.land.tauHours, r.land.tauHours);
        if (landTau !== null) terms.push(landTau);
      }
      if (seaOk) {
        const seaTau = tauLogRatio(g.sea.tauHours, r.sea.tauHours);
        if (seaTau !== null) terms.push(seaTau);
      }
      if (landOk && seaOk && g.land.tauHours !== null && g.sea.tauHours !== null
        && r.land.tauHours !== null && r.sea.tauHours !== null) {
        terms.push(Math.abs((g.land.tauHours - g.sea.tauHours)
          - (r.land.tauHours - r.sea.tauHours)) / FINE_MOTION_TAU_CENSOR_HOURS);
      }
    }
  }
  return terms.length === 0 ? null : mean(terms);
}

// 筋の風に対する向きの距離。63 km の尺度・400 km の梯子で読んだ筋の向きを、箱の平均の
// 地表風に対する揃い (1 が風と平行) へ直し、生成と実写のずれを項にする。風は地表風で、
// 筋は上層のもの — 両側に同じ風を使う相対の比較で、絶対の風向のずれは入らない。
// 項が 1 つも無ければ測れない (null) とし、0 (一致) とは区別する。
function fineStreakWindDistance(fineStructure, fineMotion) {
  const terms = [];
  const windByKey = new Map((fineMotion?.pairs ?? []).map((pair) => [`${pair.region}-${pair.ladder}`, pair.windMs]));
  for (const pair of fineStructure.pairs) {
    if (pair.distance === false || pair.streak === null || pair.ladder !== '400km') continue;
    const windMs = windByKey.get(`${pair.region}-${pair.ladder}`);
    if (windMs === undefined || windMs === null) continue;
    const scale63 = pair.streak.scales.find((scale) => scale.scaleKm === 63);
    if (scale63 === undefined) continue;
    const g = windRelativeAlignment(scale63.generated.orientationDeg, windMs);
    const r = windRelativeAlignment(scale63.reference.orientationDeg, windMs);
    if (g === null || r === null) continue;
    terms.push(Math.abs(g.alignment - r.alignment));
  }
  return terms.length === 0 ? null : mean(terms);
}

export function computeDistances(sections) {
  const families = {};
  if (sections.zonal) families.zonal = zonalDistance(sections.zonal);
  if (sections.toneGlobe) families.tone = toneDistance(sections.toneGlobe);
  if (sections.flatness) families.flatness = Math.abs(sections.flatness.coverage - sections.flatness.thick);
  if (sections.spectrumGlobe) families.spectrum = spectrumDistance(sections.spectrumGlobe);
  if (sections.structureGlobe && sections.structureCaps) {
    families.structure = structureDistance(sections.structureGlobe, sections.structureCaps);
  }
  if (sections.shapes) families.shapes = shapesDistance(sections.shapes);
  if (sections.terrain) families.terrain = terrainDistance(sections.terrain);
  if (sections.capMeans) families.capMeans = capMeansDistance(sections.capMeans);
  if (sections.motion?.drift) families.motionConsistency = motionConsistencyDistance(sections.motion.drift);
  if (sections.referenceMotion?.boxes?.length) {
    families.motionReference = motionReferenceDistance(sections.referenceMotion);
  }
  if (sections.cloudTop && sections.cloudTopReference?.entries?.length) {
    families.cloudTop = cloudTopDistance(sections.cloudTop, sections.cloudTopReference);
  }
  if (sections.fineStructure?.pairs?.length) {
    const fineSpectrum = fineSpectrumDistance(sections.fineStructure);
    if (fineSpectrum !== null) families.fineSpectrum = fineSpectrum;
    const fineStreaks = fineStreaksDistance(sections.fineStructure);
    if (fineStreaks !== null) families.fineStreaks = fineStreaks;
  }
  if (sections.fineMotion?.pairs?.length) {
    const fineMotion = fineMotionDistance(sections.fineMotion);
    if (fineMotion !== null) families.fineMotion = fineMotion;
    const fineStrata = fineStrataDistance(sections.fineMotion);
    if (fineStrata !== null) families.fineStrata = fineStrata;
    if (sections.fineStructure?.pairs?.length) {
      const fineStreakWind = fineStreakWindDistance(sections.fineStructure, sections.fineMotion);
      if (fineStreakWind !== null) families.fineStreakWind = fineStreakWind;
    }
  }
  // 巻雲の 2 家族は既存の家族と同じく index の平均へ加える (新しい家族は現れた
  // commit から index に入る — 微細構造・微細な動きの追加時と同じ流儀)。
  if (sections.cirrusStructure?.pairs?.length) {
    const cirrusSpectrum = cirrusSpectrumDistance(sections.cirrusStructure);
    if (cirrusSpectrum !== null) families.cirrusSpectrum = cirrusSpectrum;
    const cirrusStreaks = cirrusStreaksDistance(sections.cirrusStructure);
    if (cirrusStreaks !== null) families.cirrusStreaks = cirrusStreaks;
  }
  return { families, index: mean(Object.values(families)) };
}
