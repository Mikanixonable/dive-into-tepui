// 近傍拡散補正の画質と費用の計測。ヘッドレス Chrome で .render-lab/ を開き、評価の組の撮影を、走査の段と
// ブルーノイズの seed を与えて撮る。5 つの使い方がある。
//
//   reference [--name D] [--entries K,...] [--sets S,...] --slices S --steps T --passes N
//     基準 B(全解像度・均しなし・1 パス S スライス × 片側 T 歩で、seed を変えた N パスの HDR の平均の表示)を
//     .render-lab-shots/ssd-reference/<D>/ へ作る。同じ D で呼び直すと、保存済みのパスへ N 個目まで続きから足す。
//     D の既定は HEAD の短いハッシュ。--entries と --sets は評価の組のうち作る撮影の key と set
//     (tuning・checking・correctness・flicker)。
//   check D [D₂] [--entries K,...]
//     基準 D の偶数番目と奇数番目のパスの差(雑音)と、歩数を倍にした D₂ との差を、いまの中設定(均しなし)の誤差と
//     比べて収束を判定する。--entries の既定は bay。
//   compare [<candidates.json>] [--reference D] [--t T] [--out O]
//     候補の段(既定は精細さの 3 段の均し前後と、中の均し前のスライスを 2・4・8 倍にしたもの)を B と比べ、
//     指標と費用の表を出す。超過の地図と誤差を 8 倍にした画像を .render-lab-shots/ssd-compare/<O>/ へ書き、候補の
//     撮影(captures/)と費用・拡散照度から数えた値(record.json)も残す。
//   rescore <出力先> [--reference D] --t T,...
//     compare が残した撮影を、撮り直さずに t ごとに採点し直し、表を <出力先>/report-t<T>.md へ書く。D の既定は
//     compare に使った基準。
//   stimuli [--reference D]
//     目視の刺激(B に中設定の誤差を縮めて足した画像と、raw の誤差を表示の空間で均した画像)を、中身を伏せた名前で
//     .render-lab-shots/ssd-stimuli/<撮影>/ へ書く。対応表は key.json。
//
// 先に .render-lab/ を組んでおくこと(webpack --config webpack.render-lab.config.js --mode production)。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeGrayPng, encodeRgbPng } from './png.mjs';
import {
  BAND_SCALES, edgesOf, errorMetrics, flickerOf, gaussianBlurOf, linearOfOklab, nearEdgesOf, oklabOf, rmsOf,
  scaledErrorOf, srgbCodesOfLinear, uniformRandom,
} from './screen-space-error.mjs';
import {
  analyticRatiosOf, captureLinear, ENTRIES, fixed, HEIGHT, headHash, linearOfPng, loadReference, maskOf, root, seedOf,
  shotsDir, table, TIERS, WIDTH, windowRatiosOf, withLab,
} from './screen-space-lab.mjs';
import { check, reference } from './screen-space-reference.mjs';

// 境界とみなす法線のなす角の余弦と深度の表示の差 [LSB]、境界の帯の幅 [画素]。
const EDGE_NORMAL_COS = Math.cos(Math.PI / 6);
const EDGE_DEPTH_LSB = 3;
const EDGE_BAND = 2;
// 表示で見えない差 t の初期値(Oklab)。sRGB 8bit の 10 階調前後。
const DEFAULT_T = 0.035;
// 表示の 1 LSB に当たる、黒の近くの線形の値。
const DISPLAY_LSB = 1 / (255 * 12.92);

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
// index ごとの PNG。記録は { reference, candidates, costs, diffuse }(diffuse は候補と撮影ごとの、拡散照度から
// 数えた負の画素と解析値のある窓の比)。
const capturePathOf = (dir, entry, label, index) => path.join(dir, 'captures', `${entry.key}.${label}.s${index}.png`);
const recordPathOf = (dir) => path.join(dir, 'record.json');
// 候補の撮影に使う seed。ちらつきのフレームは 1 つ目だけ。
const COMPARE_SEEDS = [seedOf(0), seedOf(1)];
const seedsOf = (entry) => (entry.set === 'flicker' ? COMPARE_SEEDS.slice(0, 1) : COMPARE_SEEDS);

