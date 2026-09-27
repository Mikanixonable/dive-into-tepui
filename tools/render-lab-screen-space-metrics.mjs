// 近傍拡散補正の画質と費用の計測。ヘッドレス Chrome で .render-lab/ を開き、評価の組の撮影を、走査の段と
// ブルーノイズの seed を与えて撮る。画質は補正項だけを、アルベド 1 の面の表示の尺度 q = 露出係数·ΔE/π で測る。
// 4 つの使い方がある。
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
//     候補の段(既定は精細さの 3 段の均し前後と、中の均し前のスライスを 2・4・8 倍にしたもの)を B と比べ、
//     指標と費用の表を出す。偽の構造の地図と、表示の誤差を 8 倍にした画像を .render-lab-shots/ssd-compare/<O>/ へ書き、
//     候補の撮影(captures/)と費用・拡散照度から数えた値(record.json)も残す。--entries と --sets は reference と同じ。
//   rescore <出力先> [--reference D]
//     compare が残した撮影を、撮り直さずにいまの指標で採点し直し、表を <出力先>/report.md へ書く。D の既定は撮影に
//     使った基準。
//
// 先に .render-lab/ を組んでおくこと(webpack --config webpack.render-lab.config.js --mode production)。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeGrayPng, encodeRgbPng } from './png.mjs';
import {
  edgesOf, ERROR_SCALES, errorMetrics, exposedCorrectionOf, flickerOf, linearOfOklab, nearEdgesOf, oklabOf, rmsOf,
  srgbCodesOfLinear,
} from './screen-space-error.mjs';
import {
  analyticRatiosOf, ENTRIES, fixed, HEIGHT, headHash, linearOfPng, loadReference, maskOf, readHalfFloats, seedOf,
  selectedEntries, shotsDir, table, TIERS, WIDTH, windowRatiosOf, withLab, writeHalfFloats,
} from './screen-space-lab.mjs';
import { check, reference } from './screen-space-reference.mjs';

// 境界とみなす法線のなす角の余弦と深度の表示の差 [LSB]、境界の帯の幅 [画素]。
const EDGE_NORMAL_COS = Math.cos(Math.PI / 6);
const EDGE_DEPTH_LSB = 3;
const EDGE_BAND = 2;
// 表示の 1 LSB に当たる、黒の近くの線形の値。
const DISPLAY_LSB = 1 / (255 * 12.92);

