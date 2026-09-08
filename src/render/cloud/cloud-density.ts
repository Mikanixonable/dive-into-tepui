// 積雲の2D場を、高度方向へ連続に広げた密度場。R は柱の光学的厚み、G は柱の上端であり、
// どちらも表面の交差判定には使わない。視線積分と太陽光路積分がこの関数を共有することで、
// 見えている雲・雲の内部散乱・雲影が同じ密度を読む。
import { clamp, max, smoothstep } from 'three/tsl';
import { CLOUD_TOP_SPAN, columnOpticalDepth } from './cumulus-shape';
import type { FloatNode, Vec4Node } from '../tsl-types';

// 低い雲底を地表へ密着させず、雲の下端にも連続した遷移を持たせる高度 [m]。
const CLOUD_BASE_ALTITUDE = 500;

// 高度方向の密度プロファイル。雲底から徐々に濃くなり、雲頂へ近づくと徐々に薄くなる。
// このプロファイルを柱の光学的厚みで正規化するため、G の等値線は深度の段にならない。
const densityProfile = (normalizedAltitude: FloatNode): FloatNode =>
  smoothstep(0, 0.12, normalizedAltitude)
    .mul(smoothstep(0.72, 1, normalizedAltitude).oneMinus());

// 雲のある柱の密度 [1/m]。coverage は地面へ投影された雲量であり、cloudTop はその柱の上端。
// どちらも連続値のまま使い、coverage を高さへ掛けることはしない。
export function cloudDensityAt(field: Vec4Node, altitude: FloatNode): FloatNode {
  const top = max(field.g.mul(CLOUD_TOP_SPAN), CLOUD_BASE_ALTITUDE + 1);
  const height = max(top.sub(CLOUD_BASE_ALTITUDE), 1);
  const normalizedAltitude = altitude.sub(CLOUD_BASE_ALTITUDE).div(height);
  const profile = densityProfile(normalizedAltitude);
  const columnDepth = columnOpticalDepth(clamp(field.r, 0, 0.99));
  return columnDepth.mul(profile).div(height).mul(1.8);
}
