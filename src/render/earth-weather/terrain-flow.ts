// 地形への吹き付けで下層の風を回す。山地や島へ向かう風は、地形を障壁として見積もった
// 高さと吹き付けの強さの比(フルード数 Fr = U/(N·H))で、地形を越えるぶんと回るぶんへ
// 連続に分かれる — Sheppard の分割流線モデルでは、Fr < 1 の層は下から H(1−Fr) までが
// 山を迂回する。ここではその割合だけ上り成分を消して、残りを等高線へ沿わせる。
import { clamp, dot, float, length, max } from 'three/tsl';
import { CLOUD_TUNING } from './cloud/cloud-tuning';
import type { ClimateMap } from './climate-map';
import type { TerrainMap } from './terrain-map';
import type { Vec2Node, Vec3Node } from '../tsl-types';

// 浮力振動数 [1/s]。対流圏の典型的な安定度(N≈0.01)の代表値として固定する — 場ごとの
// 安定度の分布は持たない。
const BUOYANCY_FREQUENCY = 0.01;
// 細かい勾配から障壁の高さを見積もる裾野の半幅 [m]。孤立した峰や島は 30 km 級の裾野を
// 持つので、勾配 × この長さをその場の高さと見なす(地形テクスチャに標高を持たないぶんの近似)。
const RELIEF_LENGTH = CLOUD_TUNING.reliefLength;
// 斜面の法線を立てるときの勾配の床 [m/m]。床より平らな所では障壁も潰れて迂回が消えるので、
// 除算の安定のためにだけ置く。
const SLOPE_FLOOR = 1e-6;

export class TerrainFlow {
  public constructor(
    private readonly terrain: TerrainMap,
    private readonly climate: ClimateMap,
  ) {}

  // 単位方向 direction での下層の風(東向き・北向き成分 [m/s])へ地形の迂回を加えた風。
  // regime は堰き止めの判定に使う風 — 回される風そのものとは限らない。局所の釣り合い風や
  // 気団を遡らせる風のように、背景の流れを含まない場を回すときも、判定は地形へ実際に
  // 吹き付ける総量(地表付近の全風)で行う。
  public deflectAt(direction: Vec3Node, wind: Vec2Node, regime: Vec2Node): Vec2Node {
    const slope = this.terrain.slope(direction);
    const slopeLength = length(slope);
    const normal = slope.div(max(slopeLength, SLOPE_FLOOR));
    // 広い地形の高さは気候の標高(σ≈200 km)が担い、そこに乗らない孤立峰・島は
    // 細かい勾配 × 裾野の長さで見積もる。
    const barrier = max(this.climate.elevation(direction), slopeLength.mul(RELIEF_LENGTH));
    // 回るぶん 0..1。Fr が 1 を切るほど増え、0 なら上り成分がまるごと消えて全量が回る。
    const uphill = max(dot(regime, normal), 0);
    const blocked = clamp(
      float(1).sub(uphill.div(barrier.mul(BUOYANCY_FREQUENCY))), 0, 1)
      // 海底の起伏が大気を回さないよう、陸らしさで重みを掛ける。
      .mul(this.terrain.landFraction(direction));
    return wind.sub(normal.mul(blocked.mul(max(dot(wind, normal), 0))));
  }
}
