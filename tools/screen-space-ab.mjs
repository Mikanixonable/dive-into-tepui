// 近傍拡散補正の、前後の 2 つの形を同じページに載せて比べる道具。段は <TIERS の名前>[:<variant>](例 medium:1。variant は
// ScanTier に variant がある、一時の切り替えを当てた作業ツリーでだけ書ける)。表と記録と画像を .render-lab-shots/ssd-opt/<名前>/ へ書く。
//
//   identity <前の段> <後の段> [--entries <key,...>] [--targets <名前,...>] [--white-noise <パス>] [--seeds <K>] --out <名前>
//     撮影ごとに、方式をオフにして 1 フレーム描いて近傍拡散補正の全描画先を空にしてから、前 → 後の順に、続けて 2 回同じ
//     読み戻しになるまで描き直して中間の読み戻しを比べる。--seeds K では、seedOf(0〜K − 1) のシードごとに前 → 後の順に描いた
//     対の差の統計(多シードの比べ方)を出す。
//   cost <前の段> <後の段> [--entry bay] [--rounds 5] --out <名前>
//     両方の形を 1 度描いてシェーダを組んでから、同じページで交互に測った GPU の行の巡ごとの対の比を出す。
//   wgsl <段> --out <名前>
//     bay で、段の近傍拡散補正の描画命令ごとのフラグメントシェーダを <名前>/<段>/<行>.wgsl へ書く。
//
// 先に .render-lab/ を組んでおくこと(webpack --config webpack.render-lab.config.js --mode production)。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { encodeRgbPng } from './png.mjs';
import {
  DIFFERENCE_GAIN, entryOfKey, fixed, HEIGHT, headHash, packedBandsNamesOf, seedOf, shotsDir, signedColorOf,
  signedGainOf, table, TIERS, WIDTH, withLab,
} from './screen-space-lab.mjs';
import { scanMaskOf, scanPngOf } from './screen-space-scan.mjs';

const USAGE = 'usage: node tools/screen-space-ab.mjs identity|cost|wgsl <段> ... --out <名前>(書き方はこのファイルの先頭)';
const OUT_ROOT = path.join(shotsDir, 'ssd-opt');
// 段の variant を読む一時の切り替えが入るファイル。
const SCAN_TIER_SOURCE = path.resolve(import.meta.dirname, '../src/render/pipeline/screen-space/screen-space-pass.ts');

// 絵を比べる撮影(identity)と、多シードで比べる撮影(identity --seeds)、費用を測る撮影の key。
const IDENTITY_ENTRIES = [
  'clutter', 'cornell-box', 'bay-earth-open', 'slope-fan', 'groove-ladder-near', 'bay-earth-open@occlusion',
];
const SEED_ENTRIES = ['clutter', 'cornell-box', 'bay-earth-open'];
const COST_ENTRY = 'bay';
const COST_ROUNDS = 5;
// 多シードで読み戻す中間ターゲット。
const SEED_TARGETS = ['band-sum', 'correction'];

// 外れとする差 [刻み]。
const OUTLIER_STEPS = 4;
// 多シードで、d̄ の RMS の比を取る先頭のシードの数と、偏りとして数える z の大きさ、z の地図の端の z。
const EARLY_SEEDS = 16;
// 積む前に前 → 後を描いて捨てる暖機のシード数(積むシードの後ろの seedOf から取る)。ドライバの組み方の切り替えを積む前に起こす。
const WARMUP_SEEDS = 32;
const LARGE_Z = 3;
const Z_MAP_LIMIT = 4;

// 費用の行: 近傍拡散補正の行(GPU_PASS_LABELS の名前で選ぶ)とその和、対照のマテリアルの行。
const NEARBY_ROW_PATTERN = /^近傍拡散/;
const SUM_ROW = '近傍拡散の和';
const MATERIAL_ROW = 'マテリアル';

// ---- 段 ----

