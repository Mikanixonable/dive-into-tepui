// 近傍拡散補正の画質と費用の計測。ヘッドレス Chrome で .render-lab/ を開き、評価の組の撮影を、走査の段と
// ブルーノイズの seed を与えて撮る。4 つの使い方がある。
//
//   reference [--name D] [--entries K,...] [--sets S,...] --slices S --steps T --passes N
//     基準 B(全解像度・均しなし・1 パス S スライス × 片側 T 歩で、seed を変えた N パスの平均)を
//     .render-lab-shots/ssd-reference/<D>/ へ作る。同じ D で呼び直すと、保存済みのパスへ N 個目まで続きから足す。
//     D の既定は HEAD の短いハッシュ。--entries と --sets は評価の組のうち作る撮影の key と set
//     (tuning・checking・correctness・flicker)。
//   check D [D₂] [--entries K,...]
//     基準 D の偶数番目と奇数番目のパスの差(雑音)と、歩数を倍にした D₂ との差を、いまの中設定(均しなし)の誤差と
//     比べて収束を判定する。--entries の既定は bay。
//   compare [<candidates.json>] [--reference D] [--t T] [--out O]
//     候補の段(既定は精細さの 3 段の均し前後と、中の均し前のスライスを 2・4・8 倍にしたもの)を B と比べ、
//     指標と費用の表を出す。超過の地図と誤差を 8 倍にした画像を .render-lab-shots/ssd-compare/<O>/ へ書く。
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
  analyticRatiosOf, captureLinear, ENTRIES, fixed, HEIGHT, headHash, loadReference, maskOf, root, seedOf, shotsDir,
  table, TIERS, WIDTH, windowRatiosOf, withLab,
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

async function compare({ positional, options }) {
  const candidates = positional[0] === undefined ? DEFAULT_CANDIDATES : JSON.parse(readFileSync(positional[0], 'utf8'));
  const name = options.reference ?? headHash();
  const t = Number(options.t ?? DEFAULT_T);
  const outDir = path.join(shotsDir, 'ssd-compare', options.out ?? name);
  mkdirSync(outDir, { recursive: true });
  const references = loadReference(name, ENTRIES);
  const { meta } = references[ENTRIES[0].key];
  console.log(`基準 ${name}(${meta.slices} スライス × 片側 ${meta.steps} 歩、${meta.passes} パス)、t = ${t}`);
  const seeds = [seedOf(0), seedOf(1)];
  // results[candidate.label][entry.key] = 指標。
  const results = Object.fromEntries(candidates.map((c) => [c.label, {}]));
  const flickerFrames = Object.fromEntries(candidates.map((c) => [c.label, []]));
  const costs = await withLab(async (lab) => {
    for (const entry of ENTRIES) {
      await lab.show(entry);
      const reference = references[entry.key];
      const lab0 = oklabOf(reference.display);
      const mask = maskOf(reference.radius);
      for (const candidate of candidates) {
        await lab.setTier(candidate.tier);
        // ちらつきのフレームは seed 0 の 1 枚だけ。ほかは seed を変えた 2 枚を撮り、拡散照度は 1 枚目だけ読む。
        const captures = [];
        for (const seed of entry.set === 'flicker' ? [seeds[0]] : seeds) {
          await lab.setSeed(seed);
          const display = await captureLinear(lab);
          captures.push({ display, diffuse: captures.length === 0 ? await lab.readFloat('diffuse', 3) : null });
        }
        if (entry.set === 'flicker' || entry.key === 'bay') flickerFrames[candidate.label].push(oklabOf(captures[0].display)[0]);
        if (entry.set === 'flicker') continue;
        const grainScale = Math.round(1 / candidate.tier.scale);
        const exposure = await lab.exposureFactor();
        const measured = measureCandidate(entry, captures, reference, lab0, mask, t, grainScale, exposure);
        if (entry.set === 'tuning' || entry.set === 'checking') writeImages(outDir, candidate.label, entry.key, captures[0].display, lab0, measured.excessMap);
        results[candidate.label][entry.key] = { ...measured, excessMap: null };
      }
      console.log(`compared ${entry.key}`);
    }
    // 費用。コンパイルを済ませてから、bay で段を交互に測る。
    await lab.show(ENTRIES[0]);
    await lab.capturePng();
    return lab.measureTiers(candidates.map((c) => c.tier), 3);
  });
  const flickerReference = [ENTRIES.find((e) => e.key === 'bay'), ...ENTRIES.filter((e) => e.set === 'flicker')]
    .map((entry) => oklabOf(references[entry.key].display)[0]);
  const flickerMask = maskOf(references.bay.radius);
  const flicker = Object.fromEntries(candidates.map((c) => [c.label, flickerOf(flickerFrames[c.label], flickerReference, flickerMask)]));
  const report = reportOf(candidates, results, costs, flicker);
  writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(`\n${report}`);
}

