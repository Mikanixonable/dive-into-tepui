// 地表色(fBm ノイズによる大陸・バイオーム・雲)の純粋関数群。
// THREE 依存なし: tools/export-earth-texture.mjs から TypeScript コンパイラ API 経由で
// 直接 import され、テクスチャ焼き込みの唯一の情報源として使われる。
// (以前はこのロジックが src/render/earth.ts の中で球ジオメトリの頂点色として
// 毎起動時に評価されていたが、静的な PNG テクスチャに置き換えたためここへ移設した。)

export interface RGB {
  r: number;
  g: number;
  b: number;
}

// 決定論的な 3D 値ノイズ (fBm)
function hash3(x: number, y: number, z: number): number {
  const s = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return s - Math.floor(s);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function valueNoise(x: number, y: number, z: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const iz = Math.floor(z);
  const fx = smooth(x - ix);
  const fy = smooth(y - iy);
  const fz = smooth(z - iz);

  let result = 0;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dy = 0; dy <= 1; dy++) {
      for (let dx = 0; dx <= 1; dx++) {
        const w = (dx ? fx : 1 - fx) * (dy ? fy : 1 - fy) * (dz ? fz : 1 - fz);
        result += w * hash3(ix + dx, iy + dy, iz + dz);
      }
    }
  }
  return result;
}

function fbm(x: number, y: number, z: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  for (let i = 0; i < octaves; i++) {
    sum += amp * valueNoise(x * freq + 31.4, y * freq + 17.7, z * freq + 5.2);
    amp *= 0.5;
    freq *= 2.1;
  }
  return sum; // おおよそ [0, 1)
}

function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

function smoothstep(a: number, b: number, t: number): number {
  return smooth(clamp01((t - a) / (b - a)));
}

// hex パレット → リニア RGB。旧実装の new THREE.Color(hex) は色管理により
// sRGB→リニア変換してから頂点色(リニア空間)として使っていたので、それと
// 同一のパイプラインになるよう、ここでも定数をリニアへデコードしてから
// lerp 等の合成を行う(surfaceColor の出力はリニア。ツール側が最後に
// sRGB へエンコードして PNG に書き、実行時は SRGBColorSpace 指定でデコード
// されるため、往復してシェーディング入力が旧実装と一致する)。
function srgbChannelToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function hexToLinear(hex: number): RGB {
  return {
    r: srgbChannelToLinear(((hex >> 16) & 0xff) / 255),
    g: srgbChannelToLinear(((hex >> 8) & 0xff) / 255),
    b: srgbChannelToLinear((hex & 0xff) / 255),
  };
}

const OCEAN_DEEP = hexToLinear(0x08234f);
const OCEAN_MID = hexToLinear(0x0d3a74);
const OCEAN_SHALLOW = hexToLinear(0x1d6aa8);
const COAST_SAND = hexToLinear(0xc9b982);
const LAND_GREEN = hexToLinear(0x4d8a4a);
const LAND_FOREST = hexToLinear(0x2a5c36);
const LAND_DESERT = hexToLinear(0xc7a35f);
const LAND_TUNDRA = hexToLinear(0x8f8f76);
const LAND_ROCK = hexToLinear(0x7d766a);
const SNOW = hexToLinear(0xf2f6fc);
const CLOUD_WHITE = hexToLinear(0xf8fafd);

function lerpRGB(a: RGB, b: RGB, t: number): RGB {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}

function mulScalar(c: RGB, t: number): RGB {
  return { r: c.r * t, g: c.g * t, b: c.b * t };
}

function cloudCover(px: number, py: number, pz: number): number {
  const cloudBase = fbm(px * 2.3 + 51.7, py * 2.3, pz * 2.3, 5);
  const cloudWisp = fbm(px * 6.1 + 13.9, py * 6.1, pz * 6.1, 3);
  return smoothstep(0.52, 0.72, cloudBase * 0.75 + cloudWisp * 0.25);
}