// 作業ツリーの ScanTier が variant を持つか(一時の切り替えが当たっているか)。
const hasVariant = () => /readonly variant\?:/.test(readFileSync(SCAN_TIER_SOURCE, 'utf8'));

// 段の書き方 spec の { label, tier }。variant を書いた段は、ScanTier に variant が無ければ投げる — 無視されて前後が同じ描画命令に
// なるのを防ぐ。
function stageOf(spec) {
  const [name, variant] = spec.split(':');
  if (!Object.hasOwn(TIERS, name)) throw new Error(`unknown tier ${name}: one of ${Object.keys(TIERS).join(', ')}`);
  if (variant === undefined) return { label: spec, tier: TIERS[name] };
  if (variant !== '0' && variant !== '1') throw new Error(`${spec}: the variant is 0 or 1`);
  if (!hasVariant()) {
    throw new Error(`${spec}: ScanTier has no variant — apply the temporary switch patch and rebuild the render lab`);
  }
  return { label: spec, tier: { ...TIERS[name], variant: Number(variant) } };
}

// 前後の段の書き方 specs の { before, after }。帯の数の違う段は、読み戻しの並びが揃わないので投げる。
function stagePairOf(specs) {
  if (specs.length !== 2) throw new Error(USAGE);
  const [before, after] = specs.map(stageOf);
  if (before.tier.bandCount !== after.tier.bandCount) throw new Error(`${before.label} and ${after.label} split unlike bands`);
  return { before, after };
}

// 帯の数 bandCount の段の、読み戻しの名前の実行順の並び: 照り返しの源・走査の帯・代表・帯の縮小・合流・最後の拡大。
function targetsOf(bandCount) {
  const levels = Array.from({ length: bandCount - 1 }, (_, i) => i + 1);
  return [
    'surface-radiance', ...packedBandsNamesOf(bandCount),
    ...levels.map((level) => `representative-${level}`),
    ...levels.flatMap((level) => Array.from(
      { length: Math.ceil(3 * (bandCount - level) / 4) }, (_, i) => `reduced-${level}-${i}`)),
    ...levels.map((level) => `merged-${level - 1}`),
    'correction',
  ];
}

