// 暦パックの生の座標軸(ICRF/J2000)をゲームの固定慣性軸へ写す変換。**軸だけを付け替え、
// 原点は動かさない** — 原点は太陽系重心のまま。kinematic-state.ts の 'icrf' タグと対になる。
import { Vec3, v3 } from '../math/vec3';

// ICRF の (X,Y,Z)=(春分点方向, 赤道面内, 北極) を、ゲームの
// (X,Y,Z)=(春分点方向, 北極, -赤道面内) へ右手系のまま写す。
export function icrfToGameEci(a: Vec3): Vec3 {
  return v3(a.x, a.z, a.y === 0 ? 0 : -a.y);
}