// 単位球上の点(単位ベクトル、Y = 北極)→ 色。閾値の段差を作らず smoothstep で
// 連続的に混ぜて実写調のグラデーションにする。雲は別シェルだと水平線付近で
// 地表と z-fighting するため色に焼き込む(LEO から高度16kmの視差はほぼ知覚できない)。
export function surfaceColor(px: number, py: number, pz: number): RGB {
  const continents = fbm(px * 1.6, py * 1.6, pz * 1.6, 6);
  const detail = fbm(px * 5.0 + 9.1, py * 5.0, pz * 5.0, 5);
  const micro = fbm(px * 13.0 + 3.3, py * 13.0, pz * 13.0, 3);
  const lat = Math.abs(py); // 単位球なので |y| = sin(緯度)

  const landness = smoothstep(0.5, 0.535, continents); // 0=海, 1=陸

  // --- 海: 深海 → 沿岸のグラデーション + 微細な色むら ---
  const depth = smoothstep(0.3, 0.52, continents);
  let ocean = lerpRGB(OCEAN_DEEP, OCEAN_MID, depth * 0.7 + micro * 0.15);
  ocean = lerpRGB(ocean, OCEAN_SHALLOW, smoothstep(0.47, 0.53, continents) * 0.8);

  // --- 陸: 高度・緯度・乾燥度でバイオームを連続的に混合 ---
  const elev = smoothstep(0.535, 0.75, continents) + (detail - 0.5) * 0.3; // 標高感
  const climate = clamp01(lat + (detail - 0.5) * 0.3); // 0=熱帯, 1=極
  const dryness = smoothstep(0.45, 0.65, fbm(px * 2.6 + 77.7, py * 2.6, pz * 2.6, 4));

  let land = lerpRGB(LAND_GREEN, LAND_FOREST, smoothstep(0.15, 0.55, detail));
  // 低緯度の乾燥地帯は砂漠へ
  land = lerpRGB(land, LAND_DESERT, dryness * smoothstep(0.5, 0.15, climate));
  // 高緯度はツンドラ → 雪原へ
  land = lerpRGB(land, LAND_TUNDRA, smoothstep(0.6, 0.8, climate));
  land = lerpRGB(land, SNOW, smoothstep(0.8, 0.95, climate));
  // 高標高は岩肌、さらに高いと冠雪
  land = lerpRGB(land, LAND_ROCK, smoothstep(0.55, 0.85, elev) * 0.85);
  land = lerpRGB(land, SNOW, smoothstep(0.85, 1.05, elev + climate * 0.25));
  // 海岸線の砂浜(ごく狭い帯)
  land = lerpRGB(land, COAST_SAND, smoothstep(0.08, 0.0, landness - 0.08) * 0.5);

  let out = lerpRGB(ocean, land, landness);

  // 極冠(縁をノイズで揺らす)
  out = lerpRGB(out, SNOW, smoothstep(0.94, 0.975, lat + (detail - 0.5) * 0.04));

  // 微細な明度むら(のっぺり感を防ぐ。面ジッタではなく連続ノイズ)
  out = mulScalar(out, 0.94 + micro * 0.12);

  // 雲: 大小 2 スケールを合成し、縁を柔らかく
  const cover = cloudCover(px, py, pz);

  // 雲の影: 雲は地表から ~10km 上にあるので、影は雲の位置から少し西へずれて落ちる。
  // 地球固定(テクスチャ焼き込み)なので太陽方向には追従しない近似だが、
  // 「雲の隣に影が伸びる」見た目は常時成立する。
  const hl = Math.sqrt(px * px + pz * pz);
  if (hl > 1e-4) {
    // 東向き単位ベクトル(自転方向) = ŷ × p̂ の正規化
    const ex = -pz / hl;
    const ez = px / hl;
    const off = 0.025;
    let sx = px + ex * off;
    const sy = py;
    let sz = pz + ez * off;
    const sl = Math.sqrt(sx * sx + sy * sy + sz * sz);
    sx /= sl;
    sz /= sl;
    const shadow = cloudCover(sx, sy, sz);
    out = mulScalar(out, 1 - 0.32 * shadow * (1 - cover));
  }

  out = lerpRGB(out, CLOUD_WHITE, cover * 0.9);

  return out;
}