// 出力先 name の置き場を作って返す。
function outDirOf(name) {
  if (name === undefined) throw new Error(`--out is required\n${USAGE}`);
  const dir = path.join(OUT_ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// 段 tier を、近傍拡散補正の全描画先を空にしてから描き、中間ターゲット names の落ち着いた読み戻しを返す(readSettled)。
async function drawSettled(lab, tier, names) {
  await lab.setTier(tier);
  await lab.clearScreenSpace();
  return lab.readSettled(names);
}

// 記録 record を dir の record.json へ、表 report を report.md へ書き、表を出す。
function writeRecord(dir, record, report) {
  writeFileSync(path.join(dir, 'record.json'), JSON.stringify(record, null, 1));
  writeFileSync(path.join(dir, 'report.md'), report);
  console.log(`\n${report}`);
}

// ---- 比べ方 ----

// 単精度の描画先から読む読み戻し(代表と、面の写しの座標・深度)。ほかは半精度。
const SINGLE_PRECISION_TARGET = /^(?:representative-|scan-surface-0$)/;

// 単精度の値 v の 2 進の指数 ⌊log₂|v|⌋(0 と非正規化数は −127)。
const floatOfBits = new Float32Array(1);
const bitsOfFloat = new Uint32Array(floatOfBits.buffer);
function exponentOf(v) {
  floatOfBits[0] = v;
  return ((bitsOfFloat[0] >>> 23) & 0xff) - 127;
}
// 前の値 v の刻み — 半精度は 2^(⌊log₂ max(|v|, 2⁻¹⁴)⌋ − 10)、単精度(single)は 2^(⌊log₂ max(|v|, 2⁻¹²⁶)⌋ − 23)。
const stepOf = (v, single) => 2 ** (single ? Math.max(exponentOf(v), -126) - 23 : Math.max(exponentOf(v), -14) - 10);

// 印 marked(Uint8Array、width × height)の立った画素の 4 連結の塊の { count, largest }(数と最大の大きさ [画素])。
function clustersOf(marked, width, height) {
  const seen = new Uint8Array(marked.length);
  const stack = new Int32Array(marked.length);
  let [count, largest] = [0, 0];
  for (let start = 0; start < marked.length; start++) {
    if (!marked[start] || seen[start]) continue;
    let [top, size] = [0, 0];
    stack[top++] = start;
    seen[start] = 1;
    while (top > 0) {
      const p = stack[--top];
      size++;
      const [x, y] = [p % width, Math.floor(p / width)];
      const neighbors = [[x > 0, p - 1], [x < width - 1, p + 1], [y > 0, p - width], [y < height - 1, p + width]];
      for (const [inside, q] of neighbors) {
        if (inside && marked[q] && !seen[q]) {
          seen[q] = 1;
          stack[top++] = q;
        }
      }
    }
    count++;
    largest = Math.max(largest, size);
  }
  return { count, largest };
}

// 前後の読み戻し before・after({ width, height, rgba })の成分ごとの差。single なら単精度の刻みで数える。返り値は
// { differing, maxSteps, outliers, clusters, largestCluster, map } — differing はビットの違う成分の数、maxSteps は最大の差
// [刻み]、outliers は外れの画素の数、clusters と largestCluster は外れの塊の数と最大の大きさ、map は差のある読み戻しの
// 差の地図の PNG(差が無ければ null)。
function differenceOf(before, after, single) {
  const { width, height } = before;
  const [beforeBits, afterBits] = [before, after].map(({ rgba }) => new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length));
  // 画素ごとの、ビットが違うかと、成分の差の最大 [刻み]。
  const differs = new Uint8Array(width * height);
  const steps = new Float64Array(width * height);
  let [differing, maxSteps] = [0, 0];
  for (let i = 0; i < beforeBits.length; i++) {
    if (beforeBits[i] === afterBits[i]) continue;
    const p = i >> 2;
    const delta = Math.abs(after.rgba[i] - before.rgba[i]) / stepOf(before.rgba[i], single);
    const s = Number.isNaN(delta) ? Infinity : delta;
    differing++;
    differs[p] = 1;
    steps[p] = Math.max(steps[p], s);
    maxSteps = Math.max(maxSteps, s);
  }
  const outlying = Uint8Array.from(steps, (s) => (s > OUTLIER_STEPS ? 1 : 0));
  const { count, largest } = clustersOf(outlying, width, height);
  return {
    differing, maxSteps, outliers: outlying.reduce((sum, v) => sum + v, 0), clusters: count, largestCluster: largest,
    map: differing === 0 ? null : differenceMapOf(width, height, differs, steps),
  };
}

// 差の地図の色: 差の無い画素は黒、4 刻み以下は青(明るいほど大きい)、外れは log₂ の刻みで 4 刻みの赤から 2²⁰ 刻みの黄へ。
function differenceMapOf(width, height, differs, steps) {
  const codes = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    if (!differs[p]) continue;
    const s = steps[p];
    const color = s <= OUTLIER_STEPS
      ? [0.15, 0.3, 0.4 + 0.15 * s] : [1, Math.min(1, Math.log2(s / OUTLIER_STEPS) / 18), 0];
    for (let c = 0; c < 3; c++) codes[3 * p + c] = Math.round(255 * color[c]);
  }
  return encodeRgbPng(width, height, codes);
}

// ---- identity ----

