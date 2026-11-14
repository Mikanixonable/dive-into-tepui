// 太陽光の分光と、その大気透過後の色を出す純粋な計算。描画の教師・検証・表の焼き込みが
// 共有する「大気の光学」の片側 — GPU 側の 3 成分モデル(sun-path-depth.ts)が近似する対象。
// 波長ごとの消散を分光で積分して CIE 1931 XYZ・線形 sRGB・色度・CCT・相対輝度を返す。
// three に依らず、すべての値は引数とこのファイルの物理定数だけから決まる。

// ---- 分光の物理定数 ----------------------------------------------------------

// 太陽の有効温度 [K]。直射日光の分光分布の近似として黒体を採る。
export const SOLAR_TEMPERATURE = 5772;

// レイリー散乱の、海面 1013.25 hPa での波長ごとの光学的厚み。Bodhaine et al. (1999)
// 「On Rayleigh optical depth calculations」(J. Atmos. Oceanic Technol. 16) の式:
//   τ_R(λ) = 0.008569·λ⁻⁴ (1 + 0.0113·λ⁻² + 0.00013·λ⁻⁴) 、λ は µm。
// 大気全柱の値なので、経路の厚みにはこの値へ空気質量と気圧比を掛ける。
function rayleighDepth(lambdaUm: number): number {
  const inv2 = 1 / (lambdaUm * lambdaUm);
  return 0.008569 * inv2 * inv2 * (1 + 0.0113 * inv2 + 0.00013 * inv2 * inv2);
}

// エーロゾルの Ångström 則 τ_a(λ) = β·λ⁻ᵅ (λ は µm)。α = 1.3 は大陸性の標準値、
// β は 550 nm での光学的厚みから掛け直す(Iqbal 1983、Holben et al. 2001 の代表値)。
const AEROSOL_ANGSTROM_ALPHA = 1.3;
const AEROSOL_DEPTH_550NM = 0.1;

// オゾンの Chappuis 帯の吸収断面積 [cm²/分子] を 20 nm 刻みで引き写した粗い表。
// 出典: Brion–Daumont–Malicet (1998) / Bogumil et al. (2003)、Serdyuchenko et al. (2014)
// の常温値で、ピークは約 603 nm・4.8e-21。表の外は 0 として扱う。
const OZONE_XSECTION_NM: readonly (readonly [number, number])[] = [
  [440, 0.02e-21], [460, 0.1e-21], [480, 0.3e-21], [500, 0.6e-21], [520, 1.2e-21],
  [540, 2.1e-21], [560, 3.3e-21], [580, 4.2e-21], [600, 4.75e-21], [620, 4.5e-21],
  [640, 3.6e-21], [660, 2.5e-21], [680, 1.5e-21], [700, 0.85e-21], [720, 0.45e-21],
  [740, 0.2e-21], [760, 0.08e-21], [780, 0.02e-21],
];
function ozoneCrossSection(lambdaUm: number): number {
  const nm = lambdaUm * 1000;
  if (nm <= OZONE_XSECTION_NM[0]![0]) return OZONE_XSECTION_NM[0]![1];
  for (let i = 1; i < OZONE_XSECTION_NM.length; i++) {
    const [x1, y1] = OZONE_XSECTION_NM[i]!;
    if (nm <= x1) {
      const [x0, y0] = OZONE_XSECTION_NM[i - 1]!;
      return y0 + (y1 - y0) * ((nm - x0) / (x1 - x0));
    }
  }
  return 0;
}
// オゾン全量 300 DU あたりの柱密度 [分子/m²]。1 DU = 2.687e20 分子/m²。
export const OZONE_DOBSON = 300;
const OZONE_COLUMN = OZONE_DOBSON * 2.687e20; // [分子/m²]
const CM2_TO_M2 = 1e-4;
function ozoneDepth(lambdaUm: number): number {
  return ozoneCrossSection(lambdaUm) * CM2_TO_M2 * OZONE_COLUMN;
}

