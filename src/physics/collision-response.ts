// 2球の剛体接触の解決(めり込み補正+反発)。逆質量(0 = 無限質量)・半径・反発係数だけを
// 引数に取る純関数で、どちらの側が艦・弾・天体かには関与しない。
import { Vec3, add, dot, scale, sub } from './vec3';
import { sweptSphereToi } from './sphere-contact';

export interface CollisionResponse {
  readonly rA: Vec3; readonly rB: Vec3; // 補正後の位置
  readonly vA: Vec3; readonly vB: Vec3; // 反発後の速度(離反中なら元のまま)
  readonly normal: Vec3;                // a → b へ向く接触法線
  readonly impulse: number;             // 力積の大きさ [N·s]。反発しなければ 0
}

interface SphereState {
  readonly r: Vec3;
  readonly v: Vec3;
  readonly radius: number;
  readonly invMass: number; // 0 = 無限質量
}

// prevRA/prevRB は直前substepの位置。渡さなければ掃引TOIによる接触は試みない
// (呼び出し側が prevState のタイムスタンプ整合性を判断してから渡す)。
export function resolveSphereCollision(
  a: SphereState,
  b: SphereState,
  restitution: number,
  prevRA?: Vec3,
  prevRB?: Vec3,
): CollisionResponse | null {
  const d = sub(b.r, a.r);
  const distSq = dot(d, d);
  const minD = a.radius + b.radius;
  // 非有限値(NaN/Infinity)は比較で必ず false になるため、ガードしないと
  // 「常に接触している」と判定され、毎フレーム反発と衝突音が発生し、しかも
  // 相手側まで NaN に汚染してしまう。
  if (!Number.isFinite(distSq)) return null;
  const invM = a.invMass + b.invMass;

  let normal: Vec3;
  let rA: Vec3, rB: Vec3;

  if (distSq > 0 && distSq < minD * minD) {
    // 重なり(overlap)によるめり込み補正
    const dist = Math.sqrt(distSq);
    normal = scale(d, 1 / dist);
    const pen = minD - dist;
    const pCorr = (pen / invM) * 0.8;
    rA = sub(a.r, scale(normal, pCorr * a.invMass));
    rB = add(b.r, scale(normal, pCorr * b.invMass));
  } else {
    // 最終位置が離れていても直前substepの線分間で交差していればTOI接触を採用する。
    // 補正は相対配置だけに効かせ(法線方向に半径和ちょうど)、重心は積分器が出した
    // 区間終端の値をそのまま保つ — 重心を動かすと質量比の効かない並進が両者に乗り、
    // 軌道速度で進む重い側ではそれが1サブステップぶんの可視の位置の飛びになる。
    if (prevRA === undefined || prevRB === undefined) return null;
    const hit = sweptSphereToi(prevRA, a.r, prevRB, b.r, minD);
    if (hit === null) return null;
    normal = hit.normal;
    const c = add(scale(a.r, b.invMass / invM), scale(b.r, a.invMass / invM));
    const offset = scale(normal, minD);
    rA = sub(c, scale(offset, a.invMass / invM));
    rB = add(c, scale(offset, b.invMass / invM));
  }

  const vn = dot(sub(b.v, a.v), normal);
  if (vn >= 0) {
    return { rA, rB, vA: a.v, vB: b.v, normal, impulse: 0 };
  }
  const impulse = -((1 + restitution) * vn) / invM;
  const vA = sub(a.v, scale(normal, impulse * a.invMass));
  const vB = add(b.v, scale(normal, impulse * b.invMass));
  return { rA, rB, vA, vB, normal, impulse: Math.abs(impulse) };
}