// 前後の段 specs の中間の読み戻しを撮影ごとに比べ(--seeds があれば多シードで比べ)、表と画像を書く。
async function identity(specs, options) {
  const { before, after } = stagePairOf(specs);
  const dir = outDirOf(options.out);
  if (options.seeds !== undefined) {
    await identityOverSeeds(dir, before, after, options);
    return;
  }
  const entries = (options.entries?.split(',') ?? IDENTITY_ENTRIES).map(entryOfKey);
  const targets = options.targets?.split(',') ?? targetsOf(before.tier.bandCount);
  const whiteNoisePass = options['white-noise'] === undefined ? null : Number(options['white-noise']);
  const shots = await withLab(async (lab) => {
    const measured = {};
    for (const entry of entries) {
      await lab.show(entry);
      await lab.setSeed(seedOf(0));
      await lab.setWhiteNoisePass(whiteNoisePass);
      const drawn = [];
      for (const { tier } of [before, after]) drawn.push(await drawSettled(lab, tier, targets));
      const compared = {};
      for (const [i, name] of targets.entries()) {
        const { map, ...difference } = differenceOf(
          drawn[0].images[i], drawn[1].images[i], SINGLE_PRECISION_TARGET.test(name));
        const { width, height } = drawn[0].images[i];
        compared[name] = { width, height, single: SINGLE_PRECISION_TARGET.test(name), ...difference };
        if (map !== null) writeFileSync(path.join(dir, `${entry.key}.${name}.diff.png`), map);
      }
      measured[entry.key] = { renders: drawn.map(({ renders }) => renders), targets: compared };
      console.log(`${entry.key}: ${Object.values(compared).filter((t) => t.differing > 0).length} / ${targets.length} differ`);
    }
    return measured;
  });
  const record = {
    head: headHash(), before: before.label, after: after.label, whiteNoisePass, targets,
    entries: entries.map((e) => e.key), shots,
  };
  writeRecord(dir, record, identityReportOf(record));
}

// identity の記録 record の表。
function identityReportOf({ head, before, after, whiteNoisePass, targets, entries, shots }) {
  const all = entries.flatMap((key) => targets.map((name) => shots[key].targets[name]));
  const differing = all.filter((t) => t.differing > 0).length;
  const outlying = all.filter((t) => t.outliers > 0).length;
  const perShot = entries.flatMap((key) => {
    const { renders, targets: compared } = shots[key];
    return [
      '', `### ${key}(描いた回数 前 ${renders[0]}・後 ${renders[1]})`, '',
      ...table(['読み戻し', '寸法', '精度', '差のある成分', '最大の差 [刻み]', '外れの画素', '外れの塊', '最大の塊 [画素]'],
        targets.map((name) => {
          const t = compared[name];
          return [
            name, `${t.width}×${t.height}`, t.single ? '単' : '半', t.differing, fixed(t.maxSteps, 2), t.outliers,
            t.clusters, t.largestCluster,
          ];
        })),
    ];
  });
  return [
    '# 近傍拡散補正の前後の中間の読み戻しの差', '',
    `HEAD ${head}。前 = ${before}、後 = ${after}。seedOf(0)、`
      + `${whiteNoisePass === null ? 'ブルーノイズ' : `ホワイトノイズのパス ${whiteNoisePass}`}。`,
    '撮影ごとに、方式をオフにして 1 フレーム描いて近傍拡散補正の全描画先を空にしてから、前 → 後の順に、続けて 2 回同じ読み戻しに',
    'なるまで描き直して(上限 6 回)読み戻した。差は成分ごとに前の値の刻み(半精度は 2^(⌊log₂ max(|v|, 2⁻¹⁴)⌋ − 10)、単精度は',
    `2^(⌊log₂ max(|v|, 2⁻¹²⁶)⌋ − 23))で数える。外れは ${OUTLIER_STEPS} 刻みを超える成分を持つ画素、塊は外れの 4 連結の塊。`,
    '', '## まとめ', '',
    `差のある読み戻し ${differing} / ${all.length}(撮影 × 読み戻し)、外れのある読み戻し ${outlying}。`,
    '', '## 撮影ごと', ...perShot,
    '', '## 保存したもの', '',
    `- \`<撮影>.<読み戻し>.diff.png\` — 差のある読み戻しの、画素ごとの成分の差の最大の地図(読み戻しの寸法)。黒は差なし、`,
    `  青は ${OUTLIER_STEPS} 刻み以下(明るいほど大きい)、赤〜黄は外れ(log₂ の刻みで ${OUTLIER_STEPS} 刻みが赤、2²⁰ 刻み以上が黄)。`,
    '',
  ].join('\n');
}

