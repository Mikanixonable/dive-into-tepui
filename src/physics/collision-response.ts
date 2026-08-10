// 2球の剛体接触の解決。掃引TOI(sphere-contact.ts の sweptSphereToi)を一次手段とし、
// 区間終端の重なり押し戻しは異常時(掃引で検出できない開始時点からの重なり等)の
// フォールバックとしてだけ使う。逆質量(0 = 無限質量)・半径・反発係数だけを引数に取る
// 純関数で、どちらの側が艦・弾・天体かには関与しない。
import { Vec3, add, dot, scale, sub } from './vec3';
import { sweptSphereToi } from './sphere-contact';

export interface CollisionResponse {
  readonly rA: Vec3; readonly rB: Vec3; // 補正後の位置
  readonly vA: Vec3; readonly vB: Vec3; // 反発後の速度(離反中なら元のまま)
  readonly normal: Vec3;                // a → b へ向く接触法線
  readonly impulse: number;             // 力積の大きさ [N·s]。反発しなければ 0
  readonly toi: number;                 // 接触時刻(prevR→r 区間内の割合、0..1)。重なり
                                         // フォールバックでは検出できないので区間終端(1)固定
}

interface SphereState {
  readonly r: Vec3;
  readonly v: Vec3;
  readonly radius: number;
  readonly invMass: number; // 0 = 無限質量
}

// prevRA/prevRB は直前区間の位置。渡せば掃引TOIを一次手段として試す。掃引で検出できない
// 場合(直前区間の位置が無い、区間開始時点で既に重なっている等)だけ、区間終端の重なりを
// 押し戻す補正へフォールバックする。
export function resolveSphereCollision(
  a: SphereState,
  b: SphereState,
  restitution: number,
  prevRA?: Vec3,
  prevRB?: Vec3,
): CollisionResponse | null {
  const minD = a.radius + b.radius;
  const invM = a.invMass + b.invMass;

  const swept = prevRA !== undefined && prevRB !== undefined
    ? sweptSphereToi(prevRA, a.r, prevRB, b.r, minD)
    : null;

  let normal: Vec3;
  let rA: Vec3, rB: Vec3;
  let toi: number;

  if (swept !== null) {
    normal = swept.normal;
    toi = swept.toi;
    // 位置は積分器が出した区間終端の値をそのまま保ち、法線方向だけ半径和ちょうどに揃える —
    // 重心を動かすと質量比の効かない並進が両者に乗り、軌道速度で進む重い側ではそれが1区間ぶんの
    // 可視の位置の飛びになる。
    const c = add(scale(a.r, b.invMass / invM), scale(b.r, a.invMass / invM));
    const offset = scale(normal, minD);
    rA = sub(c, scale(offset, a.invMass / invM));
    rB = add(c, scale(offset, b.invMass / invM));
  } else {
    const d = sub(b.r, a.r);
    const distSq = dot(d, d);
    // 非有限値(NaN/Infinity)は比較で必ず false になるため、ガードしないと
    // 「常に接触している」と判定され、毎フレーム反発と衝突音が発生し、しかも
    // 相手側まで NaN に汚染してしまう。
    if (!(distSq > 0 && distSq < minD * minD)) return null;
    const dist = Math.sqrt(distSq);
    normal = scale(d, 1 / dist);
    const pen = minD - dist;
    const pCorr = (pen / invM) * 0.8;
    rA = sub(a.r, scale(normal, pCorr * a.invMass));
    rB = add(b.r, scale(normal, pCorr * b.invMass));
    toi = 1;
  }

  const vn = dot(sub(b.v, a.v), normal);
  if (!(vn < 0)) {
    return { rA, rB, vA: a.v, vB: b.v, normal, impulse: 0, toi };
  }
  const impulse = -((1 + restitution) * vn) / invM;
  const vA = sub(a.v, scale(normal, impulse * a.invMass));
  const vB = add(b.v, scale(normal, impulse * b.invMass));
  return { rA, rB, vA, vB, normal, impulse: Math.abs(impulse), toi };
}
