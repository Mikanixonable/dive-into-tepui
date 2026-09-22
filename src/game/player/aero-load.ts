// 自機が受ける空力荷重。動圧、およびそれが構造限界を超えたか・空力加熱が有効な領域にいるかを算出・判定する。
import { airflow } from '../../physics/atmosphere';
import { type Vec3, sub } from '../../math/vec3';
import type { CelestialBody } from '../../physics/celestial-body';

export const MAX_DYN_PRESSURE = 35e3; // 超過で空力破壊 [Pa]

// 加熱の理由を「空力」と「内部」に分ける動圧 [Pa]。地球の大気では高度 133 km 相当で、これを
// 下回る動圧では空力加熱が放射冷却に対して桁で小さい。
const AERO_HEATING_MIN_Q = 1;

export class AeroLoad {
  // いま浴びている動圧 [Pa]。位置・速度と大気から求め直すキャッシュ。
  private _qdyn = 0;

  public get qdyn(): number { return this._qdyn; }

  // 位置 r・速度 v の機体が浴びる動圧を求め直す。atmosphereBody は抗力を及ぼすただ1体の
  // 大気天体(null なら真空)。
  public update(
    r: Vec3, v: Vec3, atmosphereBody: CelestialBody | null, atmospherePivot: number,
  ): void {
    const atm = atmosphereBody === null ? null : atmosphereBody.atmosphereAt(atmospherePivot);
    if (atmosphereBody === null || atm === null) {
      this._qdyn = 0;
      return;
    }
    const bodyState = atmosphereBody.stateAt(atmospherePivot);
    const { density, speed } = airflow(sub(r, bodyState.r), sub(v, bodyState.v), atm);
    this._qdyn = 0.5 * density * speed * speed;
  }

  // 動圧が構造限界を超えたか。
  public get overStructuralLimit(): boolean {
    return this._qdyn > MAX_DYN_PRESSURE;
  }

  // 空力加熱が効いている流れの中にいるか(動圧が AERO_HEATING_MIN_Q 以上か)。
  public get heatingAerodynamically(): boolean {
    return this._qdyn >= AERO_HEATING_MIN_Q;
  }
}