// ---- identity --seeds ----

// 撮影ごとに、seedOf(0〜K − 1) のシードごとに前 → 後の順に描いた対の差を積み、統計と画像を dir へ書く。
async function identityOverSeeds(dir, before, after, options) {
  const seedCount = Number(options.seeds);
  if (!Number.isInteger(seedCount) || seedCount < 2) throw new Error('--seeds must be an integer of at least 2');
  if (options['white-noise'] !== undefined) throw new Error('--seeds compares blue-noise seeds; drop --white-noise');
  const entries = (options.entries?.split(',') ?? SEED_ENTRIES).map(entryOfKey);
  const names = options.targets?.split(',') ?? SEED_TARGETS;
  const shots = await withLab(async (lab) => {
    const measured = {};
    for (const entry of entries) {
      await lab.show(entry);
      await lab.setSeed(seedOf(0));
      const radius = await lab.readFloat('projected-radius', 1);
      const exposure = await lab.exposureFactor();
      // 両方の形を、空にした描画先から落ち着くまで描き、暖機してから積む。
      for (const { tier } of [before, after]) await drawSettled(lab, tier, names);
      for (let k = 0; k < WARMUP_SEEDS; k++) {
        await lab.accumulatePairDifference(names, seedOf(seedCount + k), before.tier, after.tier, EARLY_SEEDS);
      }
      await lab.discardPairDifferences(names);
      for (let k = 0; k < seedCount; k++) {
        await lab.accumulatePairDifference(names, seedOf(k), before.tier, after.tier, EARLY_SEEDS);
      }
      measured[entry.key] = {};
      for (const name of names) {
        const pair = await lab.takePairDifferences(name);
        const mask = scanMaskOf(radius, before.tier.scale, pair.width, pair.height);
        const { z, ...statistics } = seedStatisticsOf(pair, mask);
        measured[entry.key][name] = {
          width: pair.width, height: pair.height, differingPerSeed: pair.differing, ...statistics,
        };
        writeFileSync(path.join(dir, `${entry.key}.${name}.z.png`), scanPngOf(pair.width, pair.height, mask,
          (p) => [0, 1, 2].map((c) => 0.5 + Math.max(-Z_MAP_LIMIT, Math.min(Z_MAP_LIMIT, z[3 * p + c])) / (2 * Z_MAP_LIMIT))));
        writeFileSync(path.join(dir, `${entry.key}.${name}.pair.png`), pairPngOf(pair, mask, exposure));
      }
      console.log(`${entry.key}: ${names.map((name) => `${name} ${measured[entry.key][name].differing} differ`).join(', ')}`);
    }
    return measured;
  });
  const record = {
    head: headHash(), before: before.label, after: after.label, seeds: seedCount, names,
    entries: entries.map((e) => e.key), shots,
  };
  writeRecord(dir, record, seedReportOf(record));
}

