// 雲の形態特徴と統計の物差しを、合成の場と合成の標本で検算する。引数なし。
// 全部 PASS なら終了コード 0、1 つでも FAIL なら 1。実写の教師には触らない。
import { cloudSignalField, tileFeatures, tileFeaturesFromPng } from './cloud-regime-features.mjs';
import { isccpPhysical } from './cloud-regime-generated.mjs';
import { encodeRgbPng } from './png.mjs';
import {
  bootstrapByScene,
  explainedVariance,
  rankNormalize,
  regimeTable,
  REGIMES,
  responseCurve,
  responseDistance,
  variogram,
  variogramDistance,
  withAlignment,
} from './cloud-regime-metrics.mjs';

const KM_PER_PX = 4;
const results = [];

function check(name, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ${detail}`);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  const u = Math.max(rng(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

// 幅 w・高さ h の場を f(x, y) で作る(x は列、y は行)。
function field(w, h, f) {
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data[y * w + x] = f(x, y);
  return { width: w, height: h, data };
}

// 1 タイル(64 px)の特徴量。
function tileOf(f) {
  return tileFeatures(field(64, 64, f), KM_PER_PX)[0].features;
}

// 波長 32 km の縞。alphaDeg は縞が伸びる向き(東から反時計回り)。
// 東 = x 増加、北 = y 減少。縞は伸びる向きに一定で、直交する向きに振動する。
function stripe(alphaDeg) {
  const a = (alphaDeg * Math.PI) / 180;
  return (x, y) => {
    const east = x * KM_PER_PX;
    const north = -y * KM_PER_PX;
    const u = -Math.sin(a) * east + Math.cos(a) * north;
    return 0.5 + 0.4 * Math.sin((2 * Math.PI * u) / 32);
  };
}

// 方位の差(180 度の周期を考慮)。
const axialDiff = (a, b) => {
  const d = Math.abs(a - b) % 180;
  return Math.min(d, 180 - d);
};

// 1 タイルを 16 px 格子の円盤(半径 5 px)にする。cloudBase が雲の値、hole は円盤を穴にするか。
function discs(cloudBase, hole) {
  return (x, y) => {
    let inside = false;
    for (let cy = 8; cy < 256; cy += 16) {
      for (let cx = 8; cx < 256; cx += 16) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= 25) inside = true;
      }
    }
    return hole ? (inside ? 0 : cloudBase) : (inside ? cloudBase : 0);
  };
}

// 条件 c に線形に従う実写の標本、または応答しない生成の標本。scene は 40 場面に散らす。
function responseSamples(n, side, rng, offset, respond) {
  const samples = [];
  for (let i = 0; i < n; i++) {
    const c = rng();
    const value = (respond ? 2 * c : 0) + offset + 0.2 * gaussian(rng);
    samples.push({
      side,
      scene: `s${i % 40}`,
      tile: `r0c${i}`,
      xKm: 0,
      yKm: 0,
      features: { cover: value },
      conditions: { lift: c },
    });
  }
  return samples;
}

// 8×8 格子のタイルを持つ場面群(256 km 間隔)。値は関数 f(xKm, yKm, rng) で決める。
function sceneGrid(sceneCount, rng, valueOf) {
  const samples = [];
  for (let s = 0; s < sceneCount; s++) {
    for (let r = 0; r < 8; r++) {
      for (let c = 0; c < 8; c++) {
        const xKm = (c - 3.5) * 256;
        const yKm = (3.5 - r) * 256;
        samples.push({
          side: 'real',
          scene: `g${s}`,
          tile: `r${r}c${c}`,
          xKm,
          yKm,
          features: { f: valueOf(xKm, yKm, rng) },
          conditions: {},
        });
      }
    }
  }
  return samples;
}

// 1. 形態特徴
{
  const flat = tileOf(() => 0.6);
  check('一様 0.6: cover 1・edge 0・aniso 0',
    flat.cover === 1 && flat.edge === 0 && flat.aniso === 0,
    `cover=${flat.cover} edge=${flat.edge} aniso=${flat.aniso}`);
  // 設計の表は euler を「小さい正」と書くが、2×2 の四つ組はタイルの内側だけ((n−1)² 個)数える。
  // 雲が全面に広がると角(Q1・Q3・QD)が一つも現れず、数え上げは 0 になる。判定は 0 で一致させる。
  check('一様 0.6: euler は 0(内側の四つ組に角が無い)',
    Math.abs(flat.euler) < 1e-9, `euler=${flat.euler}`);

  const empty = tileOf(() => 0);
  check('一様 0: cover 0・toneCloud null・scaleKm null・texture 0',
    empty.cover === 0 && empty.toneCloud === null && empty.scaleKm === null && empty.texture === 0,
    `cover=${empty.cover} toneCloud=${empty.toneCloud} scaleKm=${empty.scaleKm} texture=${empty.texture}`);

  const ew = tileOf(stripe(0));
  check('東西の縞: orientDeg ≈ 0(±5)', axialDiff(ew.orientDeg, 0) <= 5, `orientDeg=${ew.orientDeg?.toFixed(2)}`);
  check('東西の縞: aniso > 0.8', ew.aniso > 0.8, `aniso=${ew.aniso.toFixed(3)}`);
  check('東西の縞: scaleKm ≈ 32(±25%)', Math.abs(ew.scaleKm / 32 - 1) <= 0.25, `scaleKm=${ew.scaleKm.toFixed(2)}`);

  const ns = tileOf(stripe(90));
  check('南北の縞: orientDeg ≈ 90(±5)', axialDiff(ns.orientDeg, 90) <= 5, `orientDeg=${ns.orientDeg?.toFixed(2)}`);

  const ne = tileOf(stripe(45));
  check('北東−南西の縞: orientDeg ≈ 45(±5)', axialDiff(ne.orientDeg, 45) <= 5, `orientDeg=${ne.orientDeg?.toFixed(2)}`);

  // 円盤は 256 px の場の 16 タイルで測る。どのタイルの中にも円盤は 16 個、完全に収まる。
  const plate = tileFeatures(field(256, 256, discs(0.8, false)), KM_PER_PX);
  const holes = tileFeatures(field(256, 256, discs(0.8, true)), KM_PER_PX);
  const areaKm2 = (64 * KM_PER_PX) ** 2;
  const expectedCover = (Math.PI * 25) / 256;
  const plateOk = plate.every((t) => Math.abs(t.features.euler * (areaKm2 / 1e4) / 16 - 1) <= 0.2);
  check('孤立した円盤: euler > 0 で、円盤の数 ÷ 面積が 16 ÷ 65536 km² に ±20%',
    plate.every((t) => t.features.euler > 0) && plateOk,
    `euler=${plate[0].features.euler.toFixed(3)} 個数換算=${(plate[0].features.euler * areaKm2 / 1e4).toFixed(2)}`);
  check('円盤の被覆: cover ≈ π·25/256(±5%)',
    plate.every((t) => Math.abs(t.features.cover / expectedCover - 1) <= 0.05),
    `cover=${plate[0].features.cover.toFixed(4)} 期待=${expectedCover.toFixed(4)}`);
  check('雲の板の穴: euler < 0 で、穴の数 ≈ 16 個(±20%)',
    holes.every((t) => t.features.euler < 0 && Math.abs(t.features.euler * (areaKm2 / 1e4) / -16 - 1) <= 0.2),
    `euler=${holes[0].features.euler.toFixed(3)} 個数換算=${(holes[0].features.euler * areaKm2 / 1e4).toFixed(2)}`);

  // 32 km(8 px)の市松: 雲と晴れが 32 px の四角で交互。ブロック(8 px)は 0 か 1 に分かれる。
  const checker = tileOf((x, y) => ((Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0 ? 0.8 : 0));
  check('市松(32 px): clump ≈ 1(±0.02)', Math.abs(checker.clump - 1) <= 0.02, `clump=${checker.clump.toFixed(4)}`);

  const rng = mulberry32(7);
  const noise = tileOf(() => (rng() < 0.5 ? 0.8 : 0));
  check('白色雑音(cover 0.5): clump < 0.1', Math.abs(noise.cover - 0.5) < 0.1 && noise.clump < 0.1,
    `cover=${noise.cover.toFixed(3)} clump=${noise.clump.toFixed(4)}`);
}

// 2. 統計
{
  const rng = mulberry32(11);
  const real = responseSamples(20000, 'real', rng, 0, true);
  const generated = responseSamples(20000, 'generated', rng, 0.5, false);
  const sameLaw = responseSamples(20000, 'generated', rng, 0, true);
  const offset = responseSamples(20000, 'generated', rng, 0.3, true);

  const responseDistanceNonResponding = responseDistance(real, generated, 'lift', 'cover');
  check('応答しない生成: gainRatio < 0.2', responseDistanceNonResponding.gainRatio < 0.2,
    `gainRatio=${responseDistanceNonResponding.gainRatio?.toFixed(4)}`);
  check('応答しない生成: contrast > 0.5', responseDistanceNonResponding.contrast > 0.5,
    `contrast=${responseDistanceNonResponding.contrast?.toFixed(3)}`);
  const etaReal = explainedVariance(real, 'lift', 'cover');
  const etaGenerated = explainedVariance(generated, 'lift', 'cover');
  check('説明分散: 実写 > 0.5 かつ 生成 < 0.05', etaReal > 0.5 && etaGenerated < 0.05,
    `η²(実写)=${etaReal.toFixed(3)} η²(生成)=${etaGenerated.toFixed(4)}`);

  const same = responseDistance(real, sameLaw, 'lift', 'cover');
  check('同じ法則の生成: |bias| < 0.1・contrast < 0.1・gainRatio 0.8〜1.25・corr > 0.95',
    Math.abs(same.bias) < 0.1 && same.contrast < 0.1 && same.gainRatio >= 0.8 && same.gainRatio <= 1.25 && same.corr > 0.95,
    `bias=${same.bias.toFixed(4)} contrast=${same.contrast.toFixed(4)} gainRatio=${same.gainRatio.toFixed(3)} corr=${same.corr.toFixed(4)}`);

  // scale は実写の四分位範囲 ÷ 1.349 で決まる。期待する bias も同じ式で作る。
  const realValues = real.map((s) => s.features.cover).sort((a, b) => a - b);
  const q = (p) => {
    const pos = (realValues.length - 1) * p;
    const lo = Math.floor(pos);
    return realValues[lo] + (realValues[lo + 1] - realValues[lo]) * (pos - lo);
  };
  const scale = (q(0.75) - q(0.25)) / 1.349;
  const shifted = responseDistance(real, offset, 'lift', 'cover');
  const expectedBias = 0.3 / scale;
  check('定数の偏り 0.3: bias ≈ 0.3 ÷ scale(±10%)・contrast < 0.1',
    Math.abs(shifted.bias / expectedBias - 1) <= 0.1 && shifted.contrast < 0.1,
    `bias=${shifted.bias.toFixed(4)} 期待=${expectedBias.toFixed(4)} contrast=${shifted.contrast.toFixed(4)}`);

  const ranks = rankNormalize([3, 1, 3, null, 2]);
  const rankOk = Math.abs(ranks[0] - 2.5 / 3) < 1e-12 && ranks[0] === ranks[2]
    && ranks[1] === 0 && Math.abs(ranks[4] - 1 / 3) < 1e-12 && ranks[3] === null;
  check('rankNormalize: 同値は平均順位・null は保持', rankOk, `ranks=${JSON.stringify(ranks)}`);

  // 場面内で空間相関の無い値 → 各帯の γ ≈ 分散(1)。
  const iid = sceneGrid(40, mulberry32(3), (x, y, r) => gaussian(r));
  const iidGamma = variogram(iid, 'f');
  check('空間相関の無い標本: 全帯で γ ≈ 1(±15%)',
    iidGamma.every((b) => b.gamma !== null && Math.abs(b.gamma - 1) <= 0.15),
    `γ=${iidGamma.map((b) => (b.gamma ?? NaN).toFixed(3)).join(' ')}`);

  // 800 km の線形の傾斜。γ は距離とともに増える。
  const ramp = sceneGrid(10, mulberry32(4), (x) => x / 800);
  const rampGamma = variogram(ramp, 'f').map((b) => b.gamma);
  const monotone = rampGamma.every((g, i) => i === 0 || g > rampGamma[i - 1]);
  check('線形の傾斜(800 km): γ は距離とともに単調に増える', monotone,
    `γ=${rampGamma.map((g) => (g ?? NaN).toExponential(3)).join(' ')}`);

  const vdReal = sceneGrid(40, mulberry32(5), (x, y, r) => gaussian(r));
  const vdGenerated = sceneGrid(40, mulberry32(6), (x, y, r) => gaussian(r));
  const vd = variogramDistance(vdReal, vdGenerated, 'f');
  check('バリオグラムの距離(同じ分布): distance < 0.15', vd.distance !== null && vd.distance < 0.15,
    `distance=${vd.distance?.toFixed(4)}`);

  const statistic = (r, g) => {
    const mean = (xs) => xs.reduce((s, x) => s + x.features.f, 0) / xs.length;
    return mean(g) - mean(r);
  };
  const b1 = bootstrapByScene(vdReal, vdGenerated, statistic, { resamples: 200, seed: 9 });
  const b2 = bootstrapByScene(vdReal, vdGenerated, statistic, { resamples: 200, seed: 9 });
  check('bootstrapByScene: 同じ seed で同じ結果・5% ≤ 中央値 ≤ 95%',
    JSON.stringify(b1) === JSON.stringify(b2) && b1.p05 <= b1.median && b1.median <= b1.p95,
    `median=${b1.median.toFixed(4)} [${b1.p05.toFixed(4)}, ${b1.p95.toFixed(4)}]`);

  const aligned = withAlignment([
    { features: { aniso: 0.5, orientDeg: 30 }, conditions: { windLowDir: 30, windUpDir: 120 } },
    { features: { aniso: 0.5, orientDeg: 30 }, conditions: { windLowDir: 120, windUpDir: 210 } },
  ]);
  // cos(90°) は浮動小数で 6e-17 になるので、0 と 1 は許容差で比べる。
  const near = (v, target) => Math.abs(v - target) < 1e-9;
  const alignOk = near(aligned[0].features.alignLow, 1) && near(aligned[0].features.alignUp, 0)
    && near(aligned[1].features.alignLow, 0) && near(aligned[1].features.alignUp, 1);
  check('withAlignment: 向きの差 0 → 1、90 → 0、180 → 1', alignOk,
    `low=${aligned[0].features.alignLow} up=${aligned[0].features.alignUp}`);

  const curve = responseCurve(real, 'lift', 'cover', 5);
  check('responseCurve: 5 ビンとも n = 4000(順位で等分)', curve.length === 5 && curve.every((c) => c.n === 4000),
    `n=${curve.map((c) => c.n).join(' ')}`);

  // 型の判定は null の条件を見ない。cold(寒気)は advection が null のとき入らない。
  const nullRank = { advection: null, lift: 0.1 };
  const cold = REGIMES.find((r) => r.id === 'cold');
  const coldDescent = REGIMES.find((r) => r.id === 'cold-descent');
  check('REGIMES: 順位が null の条件では型に入らない', !cold.test(nullRank) && !coldDescent.test(nullRank),
    'advection=null, lift=0.1');
  const table = regimeTable([{ conditionsRank: { lift: 0.9, advection: 0.1 }, features: { cover: 0.3 } }], ['cover']);
  check('regimeTable: 上昇域・寒気の標本が入る', table.find((t) => t.id === 'ascent').n === 1
    && table.find((t) => t.id === 'cold').n === 1, `ascent=${table.find((t) => t.id === 'ascent').n}`);

  // 雲の信号(線形 RGB の最小値)。一様な色の 64 px の PNG を 1 タイルとして読む。
  const uniformPng = (r, g, b) => {
    const rgb = new Uint8Array(64 * 64 * 3);
    for (let i = 0; i < 64 * 64; i++) rgb.set([r, g, b], i * 3);
    return encodeRgbPng(64, 64, rgb);
  };
  // 線形の値を sRGB の 8bit へ(cloudSignalField の逆写像)。
  const toSrgbByte = (linear) => Math.round(255 * (linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055));
  const sandPng = uniformPng(toSrgbByte(0.5), toSrgbByte(0.4), toSrgbByte(0.2));
  const sandSignal = cloudSignalField(sandPng).data[0];
  const sandCover = tileFeaturesFromPng(sandPng, KM_PER_PX)[0].features.cover;
  check('砂色(線形 0.5, 0.4, 0.2)の信号は最小の 0.2・被覆は 0(閾値 0.25 の下)',
    Math.abs(sandSignal - 0.2) < 0.01 && sandCover === 0,
    `signal=${sandSignal.toFixed(4)} cover=${sandCover}`);
  const whiteCover = tileFeaturesFromPng(uniformPng(255, 255, 255), KM_PER_PX)[0].features.cover;
  check('白(線形 1, 1, 1)の被覆は 1', whiteCover === 1, `cover=${whiteCover}`);

  // 生成の照明: 数値で割った値は照明に反比例し、画素ごとの配列でも同じ値になる。
  const grayPng = uniformPng(200, 200, 200);
  const full = cloudSignalField(grayPng, { illumination: 1 }).data[0];
  const half = cloudSignalField(grayPng, { illumination: 0.5 }).data[0];
  const perPixel = cloudSignalField(grayPng, { illumination: new Float32Array(64 * 64).fill(0.5) }).data[0];
  check('照明の割り算: 照明 0.5 は 1 の 2 倍・配列は数値と同じ値',
    Math.abs(half / full - 2) < 1e-4 && half === perPixel,
    `ratio=${(half / full).toFixed(6)} 配列一致=${half === perPixel}`);
}

// 3. 生成のタイルの ISCCP 分類(cloud-regime-generated.mjs の isccpPhysical)。
// 合成の標本点(1 点 = { cumulusTau, cirrusTau, cumulusTopM, cirrusTopM }、面積の重み 1/36)で、
// 巻雲の判定・積雲の面積の読み方・晴天への畳み込み・9 分類の和を確かめる。
{
  const near = (v, target) => Math.abs(v - target) < 1e-9;
  const points = (count, p) => Array.from({ length: count }, () => ({ ...p }));
  const CLASS_NAMES = [
    'cirrus', 'cirrostratus', 'deepConvection',
    'altocumulus', 'altostratus', 'nimbostratus',
    'cumulus', 'stratocumulus', 'stratus',
  ];
  const classSum = (p) => CLASS_NAMES.reduce((s, name) => s + p[name], 0);

  // 巻雲だけ(τ=1 < 3.6・雲頂 10 km): 全点が高層・薄いの雲 → cirrus だけ。
  const cir = isccpPhysical(points(36, { cumulusTau: 0, cirrusTau: 1, cumulusTopM: 2000, cirrusTopM: 10000 }));
  check('巻雲だけの点: 高 × 薄い段の cirrus に畳まれる(cloudFrac=cirrus=topHighFrac=tauThinFrac=1)',
    near(cir.cloudFrac, 1) && near(cir.cirrus, 1) && near(cir.topHighFrac, 1)
      && near(cir.tauThinFrac, 1) && near(cir.highThinFrac, 1),
    `cloudFrac=${cir.cloudFrac} cirrus=${cir.cirrus}`);

  // 積雲だけ(τc = ln 2): 雲の面積 f = 1 − exp(−τc) = 0.5。雲の中の τ = τc/f ≈ 1.39 → 薄い、
  // 雲頂 2 km → 低い → cumulus。
  const tau = Math.log(2);
  const cum = isccpPhysical(points(36, { cumulusTau: tau, cirrusTau: 0, cumulusTopM: 2000, cirrusTopM: 0 }));
  check('積雲だけの点: cloudFrac = 1 − exp(−τ) = 0.5、cumulus・topLowFrac へ同じ割合',
    near(cum.cloudFrac, 0.5) && near(cum.cumulus, 0.5) && near(cum.topLowFrac, 0.5),
    `cloudFrac=${cum.cloudFrac} cumulus=${cum.cumulus} topLow=${cum.topLowFrac}`);

  // 不透明度 f < 0.02(τc = 0.01 → f ≈ 0.00995)の点は全面を晴天にする。
  const thin = isccpPhysical(points(36, { cumulusTau: 0.01, cirrusTau: 0, cumulusTopM: 2000, cirrusTopM: 0 }));
  check('積雲の不透明度 < 0.02 の点は晴天(cloudFrac = 0)', thin.cloudFrac === 0, `cloudFrac=${thin.cloudFrac}`);

  // 検出下限(0.3)を下回る巻雲は雲の判定へ入らないが、積雲の雲の τ には足される
  // (τ = τc/f + τci ≈ 1.59 — まだ薄い・低い = cumulus)。
  const sub = isccpPhysical(points(36, { cumulusTau: tau, cirrusTau: 0.2, cumulusTopM: 2000, cirrusTopM: 10000 }));
  check('検出下限の巻雲は高層へ畳まれない(積雲の面積・低い雲頂のまま)',
    near(sub.cloudFrac, 0.5) && near(sub.cumulus, 0.5) && sub.topHighFrac === 0,
    `cloudFrac=${sub.cloudFrac} cumulus=${sub.cumulus} topHigh=${sub.topHighFrac}`);

  // 混在: 半分が巻雲(高・薄い)、半分が厚い積雲(低・τ = 30 > 23 → stratus)。9 分類の和 = cloudFrac。
  const mixed = isccpPhysical([
    ...points(18, { cumulusTau: 0, cirrusTau: 1, cumulusTopM: 2000, cirrusTopM: 10000 }),
    ...points(18, { cumulusTau: 30, cirrusTau: 0, cumulusTopM: 2000, cirrusTopM: 0 }),
  ]);
  check('混在した点: 9 分類の割合の和が cloudFrac に一致',
    near(classSum(mixed), mixed.cloudFrac) && near(mixed.cloudFrac, 1)
      && near(mixed.cirrus, 0.5) && near(mixed.stratus, 0.5) && near(mixed.tauThickFrac, 0.5),
    `和=${classSum(mixed).toFixed(4)} cloudFrac=${mixed.cloudFrac} cirrus=${mixed.cirrus} stratus=${mixed.stratus}`);

  // 全面が晴天の点では median 系は null、雲の割合は 0。
  const clear = isccpPhysical(points(36, { cumulusTau: 0, cirrusTau: 0, cumulusTopM: 2000, cirrusTopM: 0 }));
  check('晴天だけのタイル: cloudFrac = 0・tauMedian・topKmMedian は null',
    clear.cloudFrac === 0 && clear.tauMedian === null && clear.topKmMedian === null && classSum(clear) === 0,
    `cloudFrac=${clear.cloudFrac} tauMedian=${clear.tauMedian}`);
}

const failed = results.filter((ok) => !ok).length;
console.log(`\n合計 ${results.length} 件: PASS ${results.length - failed} / FAIL ${failed}`);
process.exitCode = failed > 0 ? 1 : 0;
