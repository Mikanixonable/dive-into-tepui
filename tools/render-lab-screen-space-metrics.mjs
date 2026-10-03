// 近傍拡散補正の画質と費用の計測。ヘッドレス Chrome で .render-lab/ を開き、評価の組の撮影を、走査の段と
// ブルーノイズの seed を与えて撮る。画質は補正項だけを、アルベド 1 の面の表示の尺度 q = 露出係数·ΔE/π で測る。
// 5 つの使い方がある。
//
//   reference [--name D] [--entries K,...] [--sets S,...] --slices S --steps T --passes N
//     基準 B(全解像度・均しなし・1 パス S スライス × 片側 T 歩で、seed を変えた N パスの補正の和と、目で見る画像の
//     ための HDR の平均の表示)を .render-lab-shots/ssd-reference/<D>/ へ作る。同じ D で呼び直すと、保存済みの
//     パスへ N 個目まで続きから足す。D の既定は HEAD の短いハッシュ。--entries と --sets は評価の組のうち作る撮影の
//     key と set(tuning・checking・correctness・flicker)。
//   check D [--entries K,...]
//     基準 D の偶数番目と奇数番目のパスの差(雑音)を、いまの中設定(均しなし)の誤差と比べて収束を判定する。
//     --entries の既定は bay。
//   compare [<candidates.json>] [--reference D] [--entries K,...] [--sets S,...] [--out O]
//     候補 { label, tier, passes }(passes の既定は 1)を B と比べ、指標と費用の表を出す。passes パスの候補は、seed を変えた
//     passes パスの補正の平均を 1 枚の出力とし、費用を段の passes 倍に数える。既定の候補は中の段の均した後と均す前と、
//     均す前の 2・4・8 パス。候補の段の 1 パスの歩数が B と違うか、スライス数が B と同じでも、ともに 4 の倍数でも
//     なければ撮る前に止まる。候補の seed は seed の列の末尾から取って B のパスと重ねず、重なるなら止まる。偽の構造の
//     地図と、表示の誤差を 8 倍にした画像を .render-lab-shots/ssd-compare/<O>/ へ書き、候補の撮影(captures/)と費用・
//     拡散照度から数えた値(record.json)も残す。
//     --entries と --sets は reference と同じ。
//   rescore <出力先> [--reference D]
//     compare が残した撮影を、撮り直さずにいまの指標で採点し直し、表を <出力先>/report.md へ書く。D の既定は撮影に
//     使った基準。
//   variance [<candidates.json>] [--entries K,...] [--sets S,...] [--mode M] [--passes N] [--out O]
//     候補の段(既定は中の均し前)の均し・拡大の前の補正を、全候補で共通の seed の列で N パス(既定 256、4 の倍数)撮り、
//     seed についての画素ごとの分散と収束先の移動と費用を、先頭の候補と比べる表にする。画素ごとの分布の形(歪度・尖度を、
//     |μ| の帯・μ の符号・bay の窓で分けたもの)と、1 パスの誤差の空間の相関 R(s) の表も出す。画素ごとの統計と目で見る
//     画像も .render-lab-shots/ssd-variance/<O>/ へ書く。O の既定は HEAD の短いハッシュ。--entries も --sets も無ければ
//     tuning。M(occlusion か indirect)を与えると、選んだ撮影をその方式で撮る(key は遮蔽なら <撮影>@occlusion)。
//
// 先に .render-lab/ を組んでおくこと(webpack --config webpack.render-lab.config.js --mode production)。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeGrayPng, encodeRgbPng } from './png.mjs';
import {
  edgesOf, exposedCorrectionOf, flickerOf, linearOfOklab, nearEdgesOf, oklabOf, rmsOf, srgbCodesOfLinear,
} from './screen-space-error.mjs';
import {
  analyticRatiosOf, candidateSeedOf, ENTRIES, fixed, HEIGHT, headHash, linearOfPng, loadReference, maskOf,
  MEDIUM_RAW_TIER, readHalfFloats, selectedEntries, shotsDir, table, TIERS, WIDTH, windowRatiosOf, withLab,
  writeHalfFloats,
} from './screen-space-lab.mjs';
import { check, reference } from './screen-space-reference.mjs';
import { variance } from './screen-space-variance.mjs';