// 積んだ対の差 pair(takePairDifferences)の、印 mask の立った画素の rgb で数えた統計 { measured, differing, constantShift,
// largeZFraction, rms, earlyRmsRatio, z }。differing は全画素で 1 度でも差のあった成分の数、constantShift は SE = 0 で d̄ ≠ 0 の
// 成分の数、largeZFraction は |z| > LARGE_Z の成分の割合、rms は d̄ の RMS、earlyRmsRatio は先頭 EARLY_SEEDS シードの d̄ の RMS
// との比(控えが無いか rms = 0 なら null)、z は画素ごとに rgb の z(SE = 0 では d̄ の符号の ∞ か 0)。
function seedStatisticsOf({ count, sum, squareSum, early }, mask) {
  const z = new Float64Array(sum.length);
  let [measured, differing, constantShift, largeZ, squareMean, earlySquareMean] = [0, 0, 0, 0, 0, 0];
  for (let i = 0; i < sum.length; i++) {
    if (squareSum[i] > 0) differing++;
    const mean = sum[i] / count;
    const se = Math.sqrt(Math.max(0, squareSum[i] / count - mean * mean) / (count - 1));
    z[i] = se > 0 ? mean / se : Math.sign(mean) * (mean === 0 ? 0 : Infinity);
    if (!mask[Math.floor(i / 3)]) continue;
    measured++;
    if (se === 0 && mean !== 0) constantShift++;
    if (Math.abs(z[i]) > LARGE_Z) largeZ++;
    squareMean += mean * mean;
    if (early !== null) earlySquareMean += (early[i] / EARLY_SEEDS) ** 2;
  }
  const rms = Math.sqrt(squareMean / measured);
  return {
    measured, differing, constantShift, largeZFraction: largeZ / measured, rms,
    earlyRmsRatio: early === null || rms === 0 ? null : Math.sqrt(earlySquareMean / measured) / rms, z,
  };
}

// 最初のシードの前・後の q = 露出係数 exposure·ΔE/π と、その差を左から並べた PNG(各面を絵の寸法へ最近傍で広げる)。前後は
// 0.5 + g·q(g は前の印 mask の中の q から signedGainOf で決める)、差は 0.5 + DIFFERENCE_GAIN·(q後 − q前)。
function pairPngOf({ width, height, first }, mask, exposure) {
  const [before, after] = [first.before, first.after].map((rgba) => Float32Array.from(
    { length: width * height * 3 }, (_, i) => exposure / Math.PI * rgba[4 * Math.floor(i / 3) + i % 3]));
  const gain = signedGainOf([{ values: before, mask }]);
  const difference = after.map((v, i) => v - before[i]);
  const panels = [signedColorOf(before, gain), signedColorOf(after, gain), signedColorOf(difference, DIFFERENCE_GAIN)];
  const codes = new Uint8Array(panels.length * WIDTH * HEIGHT * 3);
  for (const [k, colorOf] of panels.entries()) {
    for (let y = 0; y < HEIGHT; y++) {
      for (let x = 0; x < WIDTH; x++) {
        const color = colorOf(Math.floor(y * height / HEIGHT) * width + Math.floor(x * width / WIDTH));
        const at = ((y * panels.length + k) * WIDTH + x) * 3;
        for (let c = 0; c < 3; c++) codes[at + c] = Math.round(255 * Math.min(1, Math.max(0, color[c])));
      }
    }
  }
  return encodeRgbPng(panels.length * WIDTH, HEIGHT, codes);
}

// 数の並び counts を EARLY_SEEDS ごとに区切った平均の並び。
function blockMeansOf(counts) {
  return Array.from({ length: Math.ceil(counts.length / EARLY_SEEDS) }, (_, b) => {
    const block = counts.slice(b * EARLY_SEEDS, (b + 1) * EARLY_SEEDS);
    return block.reduce((sum, n) => sum + n, 0) / block.length;
  });
}