async function compare({ positional, options }) {
  const candidates = positional[0] === undefined ? DEFAULT_CANDIDATES : JSON.parse(readFileSync(positional[0], 'utf8'));
  const name = options.reference ?? headHash();
  const t = Number(options.t ?? DEFAULT_T);
  const outDir = path.join(shotsDir, 'ssd-compare', options.out ?? name);
  mkdirSync(path.join(outDir, 'captures'), { recursive: true });
  const references = loadReference(name, ENTRIES);
  const { meta } = references[ENTRIES[0].key];
  console.log(`基準 ${name}(${meta.slices} スライス × 片側 ${meta.steps} 歩、${meta.passes} パス)、t = ${t}`);
  // 撮る。拡散照度は 1 つ目の seed のものだけを、その場で負の画素と窓の比へ畳む。
  const diffuse = Object.fromEntries(candidates.map((c) => [c.label, {}]));
  const costs = await withLab(async (lab) => {
    for (const entry of ENTRIES) {
      await lab.show(entry);
      for (const candidate of candidates) {
        await lab.setTier(candidate.tier);
        for (const [index, seed] of seedsOf(entry).entries()) {
          await lab.setSeed(seed);
          writeFileSync(capturePathOf(outDir, entry, candidate.label, index), await lab.capturePng());
          if (index > 0 || entry.set === 'flicker') continue;
          const irradiance = await lab.readFloat('diffuse', 3);
          diffuse[candidate.label][entry.key] = diffuseSummaryOf(entry, irradiance, references[entry.key], await lab.exposureFactor());
        }
      }
      console.log(`captured ${entry.key}`);
    }
    // 費用。コンパイルを済ませてから、bay で段を交互に測る。
    await lab.show(ENTRIES[0]);
    await lab.capturePng();
    return lab.measureTiers(candidates.map((c) => c.tier), 3);
  });
  const record = { reference: name, candidates, costs, diffuse };
  writeFileSync(recordPathOf(outDir), JSON.stringify(record));
  const { byT, flicker } = scoreSaved(outDir, record, references, [t], outDir);
  const report = reportOf(candidates, byT[0], costs, flicker);
  writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(`\n${report}`);
}

// compare が残した dir の撮影を、撮り直さずに t の並び(--t)ごとに採点し直し、report-t<t>.md を書く。費用と
// 拡散照度から数えた値は compare の記録のまま。
async function rescore({ positional, options }) {
  const dir = positional[0];
  if (dir === undefined || typeof options.t !== 'string') throw new Error('usage: rescore <出力先> [--reference D] --t <t,...>');
  const record = JSON.parse(readFileSync(recordPathOf(dir), 'utf8'));
  const ts = options.t.split(',').map(Number);
  const references = loadReference(options.reference ?? record.reference, ENTRIES);
  const { byT, flicker } = scoreSaved(dir, record, references, ts, null);
  for (const [i, t] of ts.entries()) {
    const file = path.join(dir, `report-t${t}.md`);
    writeFileSync(file, reportOf(record.candidates, byT[i], record.costs, flicker));
    console.log(`rescored t = ${t}: ${file}`);
  }
}

// 撮影 entry の候補の拡散照度 irradiance(rgb)の、測る面で負の画素の数と、その暗さが表示で 1 LSB を超えうるもの
// (アルベド 1、露出係数 exposure とみなす)の数。解析値と照らす撮影では窓の比も。reference は基準。
function diffuseSummaryOf(entry, irradiance, reference, exposure) {
  const mask = maskOf(reference.radius);
  let [negatives, visibleNegatives] = [0, 0];
  for (let p = 0; p < WIDTH * HEIGHT; p++) {
    if (!(reference.radius[p] > 0 && mask[p])) continue;
    const lowest = Math.min(irradiance[p * 3], irradiance[p * 3 + 1], irradiance[p * 3 + 2]);
    if (lowest < 0) negatives++;
    if (lowest * exposure < -DISPLAY_LSB) visibleNegatives++;
  }
  const ratios = entry.set === 'correctness' ? windowRatiosOf(entry, irradiance) : null;
  return { negatives, visibleNegatives, ratios };
}

