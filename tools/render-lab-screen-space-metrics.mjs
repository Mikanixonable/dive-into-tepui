// 近傍拡散補正の画質と費用の計測。ヘッドレス Chrome で .render-lab/ を開き、評価の組の撮影を、走査の段と
// ブルーノイズの seed を与えて撮る。3 つの使い方がある。
//
//   reference [--slices N] [--steps N] [--seeds K] [--name D] [--check] [--sets S,...]
//     基準 B(全解像度・均しなし・標本を増やし seed を変えた K 枚の平均)を作り、.render-lab-shots/ssd-reference/<D>/
//     へ書き、解析値のある窓の比を表にする。D の既定は HEAD の短いハッシュ。--check は seed を変えた B′ と歩数を倍に
//     した B″ も作り、収束を表にする。--sets は評価の組のうち作る set(tuning・checking・correctness・flicker)。
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
  scaledErrorOf, srgbCodesOfLinear, uniformRandom, windowMean,
} from './screen-space-error.mjs';
import {
  averageOf, captureLinear, ENTRIES, HEIGHT, headHash, loadReference, maskOf, readFloats, referenceDirOf, root,
  seedOf, shotsDir, TIERS, WIDTH, withLab, writeFloats,
} from './screen-space-lab.mjs';

// 解析値のある窓(960×540 の画素、tools/render-lab/bay-cases.ts の注記)と、窓の半幅 [画素]。
const WINDOWS = { P_in: [412, 179], P_out: [186, 183] };
const WINDOW_HALF = 2;
// bay の天体照の撮影の P_in / P_out の解析値(遮蔽 / 遮蔽と照り返し)。
const ANALYTIC_RATIOS = {
  'bay-earth-overhead': [0.32, 0.49], 'bay-earth-open': [0.64, 1.06], 'bay-earth-corner': [0, 0],
  'bay-moon-open': [1.0, 1.38], 'bay-moon-corner': [0, 0],
};
// bounce-cosine の、送り手の余弦 1 / 0.5 / 0 の受け手の中心の画素(tools/render-lab/bounce-cosine-case.ts)と、
// 照り返しの比の有限の面光源での解析値。
const BOUNCE_RECEIVERS = [[284, 285], [480, 285], [676, 285]];
const ANALYTIC_BOUNCE_RATIOS = [1, 0.58, 0];
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

async function reference({ options }) {
  const tier = {
    scale: 1, sliceCount: Number(options.slices ?? 16), stepCount: Number(options.steps ?? 16), denoiseRadius: 0,
  };
  const seedCount = Number(options.seeds ?? 8);
  const name = options.name ?? headHash();
  const dir = referenceDirOf(name);
  mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const entries = options.sets === undefined ? ENTRIES : ENTRIES.filter((e) => options.sets.split(',').includes(e.set));
  const convergence = [];
  const ratios = [];
  await withLab(async (lab) => {
    for (const entry of entries) {
      await lab.show(entry);
      const file = (suffix) => path.join(dir, `${entry.key}.${suffix}`);
      // 形だけで決まるもの: 近傍の半径と、境界を探す法線と深度の表示。
      await lab.setTier(tier);
      await lab.capturePng();
      writeFloats(file('radius.f32'), await lab.readFloat('projected-radius', 1));
      for (const target of ['normal', 'depth']) {
        await lab.setTarget(target);
        writeFileSync(file(`${target}.png`), await lab.capturePng());
      }
      await lab.setTarget('off');
      const seeds = Array.from({ length: seedCount }, (_, k) => seedOf(k));
      const withDiffuse = entry.set === 'correctness';
      const b = await averageOf(lab, tier, seeds, withDiffuse);
      writeFloats(file('display.f32'), b.display);
      if (withDiffuse) {
        writeFloats(file('diffuse.f32'), b.diffuse);
        ratios.push([entry.key, analyticRatiosOf(entry.key), windowRatiosOf(entry, b.diffuse)]);
      }
      console.log(`reference ${entry.key} (${((Date.now() - started) / 1000).toFixed(0)} s)`);
      if (options.check && entry.set === 'tuning') convergence.push(await convergenceOf(lab, entry, tier, seedCount, b));
    }
  });
  const seconds = (Date.now() - started) / 1000;
  writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({
    commit: headHash(), tier, seeds: seedCount, seconds, created: new Date().toISOString(),
  }, null, 1));
  console.log(`\n基準 ${path.relative(root, dir)}: 段 ${JSON.stringify(tier)}、seed ${seedCount} 枚、${seconds.toFixed(0)} s`);
  printCoverage(name, entries);
  if (convergence.length > 0) printConvergence(convergence);
  const format = (values) => values.map((v) => fixed(v, 3)).join(' / ');
  const rows = ratios.map(([key, analytic, b]) => [key, format(analytic), format(b)]);
  console.log(['', ...table(['撮影', '解析値', '基準'], rows)].join('\n'));
}

// entry の基準 b の収束: seed を変えた B′ と歩数を倍にした B″ の b との差の G と R(s)、比べる相手のいまの中設定
// (均しなし)の G。
async function convergenceOf(lab, entry, tier, seedCount, b) {
  const seeds = Array.from({ length: seedCount }, (_, k) => seedOf(seedCount + k));
  const other = await averageOf(lab, tier, seeds, false);
  const doubled = await averageOf(lab, { ...tier, stepCount: tier.stepCount * 2 }, seeds, false);
  const current = await averageOf(lab, { ...TIERS.medium, denoiseRadius: 0 }, [0], false);
  const reference = oklabOf(b.display);
  const radius = await lab.readFloat('projected-radius', 1);
  const mask = maskOf(radius);
  const measure = (image, grainScale) => errorMetrics(oklabOf(image.display), reference, mask, WIDTH, HEIGHT, 0, grainScale);
  return { key: entry.key, seed: measure(other, 1), steps: measure(doubled, 1), current: measure(current, 4) };
}

