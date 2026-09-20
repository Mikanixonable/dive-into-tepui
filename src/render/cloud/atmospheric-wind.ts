// 大気風の共有モデル。風速 [m/s] は緯度と高度に応じて連続的に変化する。
// 描画側は本モデルから位相を導出する。
import { abs, float, sign, smoothstep as nodeSmoothstep, vec2 } from 'three/tsl';
import type { FloatNode, Vec2Node } from '../tsl-types';
export type WindVector = { readonly east: number; readonly north: number };

export const SURFACE_HEIGHT = 1_000;
export const UPPER_CLOUD_HEIGHT = 10_000;
const BAND_LATITUDES = [75, 45, 15, -15, -45, -75] as const;

export class AtmosphericWindField {
  public sample(latitudeRad: number, heightM: number): WindVector {
    const a = Math.abs(latitudeRad);
    const trade = smoothstep(0.18, 0.32, a);
    const westerly = smoothstep(0.28, 0.55, a) * (1 - smoothstep(0.58, 0.72, a));
    const polar = smoothstep(0.62, 1.25, a);
    const layer = smoothstep(SURFACE_HEIGHT, UPPER_CLOUD_HEIGHT, heightM);
    const hemisphere = latitudeRad < 0 ? -1 : 1;
    const eastSurface = -6 * trade + 7 * westerly - 6 * polar;
    const northSurface = -hemisphere * (1.5 * trade - 1.5 * westerly + polar);
    return {
      east: eastSurface + layer * (12 * polar + 13 * westerly - eastSurface),
      north: northSurface + layer * (-northSurface - hemisphere * 0.8),
    };
  }

  // TSL シェーダーグラフ向けサンプリング。CPU 側とシェーダー側の風速プロファイルを一元化する。
  public sampleNode(latitudeRad: FloatNode, heightM: number): Vec2Node {
    const absolute = abs(latitudeRad);
    const trade = nodeSmoothstep(float(0.18), float(0.32), absolute);
    const westerly = nodeSmoothstep(float(0.28), float(0.55), absolute)
      .mul(nodeSmoothstep(float(0.58), float(0.72), absolute).oneMinus());
    const polar = nodeSmoothstep(float(0.62), float(1.25), absolute);
    const layer = nodeSmoothstep(float(SURFACE_HEIGHT), float(UPPER_CLOUD_HEIGHT), float(heightM));
    const hemisphere = sign(latitudeRad);
    const eastSurface = trade.mul(-6).add(westerly.mul(7)).sub(polar.mul(6));
    const northSurface = hemisphere.mul(trade.mul(-1.5).add(westerly.mul(1.5)).sub(polar));
    return vec2(
      eastSurface.add(layer.mul(polar.mul(12).add(westerly.mul(13)).sub(eastSurface))),
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
