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

function zonalDistance(zonal) {
  let squaredError = 0;
  let squaredReference = 0;
  for (const band of zonal) {
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
  return { families, index: mean(Object.values(families)) };
}