// 気圧が高度とともに減る率。レイリーのスケールハイト 8 km と同じ指数で揃える。
const PRESSURE_SCALE_HEIGHT = 8e3; // [m]

// 空気質量。Kasten & Young (1989)「Revised optical air mass tables and
// approximation formula」(Applied Optics 28) の式: 仰角 θ [deg] に対して
//   m = 1 / (sin θ + 0.50572·(θ + 6.07995°)⁻¹·⁶³⁶⁴)
export function airMass(elevationDeg: number): number {
  return 1 / (Math.sin(elevationDeg * Math.PI / 180)
    + 0.50572 * Math.pow(elevationDeg + 6.07995, -1.6364));
}

// ---- 色度の基礎 --------------------------------------------------------------

// CIE 1931 2° 等色関数。380〜780 nm を 10 nm 刻みで転記した標準表
// (CIE 15:2004 / CVRL の cie1931xyz に倣う。各色函数はピークが ȳ=1 の規格化)。
// ガウス近似は白点近傍の色度誤差が CCT へ増幅されるため使わない。
const CIE_1931_NM: readonly (readonly [number, number, number, number])[] = [
  [380, 0.0014, 0.0000, 0.0065], [390, 0.0042, 0.0001, 0.0201],
  [400, 0.0143, 0.0004, 0.0679], [410, 0.0435, 0.0012, 0.2074],
  [420, 0.1344, 0.0040, 0.6456], [430, 0.2839, 0.0116, 1.3856],
  [440, 0.3483, 0.0230, 1.7471], [450, 0.3362, 0.0380, 1.7721],
  [460, 0.2908, 0.0600, 1.6692], [470, 0.1954, 0.0910, 1.2876],
  [480, 0.0956, 0.1390, 0.8130], [490, 0.0320, 0.2080, 0.4652],
  [500, 0.0049, 0.3230, 0.2720], [510, 0.0093, 0.5030, 0.1582],
  [520, 0.0633, 0.7100, 0.0782], [530, 0.1655, 0.8620, 0.0422],
  [540, 0.2904, 0.9540, 0.0203], [550, 0.4334, 0.9950, 0.0087],
  [560, 0.5945, 0.9950, 0.0039], [570, 0.7621, 0.9520, 0.0021],
  [580, 0.9163, 0.8700, 0.0017], [590, 1.0263, 0.7570, 0.0011],
  [600, 1.0622, 0.6310, 0.0008], [610, 1.0026, 0.5030, 0.0003],
  [620, 0.8544, 0.3810, 0.0002], [630, 0.6424, 0.2650, 0.0000],
  [640, 0.4479, 0.1750, 0.0000], [650, 0.2835, 0.1070, 0.0000],
  [660, 0.1649, 0.0610, 0.0000], [670, 0.0874, 0.0320, 0.0000],
  [680, 0.0468, 0.0170, 0.0000], [690, 0.0227, 0.0082, 0.0000],
  [700, 0.0114, 0.0041, 0.0000], [710, 0.0058, 0.0021, 0.0000],
  [720, 0.0029, 0.0010, 0.0000], [730, 0.0014, 0.0005, 0.0000],
  [740, 0.0007, 0.0003, 0.0000], [750, 0.0003, 0.0001, 0.0000],
  [760, 0.0002, 0.0001, 0.0000], [770, 0.0001, 0.0000, 0.0000],
  [780, 0.0000, 0.0000, 0.0000],
];
function cieAt(lambdaUm: number, column: 1 | 2 | 3): number {
  const nm = lambdaUm * 1000;
  if (nm <= CIE_1931_NM[0]![0]) return CIE_1931_NM[0]![column];
  for (let i = 1; i < CIE_1931_NM.length; i++) {
    const row = CIE_1931_NM[i]!;
    if (nm <= row[0]) {
      const prev = CIE_1931_NM[i - 1]!;
      return prev[column] + (row[column] - prev[column]) * ((nm - prev[0]) / (row[0] - prev[0]));
    }
  }
  return 0;
}
const cieX = (lambdaUm: number): number => cieAt(lambdaUm, 1);
const cieY = (lambdaUm: number): number => cieAt(lambdaUm, 2);
const cieZ = (lambdaUm: number): number => cieAt(lambdaUm, 3);