// dir に残した撮影を基準 references と比べ、t の並び ts の順に、候補と撮影ごとの指標の表 byT と、候補ごとの
// ちらつき flicker を返す。imageDir が null でなければ、最初の t の超過の地図と誤差を 8 倍にした画像をそこへ書く。
function scoreSaved(dir, record, references, ts, imageDir) {
  const byT = ts.map(() => Object.fromEntries(record.candidates.map((c) => [c.label, {}])));
  const flickerFrames = Object.fromEntries(record.candidates.map((c) => [c.label, []]));
  for (const entry of ENTRIES) {
    const reference = references[entry.key];
    const lab0 = oklabOf(reference.display);
    const mask = maskOf(reference.radius);
    for (const candidate of record.candidates) {
      const labs = seedsOf(entry).map((_, index) => oklabOf(linearOfPng(readFileSync(capturePathOf(dir, entry, candidate.label, index)))));
      if (entry.set === 'flicker' || entry.key === 'bay') flickerFrames[candidate.label].push(labs[0][0]);
      if (entry.set === 'flicker') continue;
      const grainScale = Math.round(1 / candidate.tier.scale);
      // t によらない指標: 偏りと分散の R(s)、境界の漏れ、拡散照度から数えた値。
      const average = labs[0].map((plane, c) => plane.map((v, p) => (v + labs[1][c][p]) / 2));
      const surface = Uint8Array.from(reference.radius, (r, p) => (r > 0 && mask[p] ? 1 : 0));
      const edges = edgesOf(reference.normal, reference.depth, WIDTH, HEIGHT, EDGE_NORMAL_COS, EDGE_DEPTH_LSB);
      const common = {
        biasR: errorMetrics(average, lab0, mask, WIDTH, HEIGHT, ts[0], grainScale).r,
        varianceR: errorMetrics(labs[0], labs[1], mask, WIDTH, HEIGHT, ts[0], grainScale).r,
        leak: rmsOf(labs[0], lab0, nearEdgesOf(edges, surface, WIDTH, HEIGHT, EDGE_BAND)),
        ...record.diffuse[candidate.label][entry.key],
        referenceRatios: entry.set === 'correctness' ? windowRatiosOf(entry, reference.diffuse) : null,
      };
      // t ごとの指標。
      for (const [i, t] of ts.entries()) {
        const { excessMap, ...metrics } = errorMetrics(labs[0], lab0, mask, WIDTH, HEIGHT, t, grainScale);
        const scoreSecond = errorMetrics(labs[1], lab0, mask, WIDTH, HEIGHT, t, grainScale).score;
        byT[i][candidate.label][entry.key] = { ...metrics, ...common, scoreSecond };
        if (imageDir !== null && i === 0 && (entry.set === 'tuning' || entry.set === 'checking')) {
          writeImages(imageDir, candidate.label, entry.key, labs[0], lab0, excessMap);
        }
      }
    }
    console.log(`scored ${entry.key}`);
  }
  const flickerReference = [ENTRIES.find((e) => e.key === 'bay'), ...ENTRIES.filter((e) => e.set === 'flicker')]
    .map((entry) => oklabOf(references[entry.key].display)[0]);
  const flickerMask = maskOf(references.bay.radius);
  const flicker = Object.fromEntries(record.candidates.map((c) => [c.label, flickerOf(flickerFrames[c.label], flickerReference, flickerMask)]));
  return { byT, flicker };
}

// 超過の地図で白になる、画素ごとの超過の値。
const EXCESS_MAP_WHITE = 20;