function printConvergence(rows) {
  console.log('\n| 撮影 | G(B − B′) | G(B − B″) | G(中・均しなし) | R(s) B − B′ | R(s) B − B″ |');
  console.log('| --- | --- | --- | --- | --- | --- |');
  for (const { key, seed, steps, current } of rows) {
    const r = (m) => m.r.map((v) => v.toFixed(2)).join(' / ');
    console.log(`| ${key} | ${seed.g.toFixed(5)} | ${steps.g.toFixed(5)} | ${current.g.toFixed(5)} | ${r(seed)} | ${r(steps)} |`);
  }
}

// 基準の組 name の評価の組 entries の、撮影ごとの近傍の半径のオクターブごとの画素数と、溝の梯子の溝の画面上の幅。
function printCoverage(name, entries) {
  const dir = referenceDirOf(name);
  const octaves = Array.from({ length: 10 }, (_, j) => 2 ** (j + 1));
  console.log(`\n| 撮影 | ${octaves.map((o) => `${o}〜`).join(' | ')} |`);
  console.log(`|${' --- |'.repeat(octaves.length + 1)}`);
  for (const entry of entries.filter((e) => e.set === 'tuning' || e.set === 'checking')) {
    const radius = readFloats(path.join(dir, `${entry.key}.radius.f32`));
    const counts = octaves.map((o) => radius.filter((r) => r >= o && r < 2 * o).length);
    console.log(`| ${entry.key} | ${counts.join(' | ')} |`);
    if (entry.caseName === 'groove-ladder') {
      // 近傍の半径 R [画素] の面では、幅 w [m] の溝が w·R/4 画素に写る(近傍の半径は 4 m)。
      const sorted = radius.filter((r) => r > 0).sort((a, b) => a - b);
      const [low, high] = [sorted[Math.floor(sorted.length * 0.1)], sorted[Math.floor(sorted.length * 0.9)]];
      const widths = Array.from({ length: 7 }, (_, k) => 0.03 * 2 ** k)
        .map((w) => `${(w * low / 4).toFixed(1)}〜${(w * high / 4).toFixed(1)}`);
      console.log(`|   溝の幅 [画素](R の 10〜90 百分位) | ${widths.join(' | ')} |`);
    }
  }
}

// ---- 比較 ----

async function compare({ positional, options }) {
  const candidates = positional[0] === undefined ? DEFAULT_CANDIDATES : JSON.parse(readFileSync(positional[0], 'utf8'));
  const name = options.reference ?? headHash();
  const t = Number(options.t ?? DEFAULT_T);
  const outDir = path.join(shotsDir, 'ssd-compare', options.out ?? name);
  mkdirSync(outDir, { recursive: true });
  const { meta, entries: references } = loadReference(name);
  console.log(`基準 ${name}(${meta.commit}、段 ${JSON.stringify(meta.tier)}、seed ${meta.seeds} 枚)、t = ${t}`);
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

// 撮影 key の、解析値のある窓どうしの比の解析値(windowRatiosOf と同じ並び)。解析値の無い撮影は undefined。
function analyticRatiosOf(key) {
  const [shot, suffix] = key.split('@');
  if (shot === 'bounce-cosine') return ANALYTIC_BOUNCE_RATIOS;
  return [ANALYTIC_RATIOS[shot]?.[suffix === 'occlusion' ? 0 : 1]];
}

// 拡散照度 diffuse(rgb)の、解析値のある窓どうしの輝度の比。bay は P_in / P_out、bounce-cosine は受け手ごとの
// 余弦 1 の受け手に対する比。
function windowRatiosOf(entry, diffuse) {
  const luminanceAt = (center) => {
    const [r, g, b] = windowMean(diffuse, 3, WIDTH, center, WINDOW_HALF);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  if (entry.caseName === 'bounce-cosine') return BOUNCE_RECEIVERS.map((c) => luminanceAt(c) / luminanceAt(BOUNCE_RECEIVERS[0]));
  return [luminanceAt(WINDOWS.P_in) / luminanceAt(WINDOWS.P_out)];
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

// markdown の表の行。header は見出しの並び、rows は行ごとのセルの並び。
function table(header, rows) {
  return [`| ${header.join(' | ')} |`, `|${' --- |'.repeat(header.length)}`, ...rows.map((cells) => `| ${cells.join(' | ')} |`)];
}

// 小数 digits 桁の文字列。null・undefined・NaN(測れなかった値)は —。
const fixed = (v, digits) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(digits));
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
  const { entries: references } = loadReference(name);
  const stimulusEntries = ENTRIES.filter((e) => STIMULUS_SHOTS.includes(e.key));
  const captures = await withLab(async (lab) => {
    const out = {};
    for (const entry of stimulusEntries) {
      await lab.show(entry);
      out[entry.key] = {};
      for (const [label, tier] of [['smoothed', TIERS.medium], ['raw', { ...TIERS.medium, denoiseRadius: 0 }]]) {
        await lab.setTier(tier);
        await lab.setSeed(0);
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

const COMMANDS = { reference, compare, stimuli };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(COMMANDS, command)) throw new Error('usage: node tools/render-lab-screen-space-metrics.mjs reference|compare|stimuli [...]');
  await COMMANDS[command](parseArgs(rest));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
