// 近傍拡散補正の画質と費用の計測。ヘッドレス Chrome で .render-lab/ を開き、評価の組の撮影を、走査の段と
// ブルーノイズの seed を与えて撮る。画質は補正項だけを、アルベド 1 の面の表示の尺度 q = 露出係数·ΔE/π で測る。
// 6 つの使い方がある。
//
//   reference [--name D] [--entries K,...] [--sets S,...] --slices S --steps T --passes N
//     基準 B(全解像度・均しなし・1 パス S スライス × 片側 T 歩で、seed を変えた N パスの補正の和と、目で見る画像の
//     ための HDR の平均の表示)を .render-lab-shots/ssd-reference/<D>/ へ作る。同じ D で呼び直すと、保存済みの
//     パスへ N 個目まで続きから足す。D の既定は HEAD の短いハッシュ。--entries と --sets は評価の組のうち作る撮影の
//     key と set(tuning・checking・correctness・flicker)。
//   check D [--entries K,...]
//     基準 D の偶数番目と奇数番目のパスの差(雑音)を、いまの中設定(均しなし)の誤差と比べて収束を判定する。
//     --entries の既定は bay。
//   compare [<candidates.json>] [--reference D] [--entries K,...] [--sets S,...] [--t T] [--out O]
//     候補の段(既定は精細さの 3 段の均し前後と、中の均し前のスライスを 2・4・8 倍にしたもの)を B と比べ、
//     指標と費用の表を出す。超過の地図と、表示の誤差を 8 倍にした画像を .render-lab-shots/ssd-compare/<O>/ へ書き、
//     候補の撮影(captures/)と費用・拡散照度から数えた値(record.json)も残す。--entries と --sets は reference と同じ。
//   rescore <出力先> [--reference D] --t T,...
//     compare か threshold が残した撮影を、撮り直さずに t ごとに採点し直し、表を <出力先>/report-t<T>.md へ書く。
//     D の既定は撮影に使った基準。
//   stimuli [--reference D]
//     目視の刺激(B の表示に中設定の表示の誤差を縮めて足した画像と、raw の誤差を表示の空間で均した画像)を、中身を
//     伏せた名前で .render-lab-shots/ssd-stimuli/<撮影>/ へ書く。対応表は key.json。
//   threshold [--name D]
//     刺激の目視の判定から t を測る。刺激の撮影の B を刺激と同じ段で ssd-reference/<D>/ へ作り、同じセッションで精細さの
//     3 段の均し前後を撮って ssd-compare/<D>/ へ残す。中(均し後、1 つ目の seed)の誤差を刺激の倍率にしたときの、
//     粒で説明できる幅からのはみ出しの 99 百分位を表にし、採用可能とされた倍率での撮影どうしの最小を t とする。
//     その t で採点した表も書く。D の既定は HEAD の短いハッシュに -threshold を付けたもの。
//
// 先に .render-lab/ を組んでおくこと(webpack --config webpack.render-lab.config.js --mode production)。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeGrayPng, encodeRgbPng } from './png.mjs';
import {
  BAND_SCALES, edgesOf, errorMetrics, exposedCorrectionOf, flickerOf, gaussianBlurOf, linearOfOklab, marginQuantileOf,
  nearEdgesOf, oklabOf, rmsOf, scaledErrorOf, srgbCodesOfLinear, uniformRandom,
} from './screen-space-error.mjs';
import {
  analyticRatiosOf, captureLinear, ENTRIES, fixed, HEIGHT, headHash, linearOfPng, loadReference, maskOf,
  readHalfFloats, referenceMetaOf, root, seedOf, selectedEntries, shotsDir, table, TIERS, WIDTH, windowRatiosOf, withLab,
  writeHalfFloats,
} from './screen-space-lab.mjs';
import { check, extendReference, reference } from './screen-space-reference.mjs';

// 境界とみなす法線のなす角の余弦と深度の表示の差 [LSB]、境界の帯の幅 [画素]。
const EDGE_NORMAL_COS = Math.cos(Math.PI / 6);
const EDGE_DEPTH_LSB = 3;
const EDGE_BAND = 2;
// 表示で見えない差 t(q)。threshold で、stimuli の刺激の目視の判定から測った値。
const DEFAULT_T = 0.00032;
// 表示の 1 LSB に当たる、黒の近くの線形の値。
const DISPLAY_LSB = 1 / (255 * 12.92);

