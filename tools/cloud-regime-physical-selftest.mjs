// cloud-regime-physical の検算。ネットワークを使わず、合成の τ・雲頂・欠測の
// 画素列から 9 分類の割合・validFrac・cloudFrac が手計算と一致すること、
// 境界の値(τ = 3.6・23、雲頂 = 3.2・6.5 km / 680・440 hPa)がどちらの段へ入るか、
// validFrac < 0.5 で割合が null になることを確かめる。
import { isccpClassOf, summarizeTile } from './cloud-regime-physical.mjs';

let failures = 0;
function check(name, actual, expected, eps = 1e-9) {
  const ok = typeof expected === 'number' && typeof actual === 'number'
    ? Math.abs(actual - expected) <= eps
    : actual === expected;
  if (ok) {
    console.log(`PASS ${name}`);
  } else {
    failures++;
    console.log(`FAIL ${name}: ${JSON.stringify(actual)} != ${JSON.stringify(expected)}`);
  }
}

const cell = (tau, topKm, ice = null) => ({ missing: false, cloud: true, tau, topKm, topHpa: null, ice });
const cellHpa = (tau, topHpa) => ({ missing: false, cloud: true, tau, topKm: null, topHpa, ice: null });
const missingCell = { missing: true, cloud: false, tau: null, topKm: null, topHpa: null, ice: null };
const clearPixel = { missing: false, cloud: false, tau: null, topKm: null, topHpa: null, ice: null };

// --- τ の境界: 3.6・23 ---
check('τ=3.5 は薄い', isccpClassOf(3.5, 1, null), 'cumulus');
check('τ=3.6 は中', isccpClassOf(3.6, 1, null), 'stratocumulus');
check('τ=22.9 は中', isccpClassOf(22.9, 10, null), 'cirrostratus');
check('τ=23 は厚い', isccpClassOf(23, 10, null), 'deepConvection');

// --- 雲頂高度の境界: 3.2・6.5 km ---
check('雲頂=3.1 km は低い', isccpClassOf(30, 3.1, null), 'stratus');
check('雲頂=3.2 km は中', isccpClassOf(1, 3.2, null), 'altocumulus');
check('雲頂=6.5 km は中', isccpClassOf(30, 6.5, null), 'nimbostratus');
check('雲頂=6.6 km は高い', isccpClassOf(1, 6.6, null), 'cirrus');

// --- 雲頂気圧の境界: 680・440 hPa ---
check('雲頂=700 hPa は低い', isccpClassOf(30, null, 700), 'stratus');
check('雲頂=680 hPa は中', isccpClassOf(1, null, 680), 'altocumulus');
check('雲頂=440 hPa は中', isccpClassOf(30, null, 440), 'nimbostratus');
check('雲頂=430 hPa は高い', isccpClassOf(1, null, 430), 'cirrus');

// --- τ か雲頂が欠けると 9 分類へ入らない ---
check('雲頂なしは 9 分類外', isccpClassOf(5, null, null), null);
check('τ なしは 9 分類外', isccpClassOf(null, 5, null), null);