// 候補 label の撮影 key の、超過の地図 excessMap と、表示(Oklab の平面の組 lab)の基準 lab0 からの誤差を 8 倍にした
// 画像を outDir へ書く。
function writeImages(outDir, label, key, lab, lab0, excessMap) {
  const map = Uint8Array.from(excessMap, (v) => Math.min(255, Math.round(255 * v / EXCESS_MAP_WHITE)));
  writeFileSync(path.join(outDir, `${key}.${label}.excess.png`), encodeGrayPng(WIDTH, HEIGHT, map));
  const enhanced = linearOfOklab(scaledErrorOf(lab0, lab, 8));
  writeFileSync(path.join(outDir, `${key}.${label}.error8.png`), encodeRgbPng(WIDTH, HEIGHT, srgbCodesOfLinear(enhanced)));
}

// 値の並び values の平均。
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

// 表。候補ごとの費用と調整用・確認用の S の平均、撮影ごとの S、帯ごとの超過、解析値との照合。costs は候補ごとの
// GPU の行の p50 [ms]、flicker は候補ごとのちらつき。
function reportOf(candidates, results, costs, flicker) {
  const keysOf = (set) => ENTRIES.filter((e) => e.set === set).map((e) => e.key);
  const [tuning, checking, correctness] = ['tuning', 'checking', 'correctness'].map(keysOf);
  const measured = [...tuning, ...checking];
  // 費用は近傍拡散補正の 4 行の和の、マテリアルの行に対する比。
  const costOf = (row) => {
    const parts = ['照り返し源', '近傍拡散走査', '近傍拡散均し', '近傍拡散拡大', 'マテリアル'].map((label) => row[label]);
    return parts.some((v) => v === null) ? null : (parts[0] + parts[1] + parts[2] + parts[3]) / parts[4];
  };
  const summary = candidates.map((candidate, i) => {
    const rows = results[candidate.label];
    const avg = (keys, field) => mean(keys.map((k) => rows[k][field]));
    const bands = (field) => BAND_SCALES.map((_, j) => mean(tuning.map((k) => rows[k][field][j])).toFixed(2)).join(' / ');
    const sum = (field) => measured.reduce((total, k) => total + rows[k][field], 0);
    return [
      candidate.label, fixed(costOf(costs[i]), 2), avg(tuning, 'score').toFixed(3), avg(tuning, 'widthTerm').toFixed(3),
      avg(tuning, 'excessTerm').toFixed(3), avg(tuning, 'g').toFixed(4), (100 * avg(tuning, 'tail')).toFixed(2),
      avg(checking, 'score').toFixed(3), avg(tuning, 'scoreSecond').toFixed(3), avg(measured, 'leak').toFixed(4),
      fixed(flicker[candidate.label], 5), `${sum('negatives')} / ${sum('visibleNegatives')}`,
      bands('r'), bands('biasR'), bands('varianceR'),
    ];
  });
  const perShot = candidates.map((candidate) => [candidate.label, ...measured.map((k) => {
    const row = results[candidate.label][k];
    return `${row.score.toFixed(2)} (${row.widthTerm.toFixed(2)} + ${row.excessTerm.toFixed(2)})`;
  })]);
  const perBand = candidates.map((candidate) => [candidate.label, ...Array.from(
    { length: BAND_SCALES.length + 1 }, (_, j) => mean(tuning.map((k) => results[candidate.label][k].excessByBand[j])).toFixed(3),
  )]);
  const ratios = correctness.map((key) => {
    const analytic = analyticRatiosOf(key);
    const format = (values) => values.map((v) => fixed(v, 3)).join(' / ');
    return [key, format(analytic), format(results[candidates[0].label][key].referenceRatios),
      ...candidates.map((c) => format(results[c.label][key].ratios))];
  });
  return [
    '## 候補', '',
    ...table(['候補', '費用 / マテリアル', 'S 調整用', '幅', '超過', 'G', '裾 [%]', 'S 確認用', 'S の 2 つ目の seed',
      '境界の漏れ', 'ちらつき', '負の画素 / 見える', 'R(s) L', 'R(s) 偏り', 'R(s) 分散'], summary),
    '', '## 撮影ごとの S(幅 + 超過)', '', ...table(['候補', ...measured], perShot),
    '', '## 帯ごとの超過(調整用の平均)', '', ...table(['候補', ...BAND_SCALES.map((s) => `${s} px`), '残り'], perBand),
    '', '## 解析値のある窓の比(拡散照度。bay は P_in / P_out、bounce-cosine は余弦 1 / 0.5 / 0)', '',
    ...table(['撮影', '解析値', '基準', ...candidates.map((c) => c.label)], ratios),
    '',
  ].join('\n');
}

