// 機体1隻の姿勢制御系。手動操作も自動操縦も、アクチュエータを直接動かさずここへ要求を出す。
// 要求元が1つに揃っていることが、フライホイールの蓄積角運動量を取りこぼさない条件である —
// 誰かが機体のトルクを直接書けば、その分だけ角運動量が更新されず飽和の計算が合わなくなる。
import type { ActuatorSet, Allocation, ControlRequest } from '../../physics/attitude-control';
import { allocateControl, desaturationActive } from '../../physics/attitude-control';
import { Attitude, qInvert, qRotate } from '../../physics/attitude';
import { geomagneticField } from '../../physics/geomagnetic';
import { Vec3, len, v3 } from '../../physics/vec3';

const NO_REQUEST: ControlRequest = { torque: v3(), force: v3() };

export class AttitudeControlSystem {
  // フライホイールの蓄積角運動量(機体座標 [N·m·s])。
  private momentum: Vec3 = v3();
  private desaturating = false;
  private request: ControlRequest = NO_REQUEST;
  private _allocation: Allocation | null = null;

  public get wheelMomentum(): Vec3 { return this.momentum; }
  public get isDesaturating(): boolean { return this.desaturating; }
  // 直近の配分。噴くノズルの選択と表示はこれを読む。まだ1度も解いていなければ null。
  public get allocation(): Allocation | null { return this._allocation; }

  // 蓄積角運動量が上限に占める割合。上限を持たない機体では 0。
  public saturationRatio(actuators: ActuatorSet): number {
    const hMax = actuators.wheel?.maxAngularMomentum ?? 0;
    return hMax > 0 ? len(this.momentum) / hMax : 0;
  }

  // 姿勢トルクを要求する。次に resolve が呼ばれるまで保持される。
  public requestTorque(torque: Vec3): void {
    this.request = { torque, force: v3() };
  }

  // 姿勢トルクと並進推力を同時に要求する。
  public requestWrench(torque: Vec3, force: Vec3): void {
    this.request = { torque, force };
  }

  // 要求を取り下げる。操作されないフレームへ持ち越さない。
  public clearRequest(): void {
    this.request = NO_REQUEST;
  }

  // 要求を1刻みぶん配分し、機体が実際に受けるトルクを返す。dt はシミュレーション時間 —
  // 蓄積角運動量はトルクを積分した量なので、実時間で進めると時間加速で辻褄が合わなくなる。
  // positionEci は地球磁場を引くための ECI 位置。
  public resolve(actuators: ActuatorSet, positionEci: Vec3, att: Attitude, dt: number): Vec3 {
    this.desaturating = desaturationActive(this.momentum, actuators.wheel, this.desaturating);
    const fieldBody = qRotate(qInvert(att.q), geomagneticField(positionEci));
    const allocation = allocateControl(
      this.request, actuators, this.momentum, fieldBody, dt, this.desaturating);
    this.momentum = allocation.wheelMomentum;
    this._allocation = allocation;
    return allocation.torque;
  }
}