// --- タイルの畳み込み: 100 画素(欠測 40・晴天 20・雲 40) ---
// 雲 40 = cirrus 10(τ=1, 10 km, 氷) + deepConvection 5(τ=30, 10 km, 氷)
//       + cumulus 10(τ=1, 1 km, 水) + stratus 5(τ=30, 1 km, 水)
//       + altostratus 5(τ=10, 5 km, 水) + 高さ不明 5(τ=5, 相なし)
const cells = [
  ...Array(40).fill(missingCell),
  ...Array(20).fill(clearPixel),
  ...Array(10).fill(cell(1, 10, true)),
  ...Array(5).fill(cell(30, 10, true)),
  ...Array(10).fill(cell(1, 1, false)),
  ...Array(5).fill(cell(30, 1, false)),
  ...Array(5).fill(cell(10, 5, false)),
  ...Array(5).fill(cell(5, null)),
];
const t = summarizeTile(cells);
const v = 60; // 欠測でない画素数
check('validFrac', t.validFrac, 0.6);
check('cloudFrac', t.cloudFrac, 40 / v);
check('clearFrac', t.clearFrac, 20 / v);
check('cirrus', t.cirrus, 10 / v);
check('deepConvection', t.deepConvection, 5 / v);
check('cumulus', t.cumulus, 10 / v);
check('stratus', t.stratus, 5 / v);
check('altostratus', t.altostratus, 5 / v);
check('cirrostratus', t.cirrostratus, 0);
check('altocumulus', t.altocumulus, 0);
check('nimbostratus', t.nimbostratus, 0);
check('stratocumulus', t.stratocumulus, 0);
check('unknownHeightFrac', t.unknownHeightFrac, 5 / v);
// 9 分類 + 晴天 + 高さ不明 = 1
const sum = t.cirrus + t.cirrostratus + t.deepConvection + t.altocumulus + t.altostratus
  + t.nimbostratus + t.cumulus + t.stratocumulus + t.stratus + t.clearFrac + t.unknownHeightFrac;
check('割合の合計は 1', sum, 1);
// τ の統計: 雲の画素の τ = 1×20, 5×5, 10×5, 30×10 → 中央値 5、p90 30
check('tauMedian', t.tauMedian, 5);
check('tauP90', t.tauP90, 30);
// 雲頂の統計: 雲の画素の雲頂 = 1×15, 5×5, 10×15 → 中央値 5、p90 10
check('topKmMedian', t.topKmMedian, 5);
check('topKmP90', t.topKmP90, 10);
// 雲相: 判明 35 画素のうち氷 15
check('iceFrac', t.iceFrac, 15 / 35);
check('highThinFrac = cirrus', t.highThinFrac, t.cirrus);
check('deepFrac = deepConvection', t.deepFrac, t.deepConvection);

// --- validFrac < 0.5 で割合・統計はすべて null ---
const sparse = summarizeTile([...Array(60).fill(missingCell), ...Array(20).fill(clearPixel), ...Array(20).fill(cell(1, 10))]);
check('validFrac=0.4', sparse.validFrac, 0.4);
check('cloudFrac は null', sparse.cloudFrac, null);
check('cirrus は null', sparse.cirrus, null);
check('unknownHeightFrac は null', sparse.unknownHeightFrac, null);
check('clearFrac は null', sparse.clearFrac, null);
check('tauMedian は null', sparse.tauMedian, null);
check('topKmMedian は null', sparse.topKmMedian, null);
check('iceFrac は null', sparse.iceFrac, null);
check('highThinFrac は null', sparse.highThinFrac, null);
check('deepFrac は null', sparse.deepFrac, null);
check('topHighFrac は null', sparse.topHighFrac, null);
check('noTopFrac は null', sparse.noTopFrac, null);
check('highNoTauFrac は null', sparse.highNoTauFrac, null);
check('tauThinFrac は null', sparse.tauThinFrac, null);

// --- 雲相が取れないタイルは iceFrac が null ---
const noPhase = summarizeTile([...Array(20).fill(clearPixel), ...Array(80).fill(cell(1, 10))]);
check('相なしで iceFrac は null', noPhase.iceFrac, null);

// --- 気圧モードでも畳める(雲頂は km の統計へ入らない) ---
const byHpa = summarizeTile([...Array(10).fill(clearPixel), ...Array(90).fill(cellHpa(1, 300))]);
check('気圧で cirrus', byHpa.cirrus, 90 / 100);
check('気圧で topKmMedian は null', byHpa.topKmMedian, null);

