// レポートの sections から、生成と実写の「距離」を家族ごとに 1 数へ落とす純粋関数。
// 距離はすべて無次元で 0 が一致 — 帯の平均のずれ、階調の分布のずれ、塊の形のずれ、のように
// 家族ごとに物差しを正規化し、モデル変更の前後で「どの家族がどれだけ実写へ近づいたか」を
// 機械的に比べられるようにする。sections だけから計算するので、過去のレポートにも同じ
// 定義で後から計算できる (距離の定義を変えたら履歴全体へ適用し直せる)。
//
// 総和の index は家族の平均で、追跡用の指数にすぎない。判定は家族ごとに行うこと —
// 1 つの家族の悪化を、平均が他の改善で隠すためではない。

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
// 赤外で比べる(被覆率は参考値で、距離には入れない)。片方の速さだけが 0 のとき、向きの差
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

// sections を受けて、家族ごとの距離と追跡用の index を返す。節が欠けているレポート
// (古い版) では、その家族は 0 でなく「測れない」として落とし、index の平均からも除く。
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
  return { families, index: mean(Object.values(families)) };
}
