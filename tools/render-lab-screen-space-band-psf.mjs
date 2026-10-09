// 近傍拡散補正の帯の縮小と合流の鎖が、帯 k に入れた走査の 1 画素をどの範囲へぼかすか(帯ごとの点の広がり)を、平面のケースの
// 3 つの構図で測る。帯 k だけに 1 画素のインパルスを入れた帯を鎖へ流し込み、merged-0(走査の解像度の C_0、最後の拡大の前)の
// 応答の台・エネルギーを含む半径・半値幅・中心を通る横断を、段 3 の 8×8 の整列すべてについて測る。
// 使い方: node tools/render-lab-screen-space-band-psf.mjs(先に npx webpack --config webpack.render-lab.config.js --mode production)。
// 出力は .render-lab-shots/ssd-8-15-chain-metrics/psf/ — psf.json(応答ごとの値と集計と横断)・psf.md(表)・<構図>-band<k>.png
// (整列で平均した応答を、インパルスの位置を画像の中央に揃えて対数の濃淡で)。長さはどれも走査の画素。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { encodeGrayPng } from './png.mjs';
import { OUTPUT, SCAN_PIXELS, SCAN_WIDTH } from './screen-space-chain-runs.mjs';
import { fixed, headHash, table, withLab } from './screen-space-lab.mjs';
import { drawBands } from './screen-space-rechain.mjs';

const OUT_DIR = path.join(OUTPUT, 'psf');
// 走査の段。帯の振り分けを通らないので bandScale は効かない。
const TIER = { scale: 0.25, sliceCount: 4, stepCount: 5, bandCount: 4, bandScale: 0.96 };
// 構図 — 床の真上から見下ろす(仰角 89° は観察の向きの上限)・既定の仰角 50°・掠める仰角 10°。画面の y が床の傾きの向き。
const VIEWS = [
  { name: 'facing', shot: 'plane-ambient', view: { cameraElevationDeg: 89 } },
  { name: 'elevation-50', shot: 'plane-ambient', view: null },
  { name: 'elevation-10', shot: 'plane-ambient-grazing', view: null },
];
// インパルスの置き方 [走査の画素]。段 3 のブロック(ALIGNMENT 画素四方)の左上を (BLOCK_X + i·BLOCK_SPACING, BLOCK_Y) に
// COLUMNS 個並べ、ブロックの中の位置をフレームと列で回す。応答はブロックの左上から [−WINDOW_BEFORE, BLOCK_SPACING − WINDOW_BEFORE)
// の窓で測る — 帯 3 の台(ブロックの左上から −14〜+21)を含み、隣の窓と重ならず、掠める構図の地平(走査の 45 行目付近)と
// 画面の縁から離れる。
const COLUMNS = 4;
const BLOCK_X = 32;
const BLOCK_Y = 88;
const BLOCK_SPACING = 56;
const WINDOW_BEFORE = 24;
const ALIGNMENT = 8;
const FRAMES = ALIGNMENT * ALIGNMENT / COLUMNS;
// 整列で平均した応答の格子の、インパルスの画素から左上の端までの画素の数と一辺。
const PSF_BEFORE = WINDOW_BEFORE + ALIGNMENT - 1;
const PSF_SIZE = PSF_BEFORE + BLOCK_SPACING - WINDOW_BEFORE;
// エネルギーを含む半径を求める割合。応答の画像の濃淡が覆う桁数と、画像の拡大の倍率。
const ENERGY_SHARES = [0.5, 0.9, 0.99];
const DECADES = 4;
const IMAGE_SCALE = 4;

// フレーム frame のインパルスの並び — ブロックの左上 (blockX, blockY) とインパルスの画素 (x, y)。
function impulsesOf(frame) {
  return Array.from({ length: COLUMNS }, (_, column) => {
    const alignment = frame * COLUMNS + column;
    const blockX = BLOCK_X + column * BLOCK_SPACING;
    return {
      blockX, blockY: BLOCK_Y, x: blockX + alignment % ALIGNMENT, y: BLOCK_Y + Math.floor(alignment / ALIGNMENT),
    };
  });
}

// 帯 band だけの、インパルスの画素の rgb を 1 にした帯の値(帯ごとに画素ごとの rgb)。
function impulseBandsOf(band, impulses) {
  const bands = Array.from({ length: TIER.bandCount }, () => new Float32Array(SCAN_PIXELS * 3));
  for (const { x, y } of impulses) bands[band].fill(1, 3 * (y * SCAN_WIDTH + x), 3 * (y * SCAN_WIDTH + x) + 3);
  return bands;
}

