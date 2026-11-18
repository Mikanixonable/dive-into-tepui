// 巻雲の筋の向き(倍角ベクトル × 揃い度)の TSL ノード版。基準式と定数は cirrus-flow.ts が
// 持ち、ここは同じ式をシェーダグラフへ組む。
import { clamp, max, vec2 } from 'three/tsl';
import { CIRRUS_FLOW_SPEED_FULL, CIRRUS_FLOW_SPEED_ONSET } from './cirrus-flow';
import type { Vec2Node } from '../tsl-types';

// 上層の風(東・北の成分 [m/s])から、筋の向き θ の倍角ベクトル (cos 2θ, sin 2θ) × 揃い度。
// 基準式と同じく、倍角の成分は風ベクトルの成分から直に組むので θ 自身は求めない。
export function cirrusFlowFromWindNode(wind: Vec2Node): Vec2Node {
  const speedSq = wind.x.mul(wind.x).add(wind.y.mul(wind.y));
  const speed = speedSq.sqrt();
  const t = clamp(
    speed.sub(CIRRUS_FLOW_SPEED_ONSET).div(CIRRUS_FLOW_SPEED_FULL - CIRRUS_FLOW_SPEED_ONSET), 0, 1);
  const alignment = t.mul(t).mul(t.mul(-2).add(3));
  const inv = alignment.div(max(speedSq, 1e-8));
  return vec2(
    wind.x.mul(wind.x).sub(wind.y.mul(wind.y)).mul(inv),
    wind.x.mul(wind.y).mul(2).mul(inv),
  );
}
