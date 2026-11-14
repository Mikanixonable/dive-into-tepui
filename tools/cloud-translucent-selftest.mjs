// 半透明巻雲の物差しの自己検査。傾向が既知の合成場(筋・格子・薄幕・かなとこ)へ
// measureTranslucentWindow と classifyPattern を当て、区分判定・異方性・周期性・
// 勾配・芯との関係が期待どおりに出ることを判定する。ネットワークは使わない。
// 使い方: node tools/cloud-translucent-selftest.mjs — 1 つでも FAIL なら非 0 で終わる。
import { fft2 } from './cloud-detail-metrics.mjs';
import { measureTranslucentWindow, classifyPattern } from './cloud-translucent-features.mjs';
import { mulberry32 } from './cloud-translucent-gibs.mjs';

// 合成場の一辺 [px] と 1 画素が張る距離 [km]。実写の 1 km/px の段と同じ設定。
const N = 512;
const KM_PER_PX = 1;

// 動径スペクトルが ampOf(fx, fy) に比例する乱相位の場を FFT 合成する。
// cloud-detail-selftest の syntheticField と同じ構成で、振幅だけを 2 軸の関数に一般化した。
// ampOf は 2 次元スペクトルの振幅 — 実数場になるよう上半面だけ振って共役で埋める。
function syntheticField(n, ampOf, seed) {
  const re = new Float64Array(n * n);
  const im = new Float64Array(n * n);
  const rand = mulberry32(seed);
  const half = n / 2;
  for (let ky = 0; ky < n; ky++) {
    const fy = ky <= half ? ky : ky - n;
    for (let kx = 0; kx < n; kx++) {
      const fx = kx <= half ? kx : kx - n;
      if (!(fy > 0 || (fy === 0 && fx > 0))) continue;
      const amp = ampOf(fx, fy);
      if (amp === 0) continue;
      const phase = rand() * 2 * Math.PI;
      const i = ky * n + kx;
      const j = ((n - ky) % n) * n + ((n - kx) % n);
      re[i] = amp * Math.cos(phase);
      im[i] = amp * Math.sin(phase);
      re[j] = re[i];
      im[j] = -im[i];
    }
  }
  fft2(re, im, n, true);
  let mean = 0;
  for (const v of re) mean += v;
  mean /= re.length;
  let variance = 0;
  for (const v of re) variance += (v - mean) * (v - mean);
  const scale = 1 / Math.sqrt(variance / re.length);
  const data = new Float32Array(n * n);
  for (let i = 0; i < re.length; i++) data[i] = 0.5 + (re[i] - mean) * scale * 0.15;
  return { width: n, height: n, data };
}

// 場を fraction の分位で二値化したマスク。
function maskAt(field, fraction) {
  const sorted = Float32Array.from(field.data).sort();
  const t = sorted[Math.floor(sorted.length * fraction)];
  return Uint8Array.from(field.data, (v) => (v > t ? 1 : 0));
}

// 場を絶対のしきいで二値化したマスク(blob 格子のように背景の間隔が意味を持つ場用)。
function maskAbove(field, threshold) {
  return Uint8Array.from(field.data, (v) => (v > threshold ? 1 : 0));
}

// (a) x に 4 対 1 で伸ばした帯域ノイズ(λ 16〜128 km の帯で、x 方向の変化だけ遅い)。
const streakField = syntheticField(N, (fx, fy) => {
  const k = Math.hypot(fx * 4, fy);
  return k >= 4 && k <= 32 ? Math.pow(k, -1.2) : 0;
}, 11);

// (b) 周期約 6 km の blob 格子 + x 方向への大きさ・強さの勾配。
// symmetric な版(勾配なし)も作り、勾配の指標の対照とする。
function scalyField(n, spacingPx, slope) {
  const rand = mulberry32(23);
  const blobs = [];
  for (let gy = spacingPx / 2; gy < n; gy += spacingPx) {
    for (let gx = spacingPx / 2; gx < n; gx += spacingPx) {
      const x = gx + (rand() - 0.5) * 1.5;
      const y = gy + (rand() - 0.5) * 1.5;
      const amp = slope === 0 ? 1 : 0.6 + slope * (x / n);
      const radius = slope === 0 ? 1.4 : 1.1 + slope * 0.6 * (x / n);
      blobs.push({ x, y, amp, radius });
    }
  }
  const data = new Float32Array(n * n).fill(0.1);
  for (const b of blobs) {
    const r = Math.ceil(b.radius * 3);
    for (let y = Math.floor(b.y) - r; y <= Math.floor(b.y) + r; y++) {
      if (y < 0 || y >= n) continue;
      for (let x = Math.floor(b.x) - r; x <= Math.floor(b.x) + r; x++) {
        if (x < 0 || x >= n) continue;
        const d2 = (x - b.x) ** 2 + (y - b.y) ** 2;
        data[y * n + x] += b.amp * Math.exp(-d2 / (2 * b.radius * b.radius)) * 0.8;
      }
    }
  }
  return { width: n, height: n, data };
}
const scalySloped = scalyField(N, 6, 1.2);
const scalySymmetric = scalyField(N, 6, 0);