// 黒体の分光放射輝度(相対値)。λ は µm。全体スケールは正規化で消えるので係数は省く。
function planck(lambdaUm: number, temperature: number): number {
  const c2 = 1.4388e-2; // hc/k [m·K] を µm スケールへ → 1.4388e4 µm·K → m 換算で下記
  const lambdaM = lambdaUm * 1e-6;
  return 1 / (Math.pow(lambdaM, 5) * (Math.exp(c2 / (lambdaM * temperature)) - 1));
}

// 線形 sRGB → XYZ。xyzToLinearSrgb の逆行列。
export function linearSrgbToXyz(r: number, g: number, b: number): readonly [number, number, number] {
  return [
    0.4124564 * r + 0.3575761 * g + 0.1804375 * b,
    0.2126729 * r + 0.7151522 * g + 0.0721750 * b,
    0.0193339 * r + 0.1191920 * g + 0.9503041 * b,
  ];
}

// XYZ → 線形 sRGB(IEC 61966-2-1 の行列)。範囲外は切り捨てない(呼び出し側が見る)。
export function xyzToLinearSrgb(x: number, y: number, z: number): readonly [number, number, number] {
  return [
    3.2404542 * x - 1.5371385 * y - 0.4985314 * z,
    -0.9692660 * x + 1.8760108 * y + 0.0415560 * z,
    0.0556434 * x - 0.2040259 * y + 1.0572252 * z,
  ];
}

// 色度 x, y から相関色温度 [K]。McCamy (1992) の式。黄昏の極低 CCT はこの近似の
// 有効域(約 1600〜8000 K)のぎりぎりなので、参照としての目安値として扱う。
export function cctMcCamy(x: number, y: number): number {
  const n = (x - 0.3320) / (0.1858 - y);
  return 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
}

// ---- 太陽光の分光 → 色 --------------------------------------------------------

// 1 波長ぶんの、太陽光が高度 altitude [m] の点へ届くまでの透過率 0..1。
// λ は µm、elevationDeg はその点の局所水平面からの太陽仰角 [deg]。
// 光学的厚みは「高度のぶん残った柱 × Kasten–Young の空気質量」で掛ける。
// 各成分の柱の残りは、それぞれの密度のスケールハイトで減る。
export interface SpectrumParts {
  readonly rayleigh?: boolean;
  readonly aerosol?: boolean;
  readonly ozone?: boolean;
  // 参照へ与えるエーロゾルの 550 nm 全柱光学的厚み。省くと標準の晴天値 0.1。
  // エンジン側の光学と入力を揃えた比較(実装のずれと入力の差を切り分ける)に使う。
  readonly aerosolDepth550?: number;
}
const ALL_PARTS: SpectrumParts = { rayleigh: true, aerosol: true, ozone: true };

export function sunTransmittanceAt(
  lambdaUm: number, elevationDeg: number, altitudeM = 0, parts: SpectrumParts = ALL_PARTS,
): number {
  const mass = airMass(elevationDeg);
  const depth =
    (parts.rayleigh !== false ? rayleighDepth(lambdaUm) * Math.exp(-altitudeM / PRESSURE_SCALE_HEIGHT) : 0)
    + (parts.aerosol !== false
      ? (parts.aerosolDepth550 ?? AEROSOL_DEPTH_550NM)
        * Math.pow(lambdaUm / 0.55, -AEROSOL_ANGSTROM_ALPHA)
        * Math.exp(-altitudeM / 1.2e3)
      : 0)
    + (parts.ozone !== false ? ozoneDepth(lambdaUm) * ozoneColumnFractionAbove(altitudeM) : 0);
  return Math.exp(-mass * depth);
}

