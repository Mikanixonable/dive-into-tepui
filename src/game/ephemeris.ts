// 天体暦の状態: 太陽・月の ECI 位置(初期位相はゲームごとに決定)と、
// それに由来する太陽方向・地球影の日照率。位置の計算式そのものは
// physics/ephemeris.ts の純関数に任せ、ここでは simTime でサンプルした状態を保持する。
import { moonPosition, sunPosition } from '../physics/ephemeris';
import { R_EARTH } from '../physics/orbital';
import { Vec3, addScaled, dot, len, norm, v3 } from '../physics/vec3';
import * as C from './const';

export class EphemerisSystem {
  readonly sunPhase0 = 0; // 昼(太陽が+X側)から開始するように固定
  readonly moonPhase0 = Math.random() * Math.PI * 2;
  private sunPosV: Vec3 = v3(1.496e11, 0, 0);
  private moonPosV: Vec3 = v3(3.844e8, 0, 0);
  private sunDirV: Vec3 = v3(1, 0, 0);

  get sunPos(): Vec3 {
    return this.sunPosV;
  }

  get moonPos(): Vec3 {
    return this.moonPosV;
  }

  // 太陽方向の単位ベクトル(ライティング・影判定用)
  get sunDir(): Vec3 {
    return this.sunDirV;
  }

  // 太陽・月の ECI 位置を simTime から更新する
  update(simTime: number): void {
    this.sunPosV = sunPosition(simTime, this.sunPhase0);
    this.moonPosV = moonPosition(simTime, this.moonPhase0);
    this.sunDirV = norm(this.sunPosV);
  }

  // 自機位置の地表影(円柱近似 + 縁のぼかし)による日照率 0..1
  shadowLitFactor(r: Vec3): number {
    const along = dot(r, this.sunDirV);
    if (along >= 0) return 1; // 太陽側
    const perp = len(addScaled(r, this.sunDirV, -along));
    return Math.min(1, Math.max(0, (perp - R_EARTH) / C.SHADOW_PENUMBRA));
  }
}