// 境界とみなす法線のなす角の余弦と深度の表示の差 [LSB]、境界の帯の幅 [画素]。
const EDGE_NORMAL_COS = Math.cos(Math.PI / 6);
const EDGE_DEPTH_LSB = 3;
const EDGE_BAND = 2;
// スライス数がこの倍数どうしの段は、天体照の楔の核が同じで収束先を共有する — 同じ基準で採点できる。
const SHARED_SLICE_MULTIPLE = 4;
// 表示の 1 LSB に当たる、黒の近くの線形の値。
const DISPLAY_LSB = 1 / (255 * 12.92);

// 既定の候補: 着手前の中の段の均した後と均す前(-raw)と、愚直な曲線(均す前の -p<N> パスの平均)。
const DEFAULT_CANDIDATES = [
  { label: 'medium', tier: TIERS.medium },
  { label: 'medium-raw', tier: MEDIUM_RAW_TIER },
  ...[2, 4, 8].map((passes) => ({ label: `medium-raw-p${passes}`, tier: MEDIUM_RAW_TIER, passes })),
];

// ---- 引数 ----

// `--名前 値` と `--旗` の並び args を { positional, options } へ。
function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('--')) positional.push(args[i]);
    else if (i + 1 < args.length && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
    else options[args[i].slice(2)] = true;
  }
  return { positional, options };
}

// ---- 比較 ----

// 比較の出力先 dir の、候補の撮影の置き場と、撮り直せない値の記録。撮影は、撮影 entry・候補 label・seed の組の番号
// index ごとの、組のパスの補正の平均(rgb の半精度)と、目で見る画像を書く撮影での組 0 の表示(PNG。複数パスの候補は
// 組 0 の HDR の平均の表示)。記録は { reference, entries, candidates, costs, diffuse }(entries は撮影の key の並び、
// candidates は passes を補った候補の並び、costs は候補ごとの段 1 パスの GPU の行の p50 [ms] の表か null、diffuse は
// 候補と撮影ごとの、組 0 の拡散照度の平均から数えた負の画素と解析値のある窓の比)。
const correctionPathOf = (dir, entry, label, index) => path.join(dir, 'captures', `${entry.key}.${label}.s${index}.f16`);
const displayPathOf = (dir, entry, label) => path.join(dir, 'captures', `${entry.key}.${label}.png`);
const recordPathOf = (dir) => path.join(dir, 'record.json');
// 記録 record が撮った評価の組の撮影。
const recordEntriesOf = (record) => ENTRIES.filter((e) => record.entries.includes(e.key));
// 撮影 entry で候補を撮る seed の組の数。ちらつきのフレームは組 0 だけ。
const groupCountOf = (entry) => (entry.set === 'flicker' ? 1 : 2);
// 偽の構造の地図と、誤差を 8 倍にした画像を書く撮影。
const imagedOf = (entry) => entry.set === 'tuning' || entry.set === 'checking';
// 測る画素の印を決める走査の解像度。候補 candidates のどの解像度でもフェードの外にある面を測る。
const maskScaleOf = (candidates) => Math.min(...candidates.map((c) => c.tier.scale));

// 候補 { label, tier, passes } の並び。file(候補の JSON)が undefined なら既定の候補。passes の既定 1 を補う。
function candidatesOf(file) {
  const candidates = file === undefined ? DEFAULT_CANDIDATES : JSON.parse(readFileSync(file, 'utf8'));
  return candidates.map(({ passes = 1, ...candidate }) => {
    if (!Number.isInteger(passes) || passes < 1) throw new Error(`${candidate.label}: passes must be at least 1`);
    return { ...candidate, passes };
  });
}