// 候補の撮影 captures(seed ごとの { display, diffuse })を基準 reference と比べた指標。exposure は露出係数。
function measureCandidate(entry, captures, reference, lab0, mask, t, grainScale, exposure) {
  const labs = captures.map(({ display }) => oklabOf(display));
  const metrics = errorMetrics(labs[0], lab0, mask, WIDTH, HEIGHT, t, grainScale);
  const second = errorMetrics(labs[1], lab0, mask, WIDTH, HEIGHT, t, grainScale);
  const mean = labs[0].map((plane, c) => plane.map((v, p) => (v + labs[1][c][p]) / 2));
  const bias = errorMetrics(mean, lab0, mask, WIDTH, HEIGHT, t, grainScale);
  const variance = errorMetrics(labs[0], labs[1], mask, WIDTH, HEIGHT, t, grainScale);
  // 境界の漏れ: 深度・法線の境から EDGE_BAND 画素以内の面。
  const surface = Uint8Array.from(reference.radius, (r, p) => (r > 0 && mask[p] ? 1 : 0));
  const edges = edgesOf(reference.normal, reference.depth, WIDTH, HEIGHT, EDGE_NORMAL_COS, EDGE_DEPTH_LSB);
  const leak = rmsOf(labs[0], lab0, nearEdgesOf(edges, surface, WIDTH, HEIGHT, EDGE_BAND));
  const result = { ...metrics, scoreSecond: second.score, biasR: bias.r, varianceR: variance.r, leak };
  // 有界性: 拡散照度(補正を含む)が負の面と、その暗さが表示で 1 LSB を超えうるもの(アルベド 1 とみなす)。
  const diffuse = captures[0].diffuse;
  result.negatives = 0;
  result.visibleNegatives = 0;
  for (let p = 0; p < WIDTH * HEIGHT; p++) {
    if (!surface[p]) continue;
    const lowest = Math.min(diffuse[p * 3], diffuse[p * 3 + 1], diffuse[p * 3 + 2]);
    if (lowest < 0) result.negatives++;
    if (lowest * exposure < -DISPLAY_LSB) result.visibleNegatives++;
  }
  if (entry.set === 'correctness') {
    result.ratios = windowRatiosOf(entry, diffuse);
    result.referenceRatios = windowRatiosOf(entry, reference.diffuse);
  }
  return result;
}

// 超過の地図で白になる、画素ごとの超過の値。
const EXCESS_MAP_WHITE = 20;

// 候補 label の撮影 key の、超過の地図 excessMap と、表示 display の基準 lab0 からの誤差を 8 倍にした画像を
// outDir へ書く。
function writeImages(outDir, label, key, display, lab0, excessMap) {
  const map = Uint8Array.from(excessMap, (v) => Math.min(255, Math.round(255 * v / EXCESS_MAP_WHITE)));
  writeFileSync(path.join(outDir, `${key}.${label}.excess.png`), encodeGrayPng(WIDTH, HEIGHT, map));
  const enhanced = linearOfOklab(scaledErrorOf(lab0, oklabOf(display), 8));
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

const COMMANDS = { reference, check, compare, stimuli };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error('usage: node tools/render-lab-screen-space-metrics.mjs reference|check|compare|stimuli [...]');
  }
  await COMMANDS[command](parseArgs(rest));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