// インパルス impulse の窓の画素の並び — インパルスの画素からのずれ (x, y) と、画像 values(画素ごとに 1 つ)の値 v。
function windowPointsOf(values, impulse) {
  const points = [];
  for (let y = impulse.blockY - WINDOW_BEFORE; y < impulse.blockY + BLOCK_SPACING - WINDOW_BEFORE; y++) {
    for (let x = impulse.blockX - WINDOW_BEFORE; x < impulse.blockX + BLOCK_SPACING - WINDOW_BEFORE; x++) {
      points.push({ x: x - impulse.x, y: y - impulse.y, v: values[y * SCAN_WIDTH + x] });
    }
  }
  return points;
}

// 横断 profile(位置の順の { offset, value })の、ピークの半分を越える範囲の幅。端は隣の画素との線形補間で求める。
function halfMaxWidthOf(profile) {
  const half = Math.max(...profile.map(({ value }) => value)) / 2;
  const first = profile.findIndex(({ value }) => value >= half);
  const last = profile.findLastIndex(({ value }) => value >= half);
  const crossing = (inside, outside) => inside.offset
    + (outside.offset - inside.offset) * (inside.value - half) / (inside.value - outside.value);
  const left = first === 0 ? profile[0].offset : crossing(profile[first], profile[first - 1]);
  const right = last === profile.length - 1 ? profile[last].offset : crossing(profile[last], profile[last + 1]);
  return right - left;
}

// 画素の並び points の、中心 center のまわりの広がり。support は 0 でない画素の中心からの各軸の最大のずれ(画素の中心どうし)、
// reach はインパルスの画素からの同じもの、energyRadii は中心のまわりで和の ENERGY_SHARES を含む半径、halfMaxWidth はピークの
// 画素を通る横と縦の横断 profileX・profileY(ピークで割った値、位置は中心から)の半値幅、peak は最大の画素の和に対する割合、
// sigma は中心のまわりの 1 軸あたりの二次モーメントの平方根(参考)。
function rangeOf(points, [cx, cy]) {
  const nonzero = points.filter(({ v }) => v !== 0);
  const mass = nonzero.reduce((sum, { v }) => sum + v, 0);
  const peak = nonzero.reduce((best, point) => (point.v > best.v ? point : best));
  const maxOf = (pick) => Math.max(...nonzero.map(pick));
  const byRadius = nonzero.map(({ x, y, v }) => [Math.hypot(x - cx, y - cy), v]).sort((a, b) => a[0] - b[0]);
  const radiusHolding = (share) => {
    let held = 0;
    for (const [radius, v] of byRadius) {
      held += v;
      if (held >= share * mass) return radius;
    }
    return NaN;
  };
  const profileAlong = (axis, other, center) => points.filter((point) => point[other] === peak[other])
    .sort((a, b) => a[axis] - b[axis]).map((point) => ({ offset: point[axis] - center, value: point.v / peak.v }));
  const [profileX, profileY] = [profileAlong('x', 'y', cx), profileAlong('y', 'x', cy)];
  const secondMoment = (axis, center) => nonzero.reduce((sum, point) => sum + point.v * (point[axis] - center) ** 2, 0) / mass;
  return {
    mass,
    support: [maxOf(({ x }) => Math.abs(x - cx)), maxOf(({ y }) => Math.abs(y - cy))],
    reach: [maxOf(({ x }) => Math.abs(x)), maxOf(({ y }) => Math.abs(y))],
    energyRadii: ENERGY_SHARES.map(radiusHolding),
    halfMaxWidth: [halfMaxWidthOf(profileX), halfMaxWidthOf(profileY)],
    peak: peak.v / mass,
    sigma: [Math.sqrt(secondMoment('x', cx)), Math.sqrt(secondMoment('y', cy))],
    profileX, profileY,
  };
}

// 応答 1 つの { response, profiles } — response は重心のまわりの rangeOf(横断を除く)に、重心のインパルスからのずれ centroid と
// 窓の中の A の最小を足したもの、profiles はその横断 { profileX, profileY }。
function responseOf(points, alpha, impulse) {
  const mass = points.reduce((sum, { v }) => sum + v, 0);
  const centroid = ['x', 'y'].map((axis) => points.reduce((sum, point) => sum + point.v * point[axis], 0) / mass);
  const { profileX, profileY, ...range } = rangeOf(points, centroid);
  const minimumA = Math.min(...windowPointsOf(alpha, impulse).map(({ v }) => v));
  return { response: { impulse: [impulse.x, impulse.y], centroid, ...range, minimumA }, profiles: { profileX, profileY } };
}