// 候補 candidates の段の 1 パスの片側の歩数が基準 references のどの撮影の記録とも同じで、スライス数が同じか、どちらも
// SHARED_SLICE_MULTIPLE の倍数であることを確かめる。違えば、違う候補ごとに両者の数を並べて投げる。
function checkSampleCounts(candidates, references) {
  const countsOf = (slices, steps) => `${slices} slices × ${steps} steps`;
  const sharesSlices = (a, b) => a === b || (a % SHARED_SLICE_MULTIPLE === 0 && b % SHARED_SLICE_MULTIPLE === 0);
  const metas = Object.values(references).map(({ meta }) => meta);
  const mismatches = candidates.flatMap(({ label, tier }) => {
    const unlike = metas.filter(({ slices, steps }) => steps !== tier.stepCount || !sharesSlices(slices, tier.sliceCount));
    const others = new Set(unlike.map(({ slices, steps }) => countsOf(slices, steps)));
    return others.size === 0 ? []
      : [`${label}: ${countsOf(tier.sliceCount, tier.stepCount)} per pass, reference ${[...others].join(' / ')}`];
  });
  if (mismatches.length > 0) throw new Error(`candidates sample unlike the reference:\n${mismatches.join('\n')}`);
}

// 候補 candidates の label ごとの、seed の 2 つの組。組 g は候補の seed の列(candidateSeedOf)の gN〜(g + 1)N − 1 番目
// (N は候補のパス数)。referencePasses は基準のパス数で、seed がそのパスと重なるなら投げる。
const seedGroupsOf = (candidates, referencePasses) => Object.fromEntries(candidates.map(({ label, passes }) => [
  label, [0, 1].map((g) => Array.from({ length: passes }, (_, i) => candidateSeedOf(g * passes + i, referencePasses))),
]));

// 候補を撮って費用を測り、基準と比べて採点し、表を書く。
async function compare({ positional, options }) {
  const candidates = candidatesOf(positional[0]);
  const name = options.reference ?? headHash();
  const outDir = path.join(shotsDir, 'ssd-compare', options.out ?? name);
  const entries = selectedEntries(options);
  const references = loadReference(name, entries);
  checkSampleCounts(candidates, references);
  const seedGroups = seedGroupsOf(candidates, Math.max(...entries.map((e) => references[e.key].meta.passes)));
  const { meta } = references[entries[0].key];
  console.log(`基準 ${name}(${meta.slices} スライス × 片側 ${meta.steps} 歩、${meta.passes} パス)`);
  const { record, results, flicker, scales } = await withLab(async (lab) => {
    const diffuse = await captureCandidates(lab, outDir, entries, candidates, seedGroups, references);
    // 費用。コンパイルを済ませてから、bay で段を交互に測る。同じ段の候補は 1 回の計測を分け合う。
    await lab.show(ENTRIES[0]);
    await lab.capturePng();
    const tiers = [...new Set(candidates.map((c) => JSON.stringify(c.tier)))];
    const tierCosts = await lab.measureTiers(tiers.map((tier) => JSON.parse(tier)), 3);
    const costs = candidates.map((c) => tierCosts[tiers.indexOf(JSON.stringify(c.tier))]);
    const record = { reference: name, entries: entries.map((e) => e.key), candidates, costs, diffuse };
    writeFileSync(recordPathOf(outDir), JSON.stringify(record));
    const scored = await scoreSaved(lab, outDir, record, references, outDir);
    return { record, ...scored, scales: await lab.errorScales() };
  });
  const report = reportOf(record, results, flicker, scales);
  writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(`\n${report}`);
}

// compare が残した dir の撮影を、撮り直さずにいまの指標で採点し直し、report.md を書き直す。費用と拡散照度から
// 数えた値は撮影のときの記録のまま。
async function rescore({ positional, options }) {
  const dir = positional[0];
  if (dir === undefined) throw new Error('usage: rescore <出力先> [--reference D]');
  const record = JSON.parse(readFileSync(recordPathOf(dir), 'utf8'));
  const references = loadReference(options.reference ?? record.reference, recordEntriesOf(record));
  const { results, flicker, scales } = await withLab(async (lab) => ({
    ...await scoreSaved(lab, dir, record, references, null), scales: await lab.errorScales(),
  }));
  const file = path.join(dir, 'report.md');
  writeFileSync(file, reportOf(record, results, flicker, scales));
  console.log(`rescored: ${file}`);
}