// (c) 低周波だけの滑らかな場(λ ≥ 64 km = k ≤ 8)。
const veilField = syntheticField(N, (fx, fy) => {
  const k = Math.hypot(fx, fy);
  return k >= 2 && k <= 8 ? 1 : 0;
}, 31);

// (d) 中心からずれた芯のまわりの放射状の減衰 + 下風側(+x)へ伸びる尾。
function anvilField(n) {
  const cx = n * 0.4;
  const cy = n * 0.5;
  const data = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const d = Math.hypot(x - cx, y - cy);
      let v = 0.85 * Math.exp(-d / 120);
      // 尾: +x 方向へ 250 km、幅 90 km。
      const u = x - cx;
      if (u > 0) v += 0.5 * Math.exp(-u / 140) * Math.exp(-((y - cy) ** 2) / (2 * 45 * 45));
      data[y * n + x] = Math.min(1, v + 0.05);
    }
  }
  return { width: n, height: n, data };
}
const anvil = anvilField(N);
const coreMask = new Uint8Array(N * N);
for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    if (Math.hypot(x - N * 0.4, y - N * 0.5) < 25) coreMask[y * N + x] = 1;
  }
}
const anvilMask = Uint8Array.from(anvil.data, (v) => (v > 0.15 ? 1 : 0));

let failures = 0;
const judge = (ok, label, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label.padEnd(44)}  ${detail}`);
};

console.log('=== 区分判定(合成場 512² × 1 km/px) ===');
const a = measureTranslucentWindow(streakField, { kmPerPx: KM_PER_PX, mask: maskAt(streakField, 0.75) });
const b = measureTranslucentWindow(scalySloped, { kmPerPx: KM_PER_PX, mask: maskAbove(scalySloped, 0.3) });
const c = measureTranslucentWindow(veilField, { kmPerPx: KM_PER_PX, mask: maskAt(veilField, 0.35) });
const d = measureTranslucentWindow(anvil, { kmPerPx: KM_PER_PX, mask: anvilMask, coreMask, windDeg: 0 });

const classA = classifyPattern(a);
const classB = classifyPattern(b);
const classC = classifyPattern(c);
judge(classA.className === 'streak', '(a) 伸ばした帯域ノイズ → streak',
  `${classA.className}(coherence63 ${a.aniso.coherence63?.toFixed(2)} r63 ${a.aniso.r63?.toFixed(2)})`);
judge(classB.className === 'scaly', '(b) 6 km 格子 → scaly',
  `${classB.className}(excess ${b.periodicity.excessRatio?.toFixed(2)} peak ${b.periodicity.peakScaleKm?.toFixed(1)} km)`);
judge(classC.className === 'veil', '(c) 低周波の場 → veil',
  `${classC.className}(cover ${c.shapes.cloudyShare.toFixed(2)} share64up ${c.spectrum.share64up.toFixed(2)})`);

console.log('\n=== 異方性・周期性の大小 ===');
judge((a.aniso.coherence63 ?? 0) > (c.aniso.coherence63 ?? 0), 'coherence63: 筋 > 薄幕',
  `${a.aniso.coherence63?.toFixed(3)} > ${c.aniso.coherence63?.toFixed(3)}`);
judge((b.periodicity.excessRatio ?? 0) > (a.periodicity.excessRatio ?? 0)
  && (b.periodicity.excessRatio ?? 0) > (c.periodicity.excessRatio ?? 0),
  'excessRatio: 格子 > 筋・薄幕',
  `${b.periodicity.excessRatio?.toFixed(2)} > ${a.periodicity.excessRatio?.toFixed(2)}, ${c.periodicity.excessRatio?.toFixed(2)}`);

console.log('\n=== 成分の勾配(配向に沿った大きさ・強さの変化) ===');
const bSym = measureTranslucentWindow(scalySymmetric, { kmPerPx: KM_PER_PX, mask: maskAbove(scalySymmetric, 0.3) });
const gSloped = b.scaly.gradient?.strength ?? null;
const gSym = bSym.scaly.gradient?.strength ?? null;
judge(gSloped !== null && gSloped > 0.3, '傾きつき格子: gradientStrength 有意',
  `${gSloped?.toFixed(3)} > 0.3`);
judge(gSym !== null && gSym < 0.15, '対称格子: gradientStrength ≈ 0', `${gSym?.toFixed(3)} < 0.15`);

console.log('\n=== 芯との関係(かなとこの合成場) ===');
const bins = d.assoc?.bins ?? [];
const decay = bins.length === 5 && bins[0].maskShare > bins[4].maskShare;
judge(d.assoc !== null && decay, '距離帯の断面: 近傍が遠方より厚い',
  bins.map((bin) => bin.maskShare.toFixed(2)).join(' → '));
judge((d.assoc?.asymmetry ?? 0) > 0, '非対称: 下風側が厚い', `${d.assoc?.asymmetry?.toFixed(3)} > 0`);
judge((d.assoc?.spreadRatio ?? 0) > 1, '広がり比: 半透明部 > 芯', `${d.assoc?.spreadRatio?.toFixed(2)} > 1`);

console.log(failures === 0 ? '\n合成場の判定はすべて通った' : `\n${failures} 件の失敗`);
process.exit(failures === 0 ? 0 : 1);