// 整列で平均した応答の格子 psf(インパルスの画素が (PSF_BEFORE, PSF_BEFORE))の、インパルスの位置のまわりの rangeOf。
function averagedRangeOf(psf) {
  const points = Array.from(psf, (v, i) => ({ x: i % PSF_SIZE - PSF_BEFORE, y: Math.floor(i / PSF_SIZE) - PSF_BEFORE, v }));
  return rangeOf(points, [0, 0]);
}

// 平均した応答 psf の、最大を白・DECADES 桁下を黒にした濃淡の PNG(IMAGE_SCALE 倍に広げる)。
function psfPngOf(psf) {
  const size = PSF_SIZE * IMAGE_SCALE;
  const peak = psf.reduce((a, b) => Math.max(a, b), 0);
  const gray = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = psf[Math.floor(y / IMAGE_SCALE) * PSF_SIZE + Math.floor(x / IMAGE_SCALE)];
      const level = v > 0 ? 1 + Math.log10(v / peak) / DECADES : 0;
      gray[y * size + x] = Math.round(255 * Math.min(1, Math.max(0, level)));
    }
  }
  return encodeGrayPng(size, size, gray);
}

// 応答の並び responses の集計 — 各量の整列の平均と最小〜最大。
function summaryOf(responses) {
  const rangeOver = (pick) => {
    const values = responses.map(pick);
    return { mean: values.reduce((a, b) => a + b, 0) / values.length, min: Math.min(...values), max: Math.max(...values) };
  };
  return {
    support: [0, 1].map((axis) => rangeOver((r) => r.support[axis])),
    reach: [0, 1].map((axis) => rangeOver((r) => r.reach[axis])),
    energyRadii: ENERGY_SHARES.map((_, i) => rangeOver((r) => r.energyRadii[i])),
    halfMaxWidth: [0, 1].map((axis) => rangeOver((r) => r.halfMaxWidth[axis])),
    peak: rangeOver((r) => r.peak), mass: rangeOver((r) => r.mass),
    sigma: [0, 1].map((axis) => rangeOver((r) => r.sigma[axis])),
    minimumA: rangeOver((r) => r.minimumA).min,
  };
}

// 構図 view の帯ごとの { summary, averaged, kernelProfiles, responses }。averaged は整列で平均した応答の広がり、kernelProfiles
// は整列 (0, 0) の応答の横断。応答の画像を OUT_DIR へ書く。
async function measureView(lab, view) {
  // 段は撮影の描画設定で戻るので、撮影を出してから置き、全段で描き直して走査の面の写しを構図に合わせる。
  await lab.setStageRange('all');
  await lab.show({ caseName: 'plane', shot: view.shot, mode: 2 });
  await lab.setTier(TIER);
  if (view.view === null) await lab.render();
  else await lab.setView(view.view);
  await lab.setStageRange('chain');
  const bands = [];
  for (let band = 0; band < TIER.bandCount; band++) {
    const responses = [];
    let kernelProfiles = null;
    const psf = new Float64Array(PSF_SIZE * PSF_SIZE);
    for (let frame = 0; frame < FRAMES; frame++) {
      const impulses = impulsesOf(frame);
      await drawBands(lab, impulseBandsOf(band, impulses));
      const merged = await lab.readFloat('merged-0', 4);
      const values = Float32Array.from({ length: SCAN_PIXELS }, (_, p) => merged[4 * p]);
      const alpha = Float32Array.from({ length: SCAN_PIXELS }, (_, p) => merged[4 * p + 3]);
      for (const impulse of impulses) {
        const points = windowPointsOf(values, impulse);
        const { response, profiles } = responseOf(points, alpha, impulse);
        responses.push(response);
        kernelProfiles ??= profiles;
        for (const { x, y, v } of points) psf[(y + PSF_BEFORE) * PSF_SIZE + x + PSF_BEFORE] += v / (FRAMES * COLUMNS);
      }
    }
    console.log(`${view.name} band ${band}: ${responses.length} responses`);
    writeFileSync(path.join(OUT_DIR, `${view.name}-band${band}.png`), psfPngOf(psf));
    bands.push({ summary: summaryOf(responses), averaged: averagedRangeOf(psf), kernelProfiles, responses });
  }
  await lab.setStageRange('all');
  return bands;
}

