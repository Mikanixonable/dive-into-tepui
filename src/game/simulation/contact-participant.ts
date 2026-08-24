// 接触の参加者としての個体の、区間 [prevState, state] の読み方。表面接触と物体どうしの接触は
// 共有するものをほとんど持たないが、この2つだけは同じ規則で読まなければならない。
import type { GameEntity } from '../game-entity/game-entity';

// 区間の両端の位置・速度と半径が有限で、接触用の質量が負でないか。1つでも欠けた
// エンティティを解決へ入れる前に落とす — 非有限座標はセル添字を壊し、区間変位は
// セル一辺の算出を通じて全参加者へ伝播する。質量は 0(試験粒子)と無限大(不動)を通し、
// NaN だけを落とす — `contactMass < 0` と書くと NaN が通り抜ける。
export function isFiniteParticipant(e: GameEntity): boolean {
  const { r, v } = e.state;
  const p = e.prevState.r;
  return Number.isFinite(r.x) && Number.isFinite(r.y) && Number.isFinite(r.z)
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z)
    && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
    && Number.isFinite(e.radius) && e.contactMass >= 0;
}

// TOI(prevState→state 区間内の割合)を接触時刻へ変換する。重なりフォールバックでは
// toi=1(区間終端)なので、その場合は state.t にそのまま一致する。
export function contactTime(e: GameEntity, toi: number): number {
  return e.prevState.t + (e.state.t - e.prevState.t) * toi;
}