// 撮影 entries ごとに候補 candidates を seed の組 seedGroups(候補の label ごと)で撮り、補正と表示を dir の captures/ へ
// 書く。組 0 の拡散照度の平均は、その場で負の画素と窓の比へ畳み、候補の label と撮影の key の表で返す。references は
// 基準、lab は withLab の口。
async function captureCandidates(lab, dir, entries, candidates, seedGroups, references) {
  mkdirSync(path.join(dir, 'captures'), { recursive: true });
  const diffuse = Object.fromEntries(candidates.map((c) => [c.label, {}]));
  for (const entry of entries) {
    await lab.show(entry);
    const mask = maskOf(references[entry.key].radius, maskScaleOf(candidates));
    for (const candidate of candidates) {
      const groups = seedGroups[candidate.label].slice(0, groupCountOf(entry));
      const summary = await captureCandidate(lab, dir, entry, candidate, groups, mask);
      if (summary !== null) diffuse[candidate.label][entry.key] = summary;
    }
    console.log(`captured ${entry.key}`);
  }
  return diffuse;
}

// 表示中の撮影 entry で候補 candidate を seed の組 groups ごとに撮り、組ごとのパスの補正の平均を dir の captures/ へ
// 書く。目で見る画像を書く撮影では組 0 の表示も書く。組 0 の拡散照度の平均を測る画素の印 mask で畳んだ値
// (diffuseSummaryOf)を返し、ちらつきのフレームでは null を返す。lab は withLab の口。
async function captureCandidate(lab, dir, entry, candidate, groups, mask) {
  const { label, tier, passes } = candidate;
  const flickerFrame = entry.set === 'flicker';
  const averagedDisplay = imagedOf(entry) && passes > 1;
  // 絵の落ち着きを待つのは最初の seed だけで、以後は seed だけが変わる。
  await lab.setTier(tier);
  await lab.setSeed(groups[0][0]);
  const png = await lab.capturePng();
  // 組ごとに補正を積む。組 0 では拡散照度と、複数パスの表示のための HDR も積む。
  const firstKinds = [...(flickerFrame ? [] : ['diffuse']), ...(averagedDisplay ? ['hdr'] : [])];
  for (const [index, seeds] of groups.entries()) {
    for (const seed of seeds) {
      await lab.setSeed(seed);
      await lab.render();
      for (const kind of ['correction', ...(index === 0 ? firstKinds : [])]) await lab.accumulateFloat(kind, 3, index);
    }
  }
  const sums = await lab.takeAccumulated('correction', groups.length);
  for (const [index, sum] of sums.entries()) {
    writeHalfFloats(correctionPathOf(dir, entry, label, index), sum.map((v) => v / passes));
  }
  if (imagedOf(entry)) {
    const display = averagedDisplay
      ? encodeRgbPng(WIDTH, HEIGHT, srgbCodesOfLinear(await lab.displayOfMean('hdr', passes))) : png;
    writeFileSync(displayPathOf(dir, entry, label), display);
  }
  if (averagedDisplay) await lab.dropAccumulated('hdr');
  if (flickerFrame) return null;
  const [irradiance] = await lab.takeAccumulated('diffuse', 1);
  return diffuseSummaryOf(entry, irradiance.map((v) => v / passes), mask, await lab.exposureFactor());
}

// 撮影 entry の候補の拡散照度 irradiance(rgb)の、測る画素の印 mask の立った画素で負の画素の数と、そのうちアルベド 1 の
// 面の表示(露出係数 exposure)で 1 LSB 以上暗く出るものの数。解析値と照らす撮影では窓の比も。
function diffuseSummaryOf(entry, irradiance, mask, exposure) {
  let [negatives, visibleNegatives] = [0, 0];
  for (let p = 0; p < WIDTH * HEIGHT; p++) {
    if (!mask[p]) continue;
    const lowest = Math.min(irradiance[p * 3], irradiance[p * 3 + 1], irradiance[p * 3 + 2]);
    if (lowest < 0) negatives++;
    if (exposure * lowest / Math.PI < -DISPLAY_LSB) visibleNegatives++;
  }
  const ratios = entry.set === 'correctness' ? windowRatiosOf(entry, irradiance) : null;
  return { negatives, visibleNegatives, ratios };
}