// identity --seeds の記録 record の表。
function seedReportOf({ head, before, after, seeds, names, entries, shots }) {
  const rows = entries.flatMap((key) => names.map((name) => {
    const s = shots[key][name];
    return [
      key, name, s.measured, s.differing, s.constantShift, fixed(s.largeZFraction, 4), fixed(s.earlyRmsRatio, 3),
      s.rms.toExponential(3),
    ];
  }));
  return [
    '# 近傍拡散補正の前後の多シードの対の差', '',
    `HEAD ${head}。前 = ${before}、後 = ${after}。seedOf(0〜${seeds - 1}) のシードごとに前 → 後の順に描き、対の差`,
    'd_k = 後 − 前 を画素・成分ごとに倍精度で積んだ。d̄ = Σd/K、SE = √((Σd²/K − d̄²)/(K − 1))、z = d̄/SE。測る成分は補正を',
    '受ける画素(近傍の半径が 2 走査画素を超える面)の rgb。差のある成分は全画素で 1 度でも d ≠ 0 だった成分。',
    '', ...table([
      '撮影', '読み戻し', '測る成分', '差のある成分', 'SE = 0 で d̄ ≠ 0', `z の絶対値 > ${LARGE_Z} の割合`,
      `RMS(d̄ の先頭 ${EARLY_SEEDS}) / RMS(d̄)`, 'RMS(d̄)',
    ], rows),
    '', '## ドライバの組み方の切り替え', '',
    `暖機 ${WARMUP_SEEDS} シード + 積んだ ${seeds} シードを ${EARLY_SEEDS} シードずつ区切った、全画素の差のある成分の数の平均(左が暖機の先頭)。`,
    '数が区切りで定常でなければ、ドライバの組み方が切り替わっている。シードごとの数は record.json の differingPerSeed。',
    '', ...table(['撮影', '読み戻し', '区切りごとの平均'], entries.flatMap((key) => names.map((name) => [
      key, name, blockMeansOf(shots[key][name].differingPerSeed).map((mean) => fixed(mean, 1)).join(' / '),
    ]))),
    '', '## 保存したもの', '',
    `- \`<撮影>.<読み戻し>.z.png\` — z を成分ごとに 0.5 + z/${2 * Z_MAP_LIMIT} で [0, 1] へ切った色(±${Z_MAP_LIMIT} で端)を、`,
    '  絵の寸法へ最近傍で広げたもの。測らない画素は濃い青。',
    '- `<撮影>.<読み戻し>.pair.png` — seedOf(0) の前・後の q = 露出係数·ΔE/π と差を左から並べたもの。前後は 0.5 + g·q(g は',
    `  前の測る画素の |q| の 99.5 パーセンタイル p で g·p ≤ 0.45 を満たす最大の 2 の冪)、差は 0.5 + ${DIFFERENCE_GAIN}·(q後 − q前)。`,
    '',
  ].join('\n');
}

// ---- cost ----

// 前後の段 specs の GPU の行を同じページで交互に測り、巡ごとの対の比の表を書く。
async function cost(specs, options) {
  const { before, after } = stagePairOf(specs);
  const dir = outDirOf(options.out);
  const entry = entryOfKey(options.entry ?? COST_ENTRY);
  const rounds = Number(options.rounds ?? COST_ROUNDS);
  const measured = await withLab(async (lab) => {
    await lab.show(entry);
    // 測る前に両方の形を描いて、シェーダを組み終える。
    for (const { tier } of [before, after]) {
      await lab.setTier(tier);
      await lab.readSettled(['scan-correction']);
    }
    return lab.measureTierRounds([before.tier, after.tier], rounds);
  });
  if (measured === null) throw new Error('GPU timing is not supported in this session');
  const record = {
    head: headHash(), before: before.label, after: after.label, entry: entry.key, rounds,
    measured: { before: measured[0], after: measured[1] }, rows: costRowsOf(measured),
  };
  writeRecord(dir, record, costReportOf(record));
}

