// 大気風の共有モデル。風速 [m/s] は緯度と高度に応じて連続的に変化する。
// 描画側は本モデルから位相を導出する。風則そのものの数値版は atmospheric-wind-sample.ts が
// 持ち、TSL を引き込めない実行環境(worker)はそちらを読む。
import { abs, float, sign, smoothstep as nodeSmoothstep, vec2 } from 'three/tsl';
import { atmosphericWindAt, SURFACE_HEIGHT, UPPER_CLOUD_HEIGHT } from './atmospheric-wind-sample';
import type { FloatNode, Vec2Node } from '../tsl-types';
import type { WindVector } from './atmospheric-wind-sample';

// 例外(CODING-RULE 1.6「同じ値へ入口を2つ作らない」): 代表高度の所有者は
// atmospheric-wind-sample。このモジュールを引く既存の消費者(気象 CPU モデル・cloud-lab)が
// 同じ入口から読み続けられるよう、ここからも同じ値を公開する。
export { SURFACE_HEIGHT, UPPER_CLOUD_HEIGHT };

const BAND_LATITUDES = [75, 45, 15, -15, -45, -75] as const;

export class AtmosphericWindField {
  // 緯度 latitudeRad [rad]・高度 heightM [m] における大循環の風 [m/s]。
  public sample(latitudeRad: number, heightM: number): WindVector {
    return atmosphericWindAt(latitudeRad, heightM);
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
