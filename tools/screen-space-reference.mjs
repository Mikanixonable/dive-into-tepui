// 近傍拡散補正の基準 B の生成と、その収束の判定。B は全解像度・均しなしの段で、パスごとにブルーノイズの seed を
// 変えて撮った表示(と、解析値と照らす撮影では拡散照度)を、偶数番目と奇数番目のパスに分けて積んだもの。半分どうしの
// 差で B に残る雑音を、歩数を倍にした B₂ との差で歩数による偏りを、いまの中設定(均しなし)の誤差と比べて判定する。
import { mkdirSync, writeFileSync } from 'node:fs';
import { errorMetrics, oklabOf } from './screen-space-error.mjs';
import {
  analyticRatiosOf, captureLinear, ENTRIES, fixed, HEIGHT, headHash, linearOfPng, loadHalves, loadReference, maskOf,
  readFloats, referenceDirOf, referenceFileOf, referenceMetaOf, referenceSumsOf, seedOf, table, TIERS, WIDTH,
  windowRatiosOf, withLab, writeFloats, writeReferencePasses,
} from './screen-space-lab.mjs';

const REFERENCE_USAGE = 'usage: reference [--name <名前>] [--entries <key,...>] [--sets <set,...>] --slices <S> --steps <T> --passes <N>';
const CHECK_USAGE = 'usage: check <名前> [<歩数を倍にした名前>] [--entries <key,...>]';
// 1 パスのスライス × 片側の歩数の上限。全解像度の 1 フレームが GPU の打ち切り(Windows の TDR は既定 2 秒)に
// 掛からない大きさ。
const MAX_PASS_SAMPLES = 256;
// 収束の条件: 半分どうしの差と、歩数を倍にした B₂ との差の G が、いまの中設定(均しなし)の G のこの割合以下で、
// 半分どうしの差の R(s) がどの帯も、最も細かい帯の R(1) のこの倍以下。
const CONVERGED_G_RATIO = 1 / 10;
const CONVERGED_R_RATIO = 1.5;

// 評価の組のうち、--entries(撮影の key)と --sets(set)の両方に当たるもの。省いた方は絞らない。
function selectedEntries(options) {
  const keys = options.entries?.split(',');
  const sets = options.sets?.split(',');
  const selected = ENTRIES.filter((e) => (keys?.includes(e.key) ?? true) && (sets?.includes(e.set) ?? true));
  if (selected.length === 0) throw new Error(`no entries match --entries ${options.entries} --sets ${options.sets}`);
  return selected;
}

// 基準の組 name の撮影 entry の、偶数番目と奇数番目のパスの表示の平均どうしの誤差の指標(粒は全解像度)。
function halvesNoiseOf(name, entry) {
  const { even, odd } = loadHalves(name, entry);
  const mask = maskOf(readFloats(referenceFileOf(name, entry, 'radius.f32')));
  return errorMetrics(oklabOf(even), oklabOf(odd), mask, WIDTH, HEIGHT, 0, 1);
}

// ---- 生成 ----

// 基準の組を作るか、保存済みの和へパスを続きから足す。
export async function reference({ options }) {
  const [slices, steps, passes] = ['slices', 'steps', 'passes'].map((key) => Number(options[key]));
  if (![slices, steps, passes].every((v) => Number.isInteger(v) && v > 0)) throw new Error(REFERENCE_USAGE);
  if (slices * steps > MAX_PASS_SAMPLES) {
    throw new Error(`slices × steps = ${slices * steps} exceeds ${MAX_PASS_SAMPLES} per pass (GPU timeout budget)`);
  }
  const tier = { scale: 1, sliceCount: slices, stepCount: steps, denoiseRadius: 0 };
  const name = options.name ?? headHash();
  const entries = selectedEntries(options);
  mkdirSync(referenceDirOf(name), { recursive: true });
  await withLab(async (lab) => {
    for (const entry of entries) await extendReference(lab, name, entry, tier, passes);
  });
  // 表: 近傍の半径の網羅、解析値のある窓の比、半分どうしの差の G。
  console.log(`\n基準 ${referenceDirOf(name)}: ${slices} スライス × 片側 ${steps} 歩、${passes} パス`);
  printCoverage(name, entries);
  const correctness = entries.filter((e) => e.set === 'correctness');
  if (correctness.length > 0) {
    const format = (values) => values.map((v) => fixed(v, 3)).join(' / ');
    const references = loadReference(name, correctness);
    const ratios = correctness.map((e) => [
      e.key, format(analyticRatiosOf(e.key)), format(windowRatiosOf(e, references[e.key].diffuse)),
    ]);
    console.log(['', ...table(['撮影', '解析値', '基準'], ratios)].join('\n'));
  }
  const noise = entries.filter((e) => referenceMetaOf(name, e).passes >= 2)
    .map((e) => [e.key, fixed(halvesNoiseOf(name, e).g, 5)]);
  console.log(['', ...table(['撮影', 'G(偶 − 奇)'], noise)].join('\n'));
}