// 精細さの 3 段の、均した後と均す前(-raw)。
const QUALITY_CANDIDATES = Object.entries(TIERS).flatMap(([name, tier]) => [
  { label: `${name}`, tier },
  { label: `${name}-raw`, tier: { ...tier, denoiseRadius: 0 } },
]);
const DEFAULT_CANDIDATES = [
  ...QUALITY_CANDIDATES,
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
// 超過の地図と、誤差を 8 倍にした画像を書く撮影。
const imagedOf = (entry) => entry.set === 'tuning' || entry.set === 'checking';

async function compare({ positional, options }) {
  const candidates = positional[0] === undefined ? DEFAULT_CANDIDATES : JSON.parse(readFileSync(positional[0], 'utf8'));
  const name = options.reference ?? headHash();
  const t = Number(options.t ?? DEFAULT_T);
  const outDir = path.join(shotsDir, 'ssd-compare', options.out ?? name);
  const entries = selectedEntries(options);
  const references = loadReference(name, entries);
  const { meta } = references[entries[0].key];
  console.log(`基準 ${name}(${meta.slices} スライス × 片側 ${meta.steps} 歩、${meta.passes} パス)、t = ${t}`);
  const { diffuse, costs } = await withLab(async (lab) => {
    const captured = await captureCandidates(lab, outDir, entries, candidates, references);
    // 費用。コンパイルを済ませてから、bay で段を交互に測る。
    await lab.show(ENTRIES[0]);
    await lab.capturePng();
    return { diffuse: captured, costs: await lab.measureTiers(candidates.map((c) => c.tier), 3) };
  });
  const record = { reference: name, entries: entries.map((e) => e.key), candidates, costs, diffuse };
  writeFileSync(recordPathOf(outDir), JSON.stringify(record));
  const { byT, flicker } = scoreSaved(outDir, record, references, [t], outDir);
  const report = reportOf(record, byT[0], flicker);
  writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(`\n${report}`);
}

// compare か threshold が残した dir の撮影を、撮り直さずに t の並び(--t)ごとに採点し直し、report-t<t>.md を書く。
// 費用と拡散照度から数えた値は撮影のときの記録のまま。
async function rescore({ positional, options }) {
  const dir = positional[0];
  if (dir === undefined || typeof options.t !== 'string') throw new Error('usage: rescore <出力先> [--reference D] --t <t,...>');
  const record = JSON.parse(readFileSync(recordPathOf(dir), 'utf8'));
  const ts = options.t.split(',').map(Number);
  const references = loadReference(options.reference ?? record.reference, recordEntriesOf(record));
  const { byT, flicker } = scoreSaved(dir, record, references, ts, null);
  for (const [i, t] of ts.entries()) {
    const file = path.join(dir, `report-t${t}.md`);
    writeFileSync(file, reportOf(record, byT[i], flicker));
    console.log(`rescored t = ${t}: ${file}`);
  }
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

// dir に残した撮影を基準 references と比べ、t の並び ts の順に、候補と撮影ごとの指標の表 byT と、候補ごとの
// ちらつき flicker(bay とちらつきの全フレームを撮っていなければ null)を返す。imageDir が null でなければ、最初の
// t の超過の地図と表示の誤差を 8 倍にした画像をそこへ書く。
function scoreSaved(dir, record, references, ts, imageDir) {
  const entries = recordEntriesOf(record);
  const byT = ts.map(() => Object.fromEntries(record.candidates.map((c) => [c.label, {}])));
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
      // t によらない指標: 偏りと分散の R(s)、境界の漏れ、拡散照度から数えた値。
      const average = qs[0].map((plane, c) => plane.map((v, p) => (v + qs[1][c][p]) / 2));
      const common = {
        biasR: errorMetrics(average, q0, mask, WIDTH, HEIGHT, ts[0]).r,
        varianceR: errorMetrics(qs[0], qs[1], mask, WIDTH, HEIGHT, ts[0]).r,
        leak: rmsOf(qs[0], q0, nearEdges),
        ...record.diffuse[candidate.label][entry.key],
        referenceRatios: entry.set === 'correctness' ? windowRatiosOf(entry, reference.diffuse) : null,
      };
      // t ごとの指標。
      for (const [i, t] of ts.entries()) {
        const { excessMap, ...metrics } = errorMetrics(qs[0], q0, mask, WIDTH, HEIGHT, t);
        const scoreSecond = errorMetrics(qs[1], q0, mask, WIDTH, HEIGHT, t).score;
        byT[i][candidate.label][entry.key] = { ...metrics, ...common, scoreSecond };
        if (imageDir !== null && i === 0 && imagedOf(entry)) {
          const display = linearOfPng(readFileSync(displayPathOf(dir, entry, candidate.label)));
          writeImages(imageDir, candidate.label, entry.key, display, reference.display, excessMap);
        }
      }
    }
    console.log(`scored ${entry.key}`);
  }
  const flickerEntries = [ENTRIES.find((e) => e.key === 'bay'), ...ENTRIES.filter((e) => e.set === 'flicker')];
  const flickerReference = flickerEntries.every((e) => record.entries.includes(e.key))
    ? flickerEntries.map((e) => references[e.key].exposedCorrection) : null;
  const flicker = Object.fromEntries(record.candidates.map((c) => [c.label, flickerReference === null ? null
    : flickerOf(flickerFrames[c.label], flickerReference, maskOf(references.bay.radius))]));
  return { byT, flicker };
}