// dir に残した撮影を基準 references と比べ、候補と撮影ごとの指標の表 results と、候補ごとのちらつき flicker(bay と
// ちらつきの全フレームを撮っていなければ null)を返す。imageDir が null でなければ、偽の構造の地図と表示の誤差を
// 8 倍にした画像をそこへ書く。lab は withLab の口。
async function scoreSaved(lab, dir, record, references, imageDir) {
  const entries = recordEntriesOf(record);
  const maskScale = maskScaleOf(record.candidates);
  const results = Object.fromEntries(record.candidates.map((c) => [c.label, {}]));
  const flickerFrames = Object.fromEntries(record.candidates.map((c) => [c.label, []]));
  for (const entry of entries) {
    const reference = references[entry.key];
    const q0 = reference.exposedCorrection;
    const mask = maskOf(reference.radius, maskScale);
    const edges = edgesOf(reference.normal, reference.depth, WIDTH, HEIGHT, EDGE_NORMAL_COS, EDGE_DEPTH_LSB);
    const nearEdges = nearEdgesOf(edges, mask, WIDTH, HEIGHT, EDGE_BAND);
    for (const candidate of record.candidates) {
      const qs = Array.from({ length: groupCountOf(entry) }, (_, index) => exposedCorrectionOf(
        readHalfFloats(correctionPathOf(dir, entry, candidate.label, index)), reference.meta.exposure));
      if (entry.set === 'flicker' || entry.key === 'bay') flickerFrames[candidate.label].push(qs[0]);
      if (entry.set === 'flicker') continue;
      const metrics = await lab.errorMetrics(qs[0], q0, mask, WIDTH, HEIGHT);
      if (imageDir !== null && imagedOf(entry)) {
        const display = linearOfPng(readFileSync(displayPathOf(dir, entry, candidate.label)));
        writeImages(imageDir, candidate.label, entry.key, display, reference.display, await lab.falseStructureMap());
      }
      // 組 1 の S、2 つの組の平均(偏り)と差(分散)の R(s)、境界の漏れ、拡散照度から数えた値。
      const average = qs[0].map((plane, c) => plane.map((v, p) => (v + qs[1][c][p]) / 2));
      results[candidate.label][entry.key] = {
        ...metrics,
        scoreSecond: (await lab.errorMetrics(qs[1], q0, mask, WIDTH, HEIGHT)).score,
        biasR: (await lab.errorMetrics(average, q0, mask, WIDTH, HEIGHT)).r,
        varianceR: (await lab.errorMetrics(qs[0], qs[1], mask, WIDTH, HEIGHT)).r,
        leak: rmsOf(qs[0], q0, nearEdges),
        ...record.diffuse[candidate.label][entry.key],
        referenceRatios: entry.set === 'correctness' ? windowRatiosOf(entry, reference.diffuse) : null,
      };
    }
    console.log(`scored ${entry.key}`);
  }
  const flickerEntries = [ENTRIES.find((e) => e.key === 'bay'), ...ENTRIES.filter((e) => e.set === 'flicker')];
  const flickerReference = flickerEntries.every((e) => record.entries.includes(e.key))
    ? flickerEntries.map((e) => references[e.key].exposedCorrection) : null;
  const flicker = Object.fromEntries(record.candidates.map((c) => [c.label, flickerReference === null ? null
    : flickerOf(flickerFrames[c.label], flickerReference, maskOf(references.bay.radius, maskScale))]));
  return { results, flicker };
}

// 偽の構造の地図で白になる、画素ごとの偽の構造の項の値。実測: 比較 6484ec55c-threshold の bay-earth-open の中の段の
// 均し(5×5)の、測る画素での 99 百分位 0.216。
const FALSE_STRUCTURE_MAP_WHITE = 0.2;

// 候補 label の撮影 key の、偽の構造の地図 falseStructureMap と、候補の表示 display の基準の表示 referenceDisplay
// (どちらも線形 sRGB)からの差を Oklab で 8 倍にした画像を outDir へ書く。
function writeImages(outDir, label, key, display, referenceDisplay, falseStructureMap) {
  const map = Uint8Array.from(falseStructureMap, (v) => Math.min(255, Math.round(255 * v / FALSE_STRUCTURE_MAP_WHITE)));
  writeFileSync(path.join(outDir, `${key}.${label}.false-structure.png`), encodeGrayPng(WIDTH, HEIGHT, map));
  const [referenceLab, candidateLab] = [referenceDisplay, display].map(oklabOf);
  const enhanced = linearOfOklab(referenceLab.map((plane, c) => plane.map((v, p) => v + 8 * (candidateLab[c][p] - v))));
  writeFileSync(path.join(outDir, `${key}.${label}.error8.png`), encodeRgbPng(WIDTH, HEIGHT, srgbCodesOfLinear(enhanced)));
}