// --- 雲頂の段・τ の段の内訳: 関係式 ---
// 雲頂の段の和 = 雲、9 分類の段ごとの和 + その段で τ が無い雲 = 雲頂の段。
function checkRelations(label, t) {
  check(`${label}: 雲頂の段 3 つ + 雲頂なし = 雲`, t.topHighFrac + t.topMiddleFrac + t.topLowFrac + t.noTopFrac, t.cloudFrac);
  check(`${label}: high の 3 分類 + highNoTau = topHigh`, t.cirrus + t.cirrostratus + t.deepConvection + t.highNoTauFrac, t.topHighFrac);
  check(`${label}: middle の 3 分類 + middleNoTau = topMiddle`, t.altocumulus + t.altostratus + t.nimbostratus + t.middleNoTauFrac, t.topMiddleFrac);
  check(`${label}: low の 3 分類 + lowNoTau = topLow`, t.cumulus + t.stratocumulus + t.stratus + t.lowNoTauFrac, t.topLowFrac);
}
checkRelations('表 t', t);

// 上の表 t の新しい特徴量(v = 60): 高 38 のうち τ 有り 15、中 5、低 15、雲頂なし 5。
check('topHighFrac', t.topHighFrac, 15 / v);
check('topMiddleFrac', t.topMiddleFrac, 5 / v);
check('topLowFrac', t.topLowFrac, 15 / v);
check('noTopFrac', t.noTopFrac, 5 / v);
check('highNoTauFrac (表 t)', t.highNoTauFrac, 0);
check('tauThinFrac', t.tauThinFrac, 20 / v);
check('tauMidFrac', t.tauMidFrac, 10 / v);
check('tauThickFrac', t.tauThickFrac, 10 / v);

// 手で作った混合タイル(欠測 10・晴天 10・雲 80、n = 90)。雲頂の段と τ の段を全部通す。
const mix = summarizeTile([
  ...Array(10).fill(missingCell),
  ...Array(10).fill(clearPixel),
  ...Array(10).fill(cell(2, 10)), // 高・薄い → cirrus
  ...Array(8).fill(cell(null, 10)), // 高・τ なし
  ...Array(6).fill(cell(null, 1)), // 低・τ なし
  ...Array(4).fill(cellHpa(null, 500)), // 中(気圧)・τ なし
  ...Array(4).fill(cellHpa(10, 800)), // 低(気圧)・中の τ → stratocumulus
  ...Array(6).fill(cell(null, null)), // 雲頂なし・τ なし
  ...Array(4).fill(cell(30, null)), // 雲頂なし・厚い
  ...Array(20).fill(cell(40, 8)), // 高・厚い → deepConvection
  ...Array(18).fill(cell(3, 2)), // 低・薄い → cumulus
]);
const m = 90;
check('mix validFrac', mix.validFrac, 0.9);
check('mix cloudFrac', mix.cloudFrac, 80 / m);
check('mix topHighFrac', mix.topHighFrac, 38 / m);
check('mix topMiddleFrac', mix.topMiddleFrac, 4 / m);
check('mix topLowFrac', mix.topLowFrac, 28 / m);
check('mix noTopFrac', mix.noTopFrac, 10 / m);
check('mix highNoTauFrac', mix.highNoTauFrac, 8 / m);
check('mix middleNoTauFrac', mix.middleNoTauFrac, 4 / m);
check('mix lowNoTauFrac', mix.lowNoTauFrac, 6 / m);
check('mix tauThinFrac', mix.tauThinFrac, 28 / m);
check('mix tauMidFrac', mix.tauMidFrac, 4 / m);
check('mix tauThickFrac', mix.tauThickFrac, 24 / m);
check('mix τ の段の和 = τ のある雲(56 画素)', mix.tauThinFrac + mix.tauMidFrac + mix.tauThickFrac, 56 / m);
check('mix cirrus', mix.cirrus, 10 / m);
check('mix deepConvection', mix.deepConvection, 20 / m);
check('mix stratocumulus', mix.stratocumulus, 4 / m);
check('mix cumulus', mix.cumulus, 18 / m);
checkRelations('混合タイル', mix);

console.log(failures === 0 ? '\n全部 PASS' : `\n${failures} 件 FAIL`);
process.exit(failures === 0 ? 0 : 1);
