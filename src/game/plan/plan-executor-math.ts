// PlanExecutor(マニューバノードの動力飛行実行)が使う純粋な計算: 燃焼時間・点火予定時刻・
// 遮断判定の射影・姿勢整列の up 基準。DOM/THREE に依存しないので tests/physics でも直接検証できる。
import { KinematicState, orbitAxes } from '../../physics/kinematic-state';
import { Vec3, dot, norm, sub } from '../../physics/vec3';

// 加速度 accel [m/s^2] で速度差 dv [m/s] を消し切るのに要る時間 [s]。
// accel が正でなければ有限時間で消せないので Infinity。
export function burnDurationFor(dv: number, accel: number): number {
  return accel > 0 ? dv / accel : Infinity;
}

// 総推力 totalThrust [N] と質量 mass [kg] から全開時の加速度 [m/s^2] を求める。
// 質量が正でなければ加速度は定義できないので0。
export function maxAccelOf(totalThrust: number, mass: number): number {
  return mass > 0 ? totalThrust / mass : 0;
}

// ノード実行時刻 nodeT を挟んで対称に燃焼する場合の点火予定時刻 [s]。
export function ignitionTimeFor(nodeT: number, dv: number, accel: number): number {
  return nodeT - burnDurationFor(dv, accel) / 2;
}

// 目標速度 targetV に対する残り速度差(targetV - currentV)の、噴射方向 burnDir への射影。
// 0以下になった時点でこれ以上の噴射は行き過ぎになるので遮断する。大きさではなく符号だけを
// 見ることで、実際の加速度が計画(等速燃焼の対称点)と食い違っていても遮断自体は正確になる。
export function burnCutoffProjection(targetV: Vec3, currentV: Vec3, burnDir: Vec3): number {
  return dot(sub(targetV, currentV), burnDir);
}

// 噴射方向 dv と平行にならない、姿勢整列の up 基準を選ぶ。動径方向 state.r を既定とし、
// dv がそれとほぼ平行(ラジアル方向のバーン)なら軌道面法線(orbitAxes(state).nrm)へ切り替える —
// 法線は定義上 r と直交するので、dv が両方に同時に平行になることはない。しきい値は
// qFromForwardUp が数値的に不安定になり始める手前(cos ≈ 0.99、約8°)に余裕を持たせてある。
export function burnUpReference(dv: Vec3, state: KinematicState): Vec3 {
  const parallelToRadial = Math.abs(dot(norm(dv), norm(state.r))) > 0.99;
  return parallelToRadial ? orbitAxes(state).nrm : state.r;
}

// 角度 angleRad [rad] だけの姿勢転回に要る時間 [s]。加減速の対称なバンバン制御(最大角加速度
// alpha で加速し切ったところで折り返して減速)を仮定した見積もりで、実際の PD 制御より
// 少し長めに出る(PD は目標角速度で頭打ちにならないぶん速いことがある)ぶんには
// 接近ウィンドウを狭めに倒さないので安全側。alpha が正でなければ有限時間で回頭できないので
// Infinity。
export function turnTimeFor(angleRad: number, alpha: number): number {
  return alpha > 0 ? 2 * Math.sqrt(Math.abs(angleRad) / alpha) : Infinity;
}
