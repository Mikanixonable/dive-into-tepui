// 自機の太陽電池パネルによる発電・蓄電。パネル法線は機体固定(0,1,0)で可動部はない。
import { Attitude, qRotate } from '../../physics/attitude';
import { Vec3, dot, v3 } from '../../physics/vec3';
import * as C from '../const';

export class PowerSystem {
  private charge = 0; // 蓄電量 [J]、0..POWER_CAPACITY

  // 毎フレーム呼ぶ。sunlit は sunlitFactor(0..1)、sunDir は太陽方向の単位ベクトル(world)。
  update(dt: number, sunlit: number, sunDir: Vec3, att: Attitude): void {
    const normal = qRotate(att.q, v3(0, 1, 0));
    // 裏面(法線が太陽と反対を向く)では発電しないため負値を0に切り詰める
    const cosIncidence = Math.max(0, dot(normal, sunDir));
    const power = C.SOLAR_CONSTANT * C.SOLAR_PANEL_EFFICIENCY * C.SOLAR_PANEL_AREA * cosIncidence * sunlit;
    this.charge = Math.min(C.POWER_CAPACITY, this.charge + power * dt);
  }

  // HUD 表示用。0..1。
  get chargeRatio(): number {
    return this.charge / C.POWER_CAPACITY;
  }
}