// 既定の候補: 精細さの 3 段の均した後と均す前(-raw)と、中の均す前のスライスを 2・4・8 倍にしたもの。
const DEFAULT_CANDIDATES = [
  ...Object.entries(TIERS).flatMap(([name, tier]) => [
    { label: `${name}`, tier },
    { label: `${name}-raw`, tier: { ...tier, denoiseRadius: 0 } },
  ]),
  ...[2, 4, 8].map((factor) => ({
    label: `medium-raw-x${factor}`, tier: { ...TIERS.medium, sliceCount: TIERS.medium.sliceCount * factor, denoiseRadius: 0 },
  })),
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

// 比較の出力先 dir の、候補の撮影の置き場と、撮り直せない値の記録。撮影は、撮影 entry・候補 label・seed の番号
// index ごとの補正(rgb の半精度)と、目で見る画像を書く撮影での 1 つ目の seed の表示(PNG)。記録は
// { reference, entries, candidates, costs, diffuse }(entries は撮影の key の並び、costs は候補ごとの GPU の行の
// p50 [ms] の表か null、diffuse は候補と撮影ごとの、拡散照度から数えた負の画素と解析値のある窓の比)。
const correctionPathOf = (dir, entry, label, index) => path.join(dir, 'captures', `${entry.key}.${label}.s${index}.f16`);
const displayPathOf = (dir, entry, label) => path.join(dir, 'captures', `${entry.key}.${label}.png`);
const recordPathOf = (dir) => path.join(dir, 'record.json');
// 記録 record が撮った評価の組の撮影。
const recordEntriesOf = (record) => ENTRIES.filter((e) => record.entries.includes(e.key));
// 候補の撮影に使う seed。ちらつきのフレームは 1 つ目だけ。
const COMPARE_SEEDS = [seedOf(0), seedOf(1)];
const seedsOf = (entry) => (entry.set === 'flicker' ? COMPARE_SEEDS.slice(0, 1) : COMPARE_SEEDS);
// 偽の構造の地図と、誤差を 8 倍にした画像を書く撮影。
const imagedOf = (entry) => entry.set === 'tuning' || entry.set === 'checking';

async function compare({ positional, options }) {
  const candidates = positional[0] === undefined ? DEFAULT_CANDIDATES : JSON.parse(readFileSync(positional[0], 'utf8'));
  const name = options.reference ?? headHash();
  const outDir = path.join(shotsDir, 'ssd-compare', options.out ?? name);
  const entries = selectedEntries(options);
  const references = loadReference(name, entries);
  const { meta } = references[entries[0].key];
  console.log(`基準 ${name}(${meta.slices} スライス × 片側 ${meta.steps} 歩、${meta.passes} パス)`);
  const { diffuse, costs } = await withLab(async (lab) => {
    const captured = await captureCandidates(lab, outDir, entries, candidates, references);
    // 費用。コンパイルを済ませてから、bay で段を交互に測る。
    await lab.show(ENTRIES[0]);
    await lab.capturePng();
    return { diffuse: captured, costs: await lab.measureTiers(candidates.map((c) => c.tier), 3) };
  });
  const record = { reference: name, entries: entries.map((e) => e.key), candidates, costs, diffuse };
  writeFileSync(recordPathOf(outDir), JSON.stringify(record));
  const { results, flicker } = scoreSaved(outDir, record, references, outDir);
  const report = reportOf(record, results, flicker);
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
  const { results, flicker } = scoreSaved(dir, record, references, null);
  const file = path.join(dir, 'report.md');
  writeFileSync(file, reportOf(record, results, flicker));
  console.log(`rescored: ${file}`);
}

// 撮影 entries ごとに候補 candidates を seed を変えて撮り、補正と表示を dir の captures/ へ書く。1 つ目の seed の
// 拡散照度は、その場で負の画素と窓の比へ畳み、候補の label と撮影の key の表で返す。references は基準、lab は
// withLab の口。
async function captureCandidates(lab, dir, entries, candidates, references) {
  mkdirSync(path.join(dir, 'captures'), { recursive: true });
  const diffuse = Object.fromEntries(candidates.map((c) => [c.label, {}]));
  for (const entry of entries) {
    await lab.show(entry);
    for (const candidate of candidates) {
      await lab.setTier(candidate.tier);
      for (const [index, seed] of seedsOf(entry).entries()) {
        await lab.setSeed(seed);
        const png = await lab.capturePng();
        writeHalfFloats(correctionPathOf(dir, entry, candidate.label, index), await lab.readFloat('correction', 3));
        if (index > 0 || entry.set === 'flicker') continue;
        if (imagedOf(entry)) writeFileSync(displayPathOf(dir, entry, candidate.label), png);
        const irradiance = await lab.readFloat('diffuse', 3);
        const exposure = await lab.exposureFactor();
        diffuse[candidate.label][entry.key] = diffuseSummaryOf(entry, irradiance, references[entry.key], exposure);
      }
    }
    console.log(`captured ${entry.key}`);
  }
  return diffuse;
}

// 撮影 entry の候補の拡散照度 irradiance(rgb)の、測る画素で負の画素の数と、そのうちアルベド 1 の面の表示
// (露出係数 exposure)で 1 LSB 以上暗く出るものの数。解析値と照らす撮影では窓の比も。reference は基準。
function diffuseSummaryOf(entry, irradiance, reference, exposure) {
  const mask = maskOf(reference.radius);
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
// 8 倍にした画像をそこへ書く。
function scoreSaved(dir, record, references, imageDir) {
  const entries = recordEntriesOf(record);
  const results = Object.fromEntries(record.candidates.map((c) => [c.label, {}]));
  const flickerFrames = Object.fromEntries(record.candidates.map((c) => [c.label, []]));
  for (const entry of entries) {
    const reference = references[entry.key];
    const q0 = reference.exposedCorrection;
    const mask = maskOf(reference.radius);
    const edges = edgesOf(reference.normal, reference.depth, WIDTH, HEIGHT, EDGE_NORMAL_COS, EDGE_DEPTH_LSB);
    const nearEdges = nearEdgesOf(edges, mask, WIDTH, HEIGHT, EDGE_BAND);
    for (const candidate of record.candidates) {
      const qs = seedsOf(entry).map((_, index) => exposedCorrectionOf(
        readHalfFloats(correctionPathOf(dir, entry, candidate.label, index)), reference.meta.exposure));
      if (entry.set === 'flicker' || entry.key === 'bay') flickerFrames[candidate.label].push(qs[0]);
      if (entry.set === 'flicker') continue;
      const { falseStructureMap, ...metrics } = errorMetrics(qs[0], q0, mask, WIDTH, HEIGHT);
      // 2 つ目の seed の M、偏りと分散の R(s)、境界の漏れ、拡散照度から数えた値。
      const average = qs[0].map((plane, c) => plane.map((v, p) => (v + qs[1][c][p]) / 2));
      results[candidate.label][entry.key] = {
        ...metrics,
        scoreSecond: errorMetrics(qs[1], q0, mask, WIDTH, HEIGHT).score,
        biasR: errorMetrics(average, q0, mask, WIDTH, HEIGHT).r,
        varianceR: errorMetrics(qs[0], qs[1], mask, WIDTH, HEIGHT).r,
        leak: rmsOf(qs[0], q0, nearEdges),
        ...record.diffuse[candidate.label][entry.key],
        referenceRatios: entry.set === 'correctness' ? windowRatiosOf(entry, reference.diffuse) : null,
      };
      if (imageDir !== null && imagedOf(entry)) {
        const display = linearOfPng(readFileSync(displayPathOf(dir, entry, candidate.label)));
        writeImages(imageDir, candidate.label, entry.key, display, reference.display, falseStructureMap);
      }
    }
    console.log(`scored ${entry.key}`);
  }
  const flickerEntries = [ENTRIES.find((e) => e.key === 'bay'), ...ENTRIES.filter((e) => e.set === 'flicker')];
  const flickerReference = flickerEntries.every((e) => record.entries.includes(e.key))
    ? flickerEntries.map((e) => references[e.key].exposedCorrection) : null;
  const flicker = Object.fromEntries(record.candidates.map((c) => [c.label, flickerReference === null ? null
    : flickerOf(flickerFrames[c.label], flickerReference, maskOf(references.bay.radius))]));
  return { results, flicker };
}

// 偽の構造の地図で白になる、画素ごとの偽の構造の項の値。
const FALSE_STRUCTURE_MAP_WHITE = 20;

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

// 記録 record の表。候補ごとの費用と調整用・確認用の M の平均、撮影ごとの M、スケールごとの偽の構造、解析値との照合。
// results は候補と撮影ごとの指標、flicker は候補ごとのちらつき。撮っていない組の平均は —。
function reportOf(record, results, flicker) {
  const { candidates, costs } = record;
  const entries = recordEntriesOf(record);
  const keysOf = (set) => entries.filter((e) => e.set === set).map((e) => e.key);
  const [tuning, checking, correctness] = ['tuning', 'checking', 'correctness'].map(keysOf);
  const measured = [...tuning, ...checking];
  // 費用は近傍拡散補正の 4 行の和の、マテリアルの行に対する比。
  const costOf = (row) => {
    if (row === null) return null;
    const parts = ['照り返し源', '近傍拡散走査', '近傍拡散均し', '近傍拡散拡大', 'マテリアル'].map((label) => row[label]);
    return parts.some((v) => v === null) ? null : (parts[0] + parts[1] + parts[2] + parts[3]) / parts[4];
  };
  const summary = candidates.map((candidate, i) => {
    const rows = results[candidate.label];
    const avg = (keys, field, digits) => fixed(mean(keys.map((k) => rows[k][field])), digits);
    const scales = (field) => ERROR_SCALES.map((_, j) => fixed(mean(tuning.map((k) => rows[k][field][j])), 2)).join(' / ');
    const sum = (field) => measured.reduce((total, k) => total + rows[k][field], 0);
    return [
      candidate.label, fixed(costOf(costs[i]), 2), avg(tuning, 'score', 3), avg(tuning, 'noiseTerm', 5),
      avg(tuning, 'falseStructureTerm', 3), avg(tuning, 'g', 5), avg(checking, 'score', 3), avg(tuning, 'scoreSecond', 3),
      avg(measured, 'leak', 5), fixed(flicker[candidate.label], 5), `${sum('negatives')} / ${sum('visibleNegatives')}`,
      scales('r'), scales('biasR'), scales('varianceR'),
    ];
  });
  const perShot = candidates.map((candidate) => [candidate.label, ...measured.map((k) => {
    const row = results[candidate.label][k];
    return `${row.score.toFixed(3)} (${row.noiseTerm.toFixed(5)} + ${row.falseStructureTerm.toFixed(3)})`;
  })]);
  const perScale = candidates.map((candidate) => [candidate.label, ...ERROR_SCALES.map(
    (_, j) => fixed(mean(tuning.map((k) => results[candidate.label][k].falseStructureByScale[j])), 3),
  )]);
  const ratios = correctness.map((key) => {
    const analytic = analyticRatiosOf(key);
    const format = (values) => values.map((v) => fixed(v, 3)).join(' / ');
    return [key, format(analytic), format(results[candidates[0].label][key].referenceRatios),
      ...candidates.map((c) => format(results[c.label][key].ratios))];
  });
  return [
    '## 候補', '',
    ...table(['候補', '費用 / マテリアル', 'S 調整用', '雑音', '偽の構造', 'G', 'S 確認用', 'S の 2 つ目の seed',
      '境界の漏れ', 'ちらつき', '負の画素 / 見える', 'R(s)', 'R(s) 偏り', 'R(s) 分散'], summary),
    '', '## 撮影ごとの M(雑音 + 偽の構造)', '', ...table(['候補', ...measured], perShot),
    '', '## スケールごとの偽の構造(調整用の平均)', '', ...table(['候補', ...ERROR_SCALES.map((s) => `${s} px`)], perScale),
    '', '## 解析値のある窓の比(拡散照度。bay は P_in / P_out、bounce-cosine は余弦 1 / 0.5 / 0)', '',
    ...table(['撮影', '解析値', '基準', ...candidates.map((c) => c.label)], ratios),
    '',
  ].join('\n');
}

const COMMANDS = { reference, check, compare, rescore };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error('usage: node tools/render-lab-screen-space-metrics.mjs reference|check|compare|rescore [...]');
  }
  await COMMANDS[command](parseArgs(rest));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