// 超過の地図で白になる、画素ごとの超過の値。
const EXCESS_MAP_WHITE = 20;

// 候補 label の撮影 key の、超過の地図 excessMap と、候補の表示 display の基準の表示 referenceDisplay(どちらも
// 線形 sRGB)からの差を Oklab で 8 倍にした画像を outDir へ書く。
function writeImages(outDir, label, key, display, referenceDisplay, excessMap) {
  const map = Uint8Array.from(excessMap, (v) => Math.min(255, Math.round(255 * v / EXCESS_MAP_WHITE)));
  writeFileSync(path.join(outDir, `${key}.${label}.excess.png`), encodeGrayPng(WIDTH, HEIGHT, map));
  const enhanced = linearOfOklab(scaledErrorOf(oklabOf(referenceDisplay), oklabOf(display), 8));
  writeFileSync(path.join(outDir, `${key}.${label}.error8.png`), encodeRgbPng(WIDTH, HEIGHT, srgbCodesOfLinear(enhanced)));
}

// 値の並び values の平均。空なら NaN。
const mean = (values) => values.reduce((sum, v) => sum + v, 0) / values.length;

// 記録 record の表。候補ごとの費用と調整用・確認用の S の平均、撮影ごとの S、帯ごとの超過、解析値との照合。results
// は候補と撮影ごとの指標、flicker は候補ごとのちらつき。撮っていない組の平均は —。
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
    const bands = (field) => BAND_SCALES.map((_, j) => fixed(mean(tuning.map((k) => rows[k][field][j])), 2)).join(' / ');
    const sum = (field) => measured.reduce((total, k) => total + rows[k][field], 0);
    return [
      candidate.label, fixed(costOf(costs[i]), 2), avg(tuning, 'score', 3), avg(tuning, 'widthTerm', 3),
      avg(tuning, 'excessTerm', 3), avg(tuning, 'g', 5), fixed(100 * mean(tuning.map((k) => rows[k].tail)), 2),
      avg(checking, 'score', 3), avg(tuning, 'scoreSecond', 3), avg(measured, 'leak', 5),
      fixed(flicker[candidate.label], 5), `${sum('negatives')} / ${sum('visibleNegatives')}`,
      bands('r'), bands('biasR'), bands('varianceR'),
    ];
  });
  const perShot = candidates.map((candidate) => [candidate.label, ...measured.map((k) => {
    const row = results[candidate.label][k];
    return `${row.score.toFixed(3)} (${row.widthTerm.toFixed(3)} + ${row.excessTerm.toFixed(3)})`;
  })]);
  const perBand = candidates.map((candidate) => [candidate.label, ...Array.from(
    { length: BAND_SCALES.length + 1 }, (_, j) => fixed(mean(tuning.map((k) => results[candidate.label][k].excessByBand[j])), 3),
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
      '境界の漏れ', 'ちらつき', '負の画素 / 見える', 'R(s)', 'R(s) 偏り', 'R(s) 分散'], summary),
    '', '## 撮影ごとの S(幅 + 超過)', '', ...table(['候補', ...measured], perShot),
    '', '## 帯ごとの超過(調整用の平均)', '', ...table(['候補', ...BAND_SCALES.map((s) => `${s} px`), '残り'], perBand),
    '', '## 解析値のある窓の比(拡散照度。bay は P_in / P_out、bounce-cosine は余弦 1 / 0.5 / 0)', '',
    ...table(['撮影', '解析値', '基準', ...candidates.map((c) => c.label)], ratios),
    '',
  ].join('\n');
}

// ---- 刺激と t ----

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