// 基準の組 name の撮影 entry へ、段 tier のパスを passes 個目まで続きから足す。
async function extendReference(lab, name, entry, tier, passes) {
  const saved = referenceMetaOf(name, entry);
  if (saved !== null && (saved.slices !== tier.sliceCount || saved.steps !== tier.stepCount)) {
    throw new Error(`${entry.key}: saved with ${saved.slices} slices × ${saved.steps} steps, `
      + `asked for ${tier.sliceCount} × ${tier.stepCount}`);
  }
  const done = saved?.passes ?? 0;
  if (done >= passes) {
    console.log(`reference ${entry.key}: ${done} パス済み`);
    return;
  }
  const started = Date.now();
  await lab.show(entry);
  await lab.setTier(tier);
  // 形だけで決まるもの(近傍の半径と、境界を探す法線と深度の表示)は、撮影を作るときに 1 回だけ撮る。
  if (saved === null) {
    await lab.capturePng();
    writeFloats(referenceFileOf(name, entry, 'radius.f32'), await lab.readFloat('projected-radius', 1));
    for (const target of ['normal', 'depth']) {
      await lab.setTarget(target);
      writeFileSync(referenceFileOf(name, entry, `${target}.png`), await lab.capturePng());
    }
    await lab.setTarget('off');
  }
  // 和は保存済みのものへ続けて足す。
  const kinds = entry.set === 'correctness' ? ['display', 'diffuse'] : ['display'];
  const size = WIDTH * HEIGHT * 3;
  const sums = Object.fromEntries(kinds.map((kind) => [kind,
    saved === null ? [new Float32Array(size), new Float32Array(size)] : referenceSumsOf(name, entry, kind)]));
  const add = (sum, frame) => {
    for (let i = 0; i < size; i++) sum[i] += frame[i];
  };
  // パスを撮る。絵の落ち着きを待つのは最初のパスだけで、以後は seed だけが変わる。拡散照度はページの中で積み、
  // 撮影の終わりに 1 回だけ受け取る。
  const passesStarted = Date.now();
  let firstPassSeconds = 0;
  for (let k = done; k < passes; k++) {
    await lab.setSeed(seedOf(k));
    add(sums.display[k % 2], linearOfPng(k === done ? await lab.capturePng() : await lab.captureOncePng()));
    if (sums.diffuse !== undefined) await lab.accumulateFloat('diffuse', 3, k % 2);
    if (k === done) firstPassSeconds = (Date.now() - passesStarted) / 1000;
  }
  const passSeconds = (Date.now() - passesStarted) / 1000;
  if (sums.diffuse !== undefined) {
    for (const [half, sum] of (await lab.takeAccumulated(2)).entries()) add(sums.diffuse[half], sum);
  }
  const seconds = (Date.now() - started) / 1000;
  writeReferencePasses(name, entry, {
    slices: tier.sliceCount, steps: tier.stepCount, passes, seconds: (saved?.seconds ?? 0) + seconds,
  }, sums);
  const later = passes - done - 1;
  const perPass = later > 0 ? `${((passSeconds - firstPassSeconds) / later).toFixed(2)} s/パス、` : '';
  console.log(`reference ${entry.key}: パス ${done}〜${passes - 1}、${perPass}最初のパス ${firstPassSeconds.toFixed(1)} s、`
    + `撮影の所要 ${seconds.toFixed(0)} s`);
}