// 高度 altitude より上に残るオゾン柱の割合。層は Hillaire (2020) と同じく
// 25 km を中心とする底 15 km・高さ 1 の三角テントとして採る。
function ozoneColumnFractionAbove(altitudeM: number): number {
  const base = 15e3;
  const x = (altitudeM - 25e3) / base;
  if (x <= -1) return 1;
  if (x >= 1) return 0;
  // テントの上向き積分の残り。x<0 側は下の半テント全体 + 上の部分。
  const upper = x <= 0 ? 0.5 * (1 + x) * (1 + x) : 0.5 * (1 - x) * (1 - x);
  return x <= 0 ? 0.5 + upper : upper;
}

// 分光を積分した結果 1 組。rgb は線形 sRGB、luminance は天頂の太陽を 1 とする相対輝度。
export interface SunlightColor {
  readonly rgb: readonly [number, number, number];
  readonly x: number;
  readonly y: number;
  readonly cct: number;
  readonly luminance: number;
}

// ---- 太陽光の分光 → 色 --------------------------------------------------------

// 分光 S(λ) を XYZ へ畳む。刻みは可視域 380〜780 nm を 5 nm。
function integrateSpectrum(sample: (lambdaUm: number) => number): [number, number, number] {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let nm = 380; nm <= 780; nm += 5) {
    const lambdaUm = nm / 1000;
    const s = sample(lambdaUm);
    x += s * cieX(lambdaUm);
    y += s * cieY(lambdaUm);
    z += s * cieZ(lambdaUm);
  }
  return [x, y, z];
}

// ---- 分光で焼く表への口 ------------------------------------------------------

// λ [µm] での黒体の太陽放射(相対値)。
export function solarRadiance(lambdaUm: number): number {
  return planck(lambdaUm, SOLAR_TEMPERATURE);
}

// λ [µm] での海面 1013.25 hPa 全柱レイリー光学的厚み(Bodhaine et al. 1999)。
export function rayleighColumnDepth(lambdaUm: number): number {
  return rayleighDepth(lambdaUm);
}

// エーロゾルの波長形状。550 nm で 1 を取る Ångström 則(α=1.3)。
export function aerosolColumnShape(lambdaUm: number): number {
  return Math.pow(lambdaUm / 0.55, -AEROSOL_ANGSTROM_ALPHA);
}

// λ [µm] での 300 DU 全柱オゾン吸収(Chappuis 帯)。
export function ozoneColumnDepth(lambdaUm: number): number {
  return ozoneDepth(lambdaUm);
}

// 線形 sRGB 応答の正の葉 × 太陽分光で畳んだ帯域重み。焼き込む RGB 表の値は
// 「帯域の中のどの波長がどれだけ残るか」の比なので、重みは応答 × 太陽分光で取る。
// **負の葉は畳まない** — 透過率は負になれず、負の葉の寄与は残る光の色度ずれとして
// 表の外へ出るだけだから。
function solarBandWeights(): readonly [Float64Array, Float64Array, Float64Array] {
  const r = new Float64Array(81);
  const g = new Float64Array(81);
  const b = new Float64Array(81);
  for (let nm = 380, i = 0; nm <= 780; nm += 5, i++) {
    const lambdaUm = nm / 1000;
    const s = planck(lambdaUm, SOLAR_TEMPERATURE);
    const x = cieX(lambdaUm);
    const y = cieY(lambdaUm);
    const z = cieZ(lambdaUm);
    r[i] = Math.max(0, 3.2404542 * x - 1.5371385 * y - 0.4985314 * z) * s;
    g[i] = Math.max(0, -0.9692660 * x + 1.8760108 * y + 0.0415560 * z) * s;
    b[i] = Math.max(0, 0.0556434 * x - 0.2040259 * y + 1.0572252 * z) * s;
  }
  return [r, g, b];
}
const BAND_WEIGHTS = solarBandWeights();

