// 大気風の共有モデル。風速 [m/s] は緯度と高度に応じて連続的に変化する。
// 描画側は本モデルから位相を導出する。
import { abs, exp, float, sign, smoothstep as nodeSmoothstep, vec2 } from 'three/tsl';
import type { FloatNode, Vec2Node } from '../tsl-types';
interface WindVector { readonly east: number; readonly north: number }

export const SURFACE_HEIGHT = 1_000;
export const UPPER_CLOUD_HEIGHT = 10_000;
const BAND_LATITUDES = [75, 45, 15, -15, -45, -75] as const;

// 上層(10 km ≈ 250 hPa)の帯状平均の東西風 [m/s]。ガウスの葉の和の連続な緯度プロファイル —
// 亜熱帯ジェットを ±30° の細い葉(34 m/s・幅 10°)、温帯の偏西風を ±50° の葉(20 m/s・
// 幅 20°)、熱帯の上層の弱い東風を赤道の葉(−7 m/s・幅 18°)で書く。瞬間の場としての
// 亜熱帯ジェットは千キロにも届かない細い流れ(幅は 10° 級)で、250 hPa の気候値では芯が
// 30〜40 m/s、温帯の上層風が 20〜30 m/s、熱帯の上層は弱い東風 (Oort & Peixoto
// 「Global Angular Momentum and Energy Balance Requirements from Observations」の
// 帯状平均東西風、ERA5 再解析の気候値と同じ形)。葉の重なりで 35〜50° 帯は 20〜28 m/s。
const JET_LATITUDE = (30 * Math.PI) / 180;
const JET_WIDTH = (10 * Math.PI) / 180;
const JET_SPEED = 34;
const MIDLAT_LATITUDE = (50 * Math.PI) / 180;
const MIDLAT_WIDTH = (20 * Math.PI) / 180;
const MIDLAT_SPEED = 20;
// 極前線ジェットの極側の裾野。温帯の葉だけでは 60° 以北で上層風が 10 m/s 台へ落ちるが、実測の
// 300 hPa は極渦のまわりに 20 m/s 級を保つ — 南極圏の偏西風帯。
const POLAR_LATITUDE = (70 * Math.PI) / 180;
const POLAR_WIDTH = (16 * Math.PI) / 180;
const POLAR_SPEED = 13;
const TROPICAL_EASTERLY = -7;
const TROPICAL_WIDTH = (18 * Math.PI) / 180;

// 緯度 |φ| [rad] における上層の東向き成分 [m/s](半球対称)。
function upperEastAt(absLatitude: number): number {
  const lobe = (center: number, width: number): number => {
    const x = (absLatitude - center) / width;
    return Math.exp(-x * x);
  };
  return JET_SPEED * lobe(JET_LATITUDE, JET_WIDTH)
    + MIDLAT_SPEED * lobe(MIDLAT_LATITUDE, MIDLAT_WIDTH)
    + POLAR_SPEED * lobe(POLAR_LATITUDE, POLAR_WIDTH)
    + TROPICAL_EASTERLY * lobe(0, TROPICAL_WIDTH);
}

export class AtmosphericWindField {
  public sample(latitudeRad: number, heightM: number): WindVector {
    const a = Math.abs(latitudeRad);
    // 地表付近の緯度帯の重み。貿易風は 0〜30° で東向き成分が負、偏西風は 30〜60° で正、
    // 極偏東風は 60〜90° で負になるよう、帯の窓を実際の緯度帯へ付ける。
    const trade = smoothstep(0.18, 0.32, a) * (1 - smoothstep(0.42, 0.58, a));
    const westerly = smoothstep(0.42, 0.58, a) * (1 - smoothstep(0.94, 1.15, a));
    const polar = smoothstep(0.98, 1.25, a);
    const layer = smoothstep(SURFACE_HEIGHT, UPPER_CLOUD_HEIGHT, heightM);
    const hemisphere = latitudeRad < 0 ? -1 : 1;
    const eastSurface = -6 * trade + 7 * westerly - 9 * polar;
    const northSurface = -hemisphere * (1.5 * trade - 1.5 * westerly + polar);
    // 上層の南北成分は地表付近と逆向きの弱い流れ(収束循環の戻り)。
    return {
      east: eastSurface + layer * (upperEastAt(a) - eastSurface),
      north: northSurface + layer * (-northSurface - hemisphere * 0.8),
    };
  }

