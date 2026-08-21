// 2球の剛体接触の解決。掃引TOI(sphere-contact.ts の sweptSphereContact)を一次手段とし、
// 区間終端の重なり押し戻しは異常時(掃引で検出できない開始時点からの重なり等)の
// フォールバックとしてだけ使う。逆質量(0 = 無限質量)・半径・反発係数だけを引数に取る
// 純関数で、どちらの側が艦・弾・天体かには関与しない。
import { Vec3, add, dot, scale, sub } from './vec3';
import { KinematicState } from './kinematic-state';
import { sweptSphereContact } from './sphere-contact';

export interface CollisionResponse {
  readonly rA: Vec3; readonly rB: Vec3; // 補正後の位置
  readonly vA: Vec3; readonly vB: Vec3; // 反発後の速度(離反中なら元のまま)
  readonly normal: Vec3;                // a → b へ向く接触法線
  readonly impulse: number;             // 力積の大きさ [N·s]。反発しなければ 0
  readonly toi: number;                 // 接触時刻(prev→state 区間内の割合、0..1)。重なり
                                         // フォールバックでは検出できないので区間終端(1)固定
}

interface SphereState {
  readonly state: KinematicState; // 区間終端の位置・速度
  readonly radius: number;
  readonly invMass: number; // 0 = 無限質量
}

// prevA/prevB は直前区間の始点の状態。渡せば掃引TOIを一次手段として試す。掃引で検出できない
// 場合(直前区間の状態が無い、区間開始時点で既に重なっている等)だけ、区間終端の重なりを
// 押し戻す補正へフォールバックする。
export function resolveSphereCollision(
  a: SphereState,
  b: SphereState,
  restitution: number,
  prevA?: KinematicState,
  prevB?: KinematicState,
): CollisionResponse | null {
  const minD = a.radius + b.radius;
  const invM = a.invMass + b.invMass;
  // 位置補正・撃力どちらの式も invM を分母に取るので、非有限なら両側へ NaN が、
  // 0(両者とも無限質量)なら両側へ Infinity が広がる。距離ガードと同じ `!(x > 0)` 形で
  // 弾く — `x <= 0` と書くと NaN に対する真偽が反転して非有限入力が通り抜ける。
  if (!(invM > 0)) return null;

  // 掃引で解決できるのは区間の途中で触れ合う場合だけ。始点で既に重なっていれば、掃引が
  // 返すのは離れていく瞬間なので、押し戻しへ回す。
  const contact = prevA !== undefined && prevB !== undefined
    ? sweptSphereContact(prevA, a.state, prevB, b.state, minD)
    : null;
  const swept = contact !== null && !contact.startsInside ? contact.crossing : null;

  let normal: Vec3;
  let rA: Vec3, rB: Vec3;
  let toi: number;

  if (swept !== null) {
    normal = swept.normal;
    toi = swept.toi;
    // 位置は積分器が出した区間終端の値をそのまま保ち、法線方向だけ半径和ちょうどに揃える —
    // 重心を動かすと質量比の効かない並進が両者に乗り、軌道速度で進む重い側ではそれが1区間ぶんの
    // 可視の位置の飛びになる。
    const c = add(scale(a.state.r, b.invMass / invM), scale(b.state.r, a.invMass / invM));
    const offset = scale(normal, minD);
    rA = sub(c, scale(offset, a.invMass / invM));
    rB = add(c, scale(offset, b.invMass / invM));
  } else {
    const d = sub(b.state.r, a.state.r);
    const distSq = dot(d, d);
    // 非有限値(NaN/Infinity)は比較で必ず false になるため、ガードしないと
    // 「常に接触している」と判定され、毎フレーム反発と衝突音が発生し、しかも
    // 相手側まで NaN に汚染してしまう。
    if (!(distSq > 0 && distSq < minD * minD)) return null;
    const dist = Math.sqrt(distSq);
    normal = scale(d, 1 / dist);
    const pen = minD - dist;
    const pCorr = (pen / invM) * 0.8;
    rA = sub(a.state.r, scale(normal, pCorr * a.invMass));
    rB = add(b.state.r, scale(normal, pCorr * b.invMass));
    toi = 1;
  }

  const vn = dot(sub(b.state.v, a.state.v), normal);
  if (!(vn < 0)) {
    return { rA, rB, vA: a.state.v, vB: b.state.v, normal, impulse: 0, toi };
  }
  const impulse = -((1 + restitution) * vn) / invM;
  const vA = sub(a.state.v, scale(normal, impulse * a.invMass));
  const vB = add(b.state.v, scale(normal, impulse * b.invMass));
  return { rA, rB, vA, vB, normal, impulse: Math.abs(impulse), toi };
}