// 値の並び values の中央値。
function medianOf(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// 前後の巡ごとの行 [befores, afters]([巡] の GPU の行の名前から p50 [ms] への表)の、費用の行ごとの
// { label, before, after, ratio, ratioRange, ofMaterial }。before・after は巡の中央値 [ms]、ratio は巡ごとの対の比 後 / 前 の
// 中央値、ratioRange はその [最小, 最大]、ofMaterial は前のマテリアルの行に対する比。近傍拡散補正の行は、どちらかで時間の
// あった行。
function costRowsOf([befores, afters]) {
  const labels = Object.keys(befores[0]).filter((label) => NEARBY_ROW_PATTERN.test(label)
    && [...befores, ...afters].some((row) => row[label] > 0));
  const withSum = (row) => ({ ...row, [SUM_ROW]: labels.reduce((sum, label) => sum + row[label], 0) });
  const [summedBefores, summedAfters] = [befores, afters].map((rows) => rows.map(withSum));
  const material = medianOf(summedBefores.map((row) => row[MATERIAL_ROW]));
  return [...labels, SUM_ROW, MATERIAL_ROW].map((label) => {
    const ratios = summedBefores.map((row, k) => summedAfters[k][label] / row[label]);
    const beforeMs = medianOf(summedBefores.map((row) => row[label]));
    return {
      label, before: beforeMs, after: medianOf(summedAfters.map((row) => row[label])),
      ratio: medianOf(ratios), ratioRange: [Math.min(...ratios), Math.max(...ratios)], ofMaterial: beforeMs / material,
    };
  });
}

// cost の記録 record の表。
function costReportOf({ head, before, after, entry, rounds, rows }) {
  const sum = rows.find((row) => row.label === SUM_ROW);
  const effect = (1 - sum.ratio) * sum.before;
  return [
    '# 近傍拡散補正の前後の費用', '',
    `HEAD ${head}。前 = ${before}、後 = ${after}。${entry}、${rounds} 巡(巡ごとに測る順を入れ替え、1 回は暖機 6 フレーム +`,
    '30 フレームの p50)。前・後は巡の中央値、r̃ は巡ごとの対の比 r_k = 後 / 前 の中央値。',
    '', ...table(['行', '前 [ms]', '後 [ms]', 'r̃', 'r の最小〜最大', '前 / マテリアル'], rows.map((row) => [
      row.label, fixed(row.before, 3), fixed(row.after, 3), fixed(row.ratio, 4),
      `${fixed(row.ratioRange[0], 4)}〜${fixed(row.ratioRange[1], 4)}`, fixed(row.ofMaterial, 3),
    ])),
    '', `効き E = (1 − r̃_和)·T = ${fixed(effect, 3)} ms(T = 前の和 ${fixed(sum.before, 3)} ms。正が速い)。`,
    '',
  ].join('\n');
}

// ---- wgsl ----

// 段 specs[0] の近傍拡散補正の描画命令ごとのフラグメントシェーダを書く。
async function wgsl(specs, options) {
  if (specs.length !== 1) throw new Error(USAGE);
  const stage = stageOf(specs[0]);
  // 段の書き方の : は Windows のファイル名に使えないので、置き場では -v にする。
  const dir = path.join(outDirOf(options.out), stage.label.replace(':', '-v'));
  mkdirSync(dir, { recursive: true });
  const shaders = await withLab(async (lab) => {
    await lab.show(entryOfKey(COST_ENTRY));
    await lab.setTier(stage.tier);
    await lab.readSettled(['scan-correction']);
    return lab.screenSpaceShaders();
  });
  // 同じ行の描画命令が複数あれば、行の名前に実行順の番号 -1, -2, … を付ける。
  const repeated = (label) => shaders.filter((s) => s.label === label).length > 1;
  const seen = {};
  for (const { label, wgsl: code } of shaders) {
    const name = repeated(label) ? `${label}-${(seen[label] = (seen[label] ?? 0) + 1)}` : label;
    writeFileSync(path.join(dir, `${name}.wgsl`), code);
    console.log(`${name}.wgsl: ${code.split('\n').length} lines`);
  }
}

const COMMANDS = { identity, cost, wgsl };

// 引数の命令を走らせる。
async function main() {
  const { positionals: [command, ...specs], values: options } = parseArgs({
    allowPositionals: true,
    options: Object.fromEntries(['entries', 'targets', 'white-noise', 'seeds', 'entry', 'rounds', 'out']
      .map((name) => [name, { type: 'string' }])),
  });
  if (!Object.hasOwn(COMMANDS, command ?? '')) throw new Error(USAGE);
  await COMMANDS[command](specs, options);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