// 分光の光学的厚み τ(λ) が残す RGB の透過率。太陽分光を畳んだ帯域重みで
// 割合を取る(0..1)。RGB の表へ焼く値はこの畳み込みで出す — 帯域を 1 波長に
// 代表させると、長い経路で残る光が帯域の赤端へ寄る分光の飽和が取れない。
export function solarBandTransmittance(
  opticalDepthAt: (lambdaUm: number) => number,
): readonly [number, number, number] {
  const out: [number, number, number] = [0, 0, 0];
  const norm: [number, number, number] = [0, 0, 0];
  for (let nm = 380, i = 0; nm <= 780; nm += 5, i++) {
    const transmittance = Math.exp(-opticalDepthAt(nm / 1000));
    out[0] += BAND_WEIGHTS[0][i]! * transmittance;
    out[1] += BAND_WEIGHTS[1][i]! * transmittance;
    out[2] += BAND_WEIGHTS[2][i]! * transmittance;
    norm[0] += BAND_WEIGHTS[0][i]!;
    norm[1] += BAND_WEIGHTS[1][i]!;
    norm[2] += BAND_WEIGHTS[2][i]!;
  }
  return [out[0] / norm[0], out[1] / norm[1], out[2] / norm[2]];
}

// 分光の光学的厚み τ(λ) を透した太陽の、線形 sRGB への射影(透過なしの太陽を 1 とする比)。
// 直射表へ焼く透過率はこの射影で出す — 帯域ごとの正の葉だけで平均する形は、長い経路で
// 各帯域の赤端へ残る光をすべて「その帯域が透けた」として数え、透過率を過大に出す。
// XYZ 経由の全応答(負の葉も含む)で畳けば、残った光が実際に生む RGB は分光から一意に
// 決まる。応答の負の葉で射影が僅かに負になり得るので 0 で切る。
export function solarSpectrumSrgb(
  opticalDepthAt: (lambdaUm: number) => number,
): readonly [number, number, number] {
  const transmitted = xyzToLinearSrgb(...integrateSpectrum(
    (lambdaUm) => planck(lambdaUm, SOLAR_TEMPERATURE) * Math.exp(-opticalDepthAt(lambdaUm)),
  ));
  return [
    Math.min(Math.max(transmitted[0] / SUN_OPEN_SRGB[0], 0), 1),
    Math.min(Math.max(transmitted[1] / SUN_OPEN_SRGB[1], 0), 1),
    Math.min(Math.max(transmitted[2] / SUN_OPEN_SRGB[2], 0), 1),
  ];
}
const SUN_OPEN_SRGB = xyzToLinearSrgb(...integrateSpectrum(
  (lambdaUm) => planck(lambdaUm, SOLAR_TEMPERATURE),
));

// 高度 altitude [m]・太陽仰角 elevationDeg [deg] の点へ届く直射日光の色。
// luminance は天頂(90°)同高度を 1 とする相対値。
export function sunlightColor(elevationDeg: number, altitudeM = 0, parts: SpectrumParts = ALL_PARTS): SunlightColor {
  const [x, y, z] = integrateSpectrum(
    (lambdaUm) => planck(lambdaUm, SOLAR_TEMPERATURE) * sunTransmittanceAt(lambdaUm, elevationDeg, altitudeM, parts),
  );
  const sum = x + y + z;
  const zenith = integrateSpectrum(
    (lambdaUm) => planck(lambdaUm, SOLAR_TEMPERATURE) * sunTransmittanceAt(lambdaUm, 90, altitudeM, parts),
  );
  return {
    rgb: xyzToLinearSrgb(x, y, z),
    x: x / sum,
    y: y / sum,
    cct: cctMcCamy(x / sum, y / sum),
    luminance: y / zenith[1],
  };
}