// ---- 刺激 ----

// 刺激を作る撮影と、誤差を縮める倍率。
const STIMULUS_SHOTS = ['bay', 'bay-dark', 'bay-earth-open'];
const STIMULUS_SCALES = [1, 1 / 2, 1 / 4, 1 / 8];
// 外れ値の刺激の、表示の空間で誤差を均すガウスの標準偏差と半径 [画素]。中設定の均し(走査の画素で標準偏差 1、
// 半径 2)を描画バッファの画素へ写したもの。
const STIMULUS_BLUR_SIGMA = 4;
const STIMULUS_BLUR_RADIUS = 8;

async function stimuli({ options }) {
  const name = options.reference ?? headHash();
  const stimulusEntries = ENTRIES.filter((e) => STIMULUS_SHOTS.includes(e.key));
  const references = loadReference(name, stimulusEntries);
  const captures = await withLab(async (lab) => {
    const out = {};
    for (const entry of stimulusEntries) {
      await lab.show(entry);
      out[entry.key] = {};
      for (const [label, tier] of [['smoothed', TIERS.medium], ['raw', { ...TIERS.medium, denoiseRadius: 0 }]]) {
        await lab.setTier(tier);
        await lab.setSeed(seedOf(0));
        out[entry.key][label] = await captureLinear(lab);
      }
    }
    return out;
  });
  const random = uniformRandom(Date.now() >>> 0);
  for (const entry of stimulusEntries) {
    const dir = path.join(shotsDir, 'ssd-stimuli', entry.key);
    mkdirSync(dir, { recursive: true });
    const reference = oklabOf(references[entry.key].display);
    const surface = Uint8Array.from(references[entry.key].radius, (r) => (r > 0 ? 1 : 0));
    const smoothed = oklabOf(captures[entry.key].smoothed);
    const raw = oklabOf(captures[entry.key].raw);
    // 誤差を縮めた刺激と、raw の誤差を表示の空間で均した刺激。
    const scaled = STIMULUS_SCALES.map((a) => ({ content: `smoothed-error x${a}`, image: scaledErrorOf(reference, smoothed, a) }));
    const blurredError = raw.map((plane, c) => gaussianBlurOf(
      plane.map((v, p) => v - reference[c][p]), surface, WIDTH, HEIGHT, STIMULUS_BLUR_SIGMA, STIMULUS_BLUR_RADIUS));
    const pair = [
      { content: 'smoothed (linear irradiance)', image: smoothed },
      { content: 'raw error blurred in display space', image: reference.map((plane, c) => plane.map((v, p) => v + blurredError[c][p])) },
    ];
    const key = {};
    const write = (prefix, items) => {
      const order = items.map((item) => ({ item, sort: random() })).sort((a, b) => a.sort - b.sort);
      for (const [i, { item }] of order.entries()) {
        const file = `${prefix}${i + 1}.png`;
        writeFileSync(path.join(dir, file), encodeRgbPng(WIDTH, HEIGHT, srgbCodesOfLinear(linearOfOklab(item.image))));
        key[file] = item.content;
      }
    };
    writeFileSync(path.join(dir, 'reference.png'), encodeRgbPng(WIDTH, HEIGHT, srgbCodesOfLinear(references[entry.key].display)));
    write('t', scaled);
    write('pair', pair);
    writeFileSync(path.join(dir, 'key.json'), JSON.stringify(key, null, 1));
    console.log(`stimuli ${path.relative(root, dir)}`);
  }
}

const COMMANDS = { reference, check, compare, rescore, stimuli };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error('usage: node tools/render-lab-screen-space-metrics.mjs reference|check|compare|rescore|stimuli [...]');
  }
  await COMMANDS[command](parseArgs(rest));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