// 刺激の基準の段(全解像度・均しなし・1 パス 4 スライス × 片側 32 歩)とパス数。
const STIMULUS_REFERENCE_TIER = { scale: 1, sliceCount: 4, stepCount: 32, denoiseRadius: 0 };
const STIMULUS_REFERENCE_PASSES = 256;
// t を読む分位。
const THRESHOLD_QUANTILE = 0.99;
// 刺激の目視の判定: 3 撮影とも採用可能とされた倍率と、不可とされた倍率。不可の値は t のこの倍以上あるべき。
const ACCEPTED_SCALE = 1 / 8;
const REJECTED_SCALE = 1 / 2;
const REJECTED_MARGIN = 2;

async function threshold({ options }) {
  const name = options.name ?? `${headHash()}-threshold`;
  const entries = ENTRIES.filter((e) => STIMULUS_SHOTS.includes(e.key));
  // 基準と候補は同じセッションで撮る(セッションが違うと 1 パスの値が違う)。
  if (entries.some((e) => referenceMetaOf(name, e) !== null)) {
    throw new Error(`reference ${name} already exists; give a new --name to build B and the candidates in one session`);
  }
  const outDir = path.join(shotsDir, 'ssd-compare', name);
  const { references, diffuse } = await withLab(async (lab) => {
    for (const entry of entries) {
      await extendReference(lab, name, entry, STIMULUS_REFERENCE_TIER, STIMULUS_REFERENCE_PASSES);
    }
    const built = loadReference(name, entries);
    return { references: built, diffuse: await captureCandidates(lab, outDir, entries, QUALITY_CANDIDATES, built) };
  });
  const record = {
    reference: name, entries: entries.map((e) => e.key), candidates: QUALITY_CANDIDATES,
    costs: QUALITY_CANDIDATES.map(() => null), diffuse,
  };
  writeFileSync(recordPathOf(outDir), JSON.stringify(record));
  // 中(均し後、1 つ目の seed)の誤差を倍率ごとに縮めたときの、はみ出しの分位。
  const medium = QUALITY_CANDIDATES.find((c) => c.label === 'medium');
  const margins = Object.fromEntries(entries.map((entry) => {
    const { exposedCorrection, meta, radius } = references[entry.key];
    const q = exposedCorrectionOf(readHalfFloats(correctionPathOf(outDir, entry, medium.label, 0)), meta.exposure);
    const error = q.map((plane, c) => plane.map((v, p) => v - exposedCorrection[c][p]));
    return [entry.key, STIMULUS_SCALES.map((a) => marginQuantileOf(error.map((plane) => plane.map((v) => a * v)),
      maskOf(radius), WIDTH, HEIGHT, THRESHOLD_QUANTILE))];
  }));
  const marginOf = (key, a) => margins[key][STIMULUS_SCALES.indexOf(a)];
  const t = Math.min(...entries.map((e) => marginOf(e.key, ACCEPTED_SCALE)));
  const scaleLabel = (a) => (a === 1 ? '1' : `1/${1 / a}`);
  const rows = entries.map((e) => [
    e.key, ...STIMULUS_SCALES.map((a) => fixed(marginOf(e.key, a), 6)),
    marginOf(e.key, REJECTED_SCALE) >= REJECTED_MARGIN * t ? '合' : '否',
  ]);
  const { byT, flicker } = scoreSaved(outDir, record, references, [t], outDir);
  const report = [
    `## t(中の均し後の誤差を a 倍したときの |d_s| − 3u_s の ${100 * THRESHOLD_QUANTILE} 百分位)`, '',
    ...table(['撮影', ...STIMULUS_SCALES.map((a) => `a = ${scaleLabel(a)}`),
      `a = ${scaleLabel(REJECTED_SCALE)} ≧ ${REJECTED_MARGIN}t`], rows),
    '', `t = ${t.toPrecision(4)}(a = ${scaleLabel(ACCEPTED_SCALE)} の撮影どうしの最小)`, '',
    reportOf(record, byT[0], flicker),
  ].join('\n');
  writeFileSync(path.join(outDir, 'report.md'), report);
  console.log(`\n${report}`);
}

const COMMANDS = { reference, check, compare, rescore, stimuli, threshold };

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!Object.hasOwn(COMMANDS, command)) {
    throw new Error('usage: node tools/render-lab-screen-space-metrics.mjs reference|check|compare|rescore|stimuli|threshold [...]');
  }
  await COMMANDS[command](parseArgs(rest));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