// 基準の組 name の評価の組 entries の、撮影ごとの近傍の半径のオクターブごとの画素数と、溝の梯子の溝の画面上の幅。
function printCoverage(name, entries) {
  const octaves = Array.from({ length: 10 }, (_, j) => 2 ** (j + 1));
  console.log(`\n| 撮影 | ${octaves.map((o) => `${o}〜`).join(' | ')} |`);
  console.log(`|${' --- |'.repeat(octaves.length + 1)}`);
  for (const entry of entries.filter((e) => e.set === 'tuning' || e.set === 'checking')) {
    const radius = readFloats(referenceFileOf(name, entry, 'radius.f32'));
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

// ---- 判定 ----

// 基準の組 name(と、歩数を倍にした組 doubledName)の収束を、撮影(--entries、既定は bay)ごとに表にする。比べる
// 相手のいまの中設定(均しなし、seed (0, 0))をその場で撮る。
export async function check({ positional, options }) {
  const [name, doubledName] = positional;
  if (name === undefined) throw new Error(CHECK_USAGE);
  const entries = selectedEntries({ entries: options.entries ?? 'bay' });
  const currents = await withLab(async (lab) => {
    const out = {};
    for (const entry of entries) {
      await lab.show(entry);
      await lab.setTier({ ...TIERS.medium, denoiseRadius: 0 });
      await lab.setSeed(seedOf(0));
      out[entry.key] = await captureLinear(lab);
    }
    return out;
  });
  const rows = entries.map((entry) => checkRowOf(name, doubledName, entry, currents[entry.key]));
  const describe = (label, n) => {
    const meta = referenceMetaOf(n, entries[0]);
    return `${label} ${n}: ${meta.slices} スライス × 片側 ${meta.steps} 歩、${meta.passes} パス`;
  };
  console.log([describe('B', name), ...(doubledName === undefined ? [] : [describe('B₂', doubledName)]), ''].join('\n'));
  console.log(table([
    '撮影', 'G(偶 − 奇)', 'R(s) 偶 − 奇', 'G(中・均しなし)', 'G(B₂ − B)', 'G(B₂ 偶 − 奇)',
    '雑音 G ≦ 中/10', `雑音 R(s)/R(1) ≦ ${CONVERGED_R_RATIO}`, '歩数 G ≦ 中/10',
  ], rows).join('\n'));
}

// 撮影 entry の判定の行。current はいまの中設定(均しなし)の表示(線形 sRGB)。合否の後の括弧は、G の中の G に
// 対する比か、R(s) の R(1) に対する比の最大。
function checkRowOf(name, doubledName, entry, current) {
  const b = loadReference(name, [entry])[entry.key];
  const mask = maskOf(b.radius);
  const reference = oklabOf(b.display);
  const noise = halvesNoiseOf(name, entry);
  const currentG = errorMetrics(oklabOf(current), reference, mask, WIDTH, HEIGHT, 0, 4).g;
  const doubled = doubledName === undefined ? null : {
    g: errorMetrics(oklabOf(loadReference(doubledName, [entry])[entry.key].display), reference, mask, WIDTH, HEIGHT, 0, 1).g,
    noiseG: halvesNoiseOf(doubledName, entry).g,
  };
  const verdict = (value, limit, digits) => `${value <= limit ? '合' : '否'} (${value.toFixed(digits)})`;
  return [
    entry.key, fixed(noise.g, 5), noise.r.map((v) => v.toFixed(2)).join(' / '), fixed(currentG, 5),
    fixed(doubled?.g, 5), fixed(doubled?.noiseG, 5),
    verdict(noise.g / currentG, CONVERGED_G_RATIO, 3), verdict(Math.max(...noise.r) / noise.r[0], CONVERGED_R_RATIO, 2),
    doubled === null ? '—' : verdict(doubled.g / currentG, CONVERGED_G_RATIO, 3),
  ];
}
