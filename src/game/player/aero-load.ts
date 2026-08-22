// 自機が浴びている空力荷重。動圧と、それが構造限界を超えたかどうかを持つ。**熱ではない** —
// 外殻の熱収支は GameEntity の温度が受け持つ。
import type { CelestialBody } from '../../physics/celestial-body';
import { airflow } from '../../physics/atmosphere';
import { Vec3, sub } from '../../physics/vec3';
import * as C from '../const';

export class AeroLoad {
  // いま浴びている動圧 [Pa]。
  qdyn = 0;

  // 位置 r・速度 v の機体が浴びる動圧を求め直す。atmosphereBody は抗力を及ぼすただ1体の
  // 大気天体(null なら真空)。
  update(r: Vec3, v: Vec3, atmosphereBody: CelestialBody | null): void {
    const atm = atmosphereBody?.atmosphere ?? null;
    if (atm === null) {
      this.qdyn = 0;
      return;
    }
    const { density, speed } = airflow(
      sub(r, atmosphereBody!.state.r), sub(v, atmosphereBody!.state.v), atm);
    this.qdyn = 0.5 * density * speed * speed;
  }

  // 動圧が構造限界を超えたか。
  get overStructuralLimit(): boolean {
    return this.qdyn > C.MAX_DYN_PRESSURE;
  }

  // 空力加熱が効いている流れの中にいるか。これを下回る動圧では空力加熱は放射冷却に対して桁で
  // 小さく、そこで温度が上がったなら理由は艦の内部にしかない。
  get heatingAerodynamically(): boolean {
    return this.qdyn >= C.AERO_HEATING_MIN_Q;
  }
}
