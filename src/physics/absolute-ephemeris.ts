// 天体1体ぶんの暦を供給する層と、暦パックの生の座標軸をゲーム軸へ写す変換。
// 暦データの表現(Chebyshev/SPK/テスト用解析解)と、どの天体を引くかの選択を分離する。
import { BodyEphemeris } from './body-ephemeris';
import { Vec3, v3 } from '../math/vec3';

// 天体 id から1体ぶんの暦を切り出す供給源。引くのは構築時に1度で、収録していない天体には
// null を返す。
export interface AbsoluteEphemeris {
  bodyEphemerisOf(id: string): BodyEphemeris | null;
}

// ICRF の (X,Y,Z)=(春分点方向, 赤道面内, 北極) を、ゲームの
// (X,Y,Z)=(春分点方向, 北極, -赤道面内) へ右手系のまま写す。
export function icrfToGameEci(a: Vec3): Vec3 {
  return v3(a.x, a.z, a.y === 0 ? 0 : -a.y);
}