// 値の並び values の平均。空なら NaN。
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

// 記録 record の表。候補ごとの費用と調整用・確認用の S の平均、撮影ごとの S、スケールごとの S の内訳、解析値との照合。
// results は候補と撮影ごとの指標、flicker は候補ごとのちらつき、scales は指標のスケールの並び。撮っていない組の平均は —。
function reportOf(record, results, flicker, scales) {
  const { candidates, costs } = record;
  const entries = recordEntriesOf(record);
  const keysOf = (set) => entries.filter((e) => e.set === set).map((e) => e.key);
  const [tuning, checking, correctness] = ['tuning', 'checking', 'correctness'].map(keysOf);
  const measured = [...tuning, ...checking];
  // 費用は近傍拡散補正の 4 行の和の、マテリアルの行に対する比の、候補のパス数 passes 倍。
  const costOf = (row, passes) => {
    if (row === null) return null;
    const parts = ['照り返し源', '近傍拡散走査', '近傍拡散均し', '近傍拡散拡大', 'マテリアル'].map((label) => row[label]);
    return parts.some((v) => v === null) ? null : passes * (parts[0] + parts[1] + parts[2] + parts[3]) / parts[4];
  };
  const summary = candidates.map((candidate, i) => {
    const rows = results[candidate.label];
    const avg = (keys, field, digits) => fixed(mean(keys.map((k) => rows[k][field])), digits);
    const byScale = (field) => scales.map((_, j) => fixed(mean(tuning.map((k) => rows[k][field][j])), 2)).join(' / ');
    const sum = (field) => measured.reduce((total, k) => total + rows[k][field], 0);
    return [
      candidate.label, fixed(costOf(costs[i], candidate.passes), 2), avg(tuning, 'score', 5),
      avg(tuning, 'noiseTerm', 5), avg(tuning, 'g', 5), avg(checking, 'score', 5), avg(tuning, 'scoreSecond', 5),
      avg(measured, 'leak', 5), fixed(flicker[candidate.label], 5), `${sum('negatives')} / ${sum('visibleNegatives')}`,
      byScale('r'), byScale('biasR'), byScale('varianceR'),
    ];
  });
  const perShot = candidates.map((candidate) => [candidate.label, ...measured.map((k) => {
    const row = results[candidate.label][k];
    return fixed(row.score, 5);
  })]);
  const perScale = candidates.map((candidate) => [candidate.label, ...scales.map(
    (_, j) => fixed(mean(tuning.map((k) => results[candidate.label][k].scoreByScale[j])), 5),
  )]);
  const ratios = correctness.map((key) => {
    const analytic = analyticRatiosOf(key);
    const format = (values) => values.map((v) => fixed(v, 3)).join(' / ');
    return [key, format(analytic), format(results[candidates[0].label][key].referenceRatios),
      ...candidates.map((c) => format(results[c.label][key].ratios))];
  });
  return [
    '## 候補', '',
    ...table(['候補', '費用 / マテリアル', 'S 調整用', '雑音 N(S の外)', 'G', 'S 確認用', 'S の 2 つ目の組',
      '境界の漏れ', 'ちらつき', '負の画素 / 見える', 'R(s)', 'R(s) 偏り', 'R(s) 分散'], summary),
    '', '## 撮影ごとの S', '', ...table(['候補', ...measured], perShot),
    '', '## スケールごとの S の内訳(調整用の平均)', '', ...table(['候補', ...scales.map((s) => `${s} px`)], perScale),
    '', '## 解析値のある窓の比(拡散照度。bay は P_in / P_out、bounce-cosine は余弦 1 / 0.5 / 0)', '',
    ...table(['撮影', '解析値', '基準', ...candidates.map((c) => c.label)], ratios),
    '',
  ].join('\n');
}

const COMMANDS = { reference, check, compare, rescore, variance };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error('usage: node tools/render-lab-screen-space-metrics.mjs reference|check|compare|rescore|variance [...]');
  }
  await COMMANDS[command](parseArgs(rest));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