// 横断 profile の、0 でない範囲とその両隣の「位置:値」の並び。
function profileText(profile) {
  const first = Math.max(0, profile.findIndex(({ value }) => value !== 0) - 1);
  const last = Math.min(profile.length - 1, profile.findLastIndex(({ value }) => value !== 0) + 1);
  return profile.slice(first, last + 1).map(({ offset, value }) => `${fixed(offset, 1)}:${fixed(value, 3)}`).join(' ');
}

// 構図ごとの表と横断の行。
function reportLinesOf(results) {
  const range = ({ mean, min, max }, digits) => (min === max ? fixed(mean, digits)
    : `${fixed(mean, digits)} (${fixed(min, digits)}–${fixed(max, digits)})`);
  const pair = ([x, y], digits) => `${fixed(x, digits)} / ${fixed(y, digits)}`;
  const ratio = (a, b) => (a > 0 ? fixed(b / a, 3) : '—');
  const lines = [];
  for (const [viewName, bands] of Object.entries(results)) {
    lines.push('', `## ${viewName}`, '', '整列ごとの応答(重心のまわり。整列の平均、最小–最大):', '');
    lines.push(...table(
      ['帯', '台の半幅 x', '台の半幅 y', '到達 x', '到達 y', 'r50', 'r90', 'r99', '半値幅 x', '半値幅 y', 'ピーク', '和', 'A の最小', 'σ x / y(参考)'],
      bands.map(({ summary: s }, band) => [
        band, range(s.support[0], 1), range(s.support[1], 1), range(s.reach[0], 1), range(s.reach[1], 1),
        ...s.energyRadii.map((r) => range(r, 2)), range(s.halfMaxWidth[0], 2), range(s.halfMaxWidth[1], 2),
        range(s.peak, 4), range(s.mass, 4), fixed(s.minimumA, 4),
        `${range(s.sigma[0], 3)} / ${range(s.sigma[1], 3)}`,
      ])));
    lines.push('', '整列で平均した応答(インパルスの位置のまわり):', '');
    lines.push(...table(
      ['帯', '台の半幅 x / y', 'r50', 'r90', 'r99', '半値幅 x / y', 'ピーク', 'σ x / y(参考)'],
      bands.map(({ averaged: a }, band) => [
        band, pair(a.support, 1), ...a.energyRadii.map((r) => fixed(r, 2)), pair(a.halfMaxWidth, 2),
        fixed(a.peak, 4), pair(a.sigma, 3),
      ])));
    lines.push('', '隣の帯との比 R_{k+1} / R_k(整列で平均した応答の x):', '');
    lines.push(...table(
      ['帯 k → k + 1', '台の半幅', 'r50', 'r90', 'r99', '半値幅'],
      bands.slice(1).map(({ averaged: next }, index) => {
        const current = bands[index].averaged;
        return [`${index} → ${index + 1}`, ratio(current.support[0], next.support[0]),
          ...current.energyRadii.map((r, i) => ratio(r, next.energyRadii[i])), ratio(current.halfMaxWidth[0], next.halfMaxWidth[0])];
      })));
    lines.push('', '横断(ピークで割った値。「重心からの位置:値」、整列 (0, 0) の応答と、整列で平均した応答):', '');
    for (const [band, { kernelProfiles, averaged }] of bands.entries()) {
      lines.push(`- 帯 ${band} 整列 (0, 0) x: ${profileText(kernelProfiles.profileX)}`);
      lines.push(`- 帯 ${band} 整列 (0, 0) y: ${profileText(kernelProfiles.profileY)}`);
      lines.push(`- 帯 ${band} 平均 x: ${profileText(averaged.profileX)}`);
    }
  }
  return lines;
}

mkdirSync(OUT_DIR, { recursive: true });
const results = await withLab(async (lab) => {
  const byView = {};
  for (const view of VIEWS) byView[view.name] = await measureView(lab, view);
  return byView;
});
const head = headHash();
writeFileSync(path.join(OUT_DIR, 'psf.json'), JSON.stringify({ head, tier: TIER, views: VIEWS, results }));
const lines = [
  `# 帯ごとの点の広がり(merged-0、${head})`, '',
  `段 ${JSON.stringify(TIER)}。長さは走査の画素(画素の中心どうし)。台の半幅は 0 でない画素の中心からの最大のずれ、到達は`
    + 'インパルスの画素からの同じもの、r50・r90・r99 は和のその割合を含む半径、半値幅はピークの画素を通る横断の幅、和は応答の和。',
  ...reportLinesOf(results),
];
writeFileSync(path.join(OUT_DIR, 'psf.md'), `${lines.join('\n')}\n`);
console.log(lines.join('\n'));