  // TSL シェーダーグラフ向けサンプリング。CPU 側とシェーダー側の風速プロファイルを一元化する。
  public sampleNode(latitudeRad: FloatNode, heightM: number): Vec2Node {
    const absolute = abs(latitudeRad);
    const trade = nodeSmoothstep(float(0.18), float(0.32), absolute)
      .mul(nodeSmoothstep(float(0.42), float(0.58), absolute).oneMinus());
    const westerly = nodeSmoothstep(float(0.42), float(0.58), absolute)
      .mul(nodeSmoothstep(float(0.94), float(1.15), absolute).oneMinus());
    const polar = nodeSmoothstep(float(0.98), float(1.25), absolute);
    const layer = nodeSmoothstep(float(SURFACE_HEIGHT), float(UPPER_CLOUD_HEIGHT), float(heightM));
    const hemisphere = sign(latitudeRad);
    const eastSurface = trade.mul(-6).add(westerly.mul(7)).sub(polar.mul(9));
    const northSurface = hemisphere.mul(trade.mul(-1.5).add(westerly.mul(1.5)).sub(polar));
    const lobe = (center: number, width: number): FloatNode =>
      exp(absolute.sub(center).div(width).mul(absolute.sub(center).div(width)).negate());
    const eastUpper = float(JET_SPEED).mul(lobe(JET_LATITUDE, JET_WIDTH))
      .add(float(MIDLAT_SPEED).mul(lobe(MIDLAT_LATITUDE, MIDLAT_WIDTH)))
      .add(float(POLAR_SPEED).mul(lobe(POLAR_LATITUDE, POLAR_WIDTH)))
      .add(float(TROPICAL_EASTERLY).mul(lobe(0, TROPICAL_WIDTH)));
    return vec2(
      eastSurface.add(layer.mul(eastUpper.sub(eastSurface))),
      northSurface.add(layer.mul(northSurface.negate().sub(hemisphere.mul(0.8)))),
    );
  }
}

export class CloudPatternTransport {
  // surfaceRadius は模様を載せる天体の半径 [m]。物理風 [m/s] を角位相へ直す尺度になる。
  public constructor(
    private readonly surfaceRadius: number, private readonly field = new AtmosphericWindField(),
  ) {}

  // 模様の角位相 [rad]。物理風速から導出した描画用の移動状態を返す。
  public phaseAt(latitudeRad: number, heightM: number, seconds: number): number {
    const wind = this.field.sample(latitudeRad, heightM);
    const speed = Math.hypot(wind.east, wind.north);
    return (seconds * speed) / this.surfaceRadius;
  }

  // 物理風速成分 [m/s] を球面ノイズ座標系の角変位へ換算する。
  public angularPhase(eastMs: number, northMs: number, latitudeRad: number, seconds: number): {
    readonly east: number;
    readonly north: number;
  } {
    return {
      east: (eastMs * seconds) / (this.surfaceRadius * Math.max(0.25, Math.cos(latitudeRad))),
      north: (northMs * seconds) / this.surfaceRadius,
    };
  }
}

export function windBandsAt(heightM: number): readonly {
  readonly latitudeRad: number;
  readonly east: number;
  readonly north: number;
}[] {
  const field = new AtmosphericWindField();
  return BAND_LATITUDES.map((degrees) => {
    const latitude = degrees * Math.PI / 180;
    const wind = field.sample(latitude, heightM);
    return {
      latitudeRad: latitude,
      east: wind.east,
      north: wind.north,
    };
  });
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}
