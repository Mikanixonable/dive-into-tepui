// LTC(Linearly Transformed Cosines)による面光源の鏡面積分。係数表(ltc-table.ts)を
// 粗さと視線の傾きで引いて逆変換行列と正規化係数を取り、多角形の張る立体角の積分を
// 閉じた形で評価する。多角形は球光源を面積の一致する正 8 角形へ写して作る。
//
// 積分の式は three の RectAreaLightNode 内部の LTC_Evaluate と同じもの(Heitz らの
// Real-Time Polygonal-Light Shading with Linearly Transformed Cosines)。three はこれを
// 公開していないので、ここに 8 角形版として持つ。
import {
  Fn, abs, clamp, cross, dot, float, inverseSqrt, length, mat3, max, normalize, select,
  sqrt, vec2, vec3,
} from 'three/tsl';
import type { FloatNode, Mat3Node, Vec2Node, Vec3Node, Vec4Node } from '../../tsl-types';
import { LTC_TABLE_SIZE } from './ltc-table';

// 正 8 角形の外接半径 / 同じ面積の円の半径。8 角形の面積 2√2·ρ² を円の π·r² に合わせる。
const OCTAGON_RADIUS_SCALE = Math.sqrt(Math.PI / (2 * Math.SQRT2));

// 係数表を引く uv。表は sqrt(GGX α)(= 粗さ)と sqrt(1 − N·V) でパラメタ化されている。
export function ltcUv(normal: Vec3Node, viewDir: Vec3Node, roughness: FloatNode): Vec2Node {
  const scale = (LTC_TABLE_SIZE - 1) / LTC_TABLE_SIZE;
  const bias = 0.5 / LTC_TABLE_SIZE;
  const dotNV = clamp(dot(normal, viewDir), 0, 1);
  return vec2(roughness, sqrt(float(1).sub(dotNV))).mul(scale).add(bias);
}

// 係数表 1 の 1 サンプル(vec4)から逆変換行列を組む。
export function ltcInverseTransform(t1: Vec4Node): Mat3Node {
  return mat3(vec3(t1.x, 0, t1.y), vec3(0, 1, 0), vec3(t1.z, 0, t1.w));
}

// 単位球へ射影した多角形の辺 1 本ぶんのベクトル形状係数。θ/sinθ/2π の有理近似。
const edgeVectorFormFactor = Fn(([v1, v2]: readonly [Vec3Node, Vec3Node]) => {
  const x = dot(v1, v2);
  const y = abs(x).toVar();
  const a = y.mul(0.0145206).add(0.4965155).mul(y).add(0.8543985).toVar();
  const b = y.add(4.1616724).mul(y).add(3.4175940).toVar();
  const v = a.div(b);
  const thetaSintheta = select(
    x.greaterThan(0), v,
    inverseSqrt(max(float(1).sub(x.mul(x)), 1e-7)).mul(0.5).sub(v),
  );
  return cross(v1, v2).mul(thetaSintheta);
});

// 地平線で切られた球冠の形状係数(0..1)。ベクトル形状係数の和から閉じた近似で出す。
const clippedSphereFormFactor = Fn(([f]: readonly [Vec3Node]) => {
  const l = length(f);
  return max(l.mul(l).add(f.z).div(l.add(1)), 0);
});

// 多角形(頂点は view 空間、受け手から光源を見て反時計回り)の LTC 積分。戻り値は
// 地平線で切られた形状係数 0..1 で、放射輝度 × 正規化係数 × これ が鏡面照度になる。
// 辺の和は平衡木で畳む(左畳みの入れ子は WGSL のパーサが再帰上限に当たる)。
export function ltcEvaluate(
  normal: Vec3Node, viewDir: Vec3Node, position: Vec3Node, mInv: Mat3Node,
  points: readonly Vec3Node[],
): FloatNode {
  const t1 = normalize(viewDir.sub(normal.mul(dot(viewDir, normal))));
  const t2 = cross(normal, t1).negate();
  const transform = (mInv.mul(mat3(t1, t2, normal).transpose()) as unknown as Mat3Node).toVar();
  const projected = points.map((point) =>
    (normalize(transform.mul(point.sub(position)) as unknown as Vec3Node) as Vec3Node).toVar());
  const edges = projected.map((from, i) =>
    edgeVectorFormFactor(from, projected[(i + 1) % projected.length]!) as unknown as Vec3Node);
  return clippedSphereFormFactor(balancedSum(edges));
}

// ノードの列を 2 分木で足し合わせる。
function balancedSum(nodes: readonly Vec3Node[]): Vec3Node {
  if (nodes.length === 1) return nodes[0]!;
  const half = Math.ceil(nodes.length / 2);
  return balancedSum(nodes.slice(0, half)).add(balancedSum(nodes.slice(half)));
}

// 球光源(中心・半径、view 空間)を、受け手 position から見た輪郭円盤と同じ面積の
// 正 8 角形の頂点列(反時計回り)へ写す。輪郭円盤は中心方向へ d·cos²σ、半径 R·cosσ
// (sinσ = R/d)にあり、球と同じ視半径を張る。
export function sphereOctagonPoints(
  center: Vec3Node, radius: FloatNode, position: Vec3Node,
): readonly Vec3Node[] {
  const toCenter = center.sub(position);
  const distance = max(length(toCenter), 1e-6);
  const axis = toCenter.div(distance);
  const sinSigma = clamp(radius.div(distance), 0, 0.999999);
  const cosSigma = sqrt(float(1).sub(sinSigma.mul(sinSigma)));
  const diskCenter = position.add(axis.mul(distance.mul(cosSigma).mul(cosSigma)));
  const rho = radius.mul(cosSigma).mul(OCTAGON_RADIUS_SCALE);
  // 軸に直交する基底。軸が y に平行なときだけ種を x へ倒す。
  const seed = select(abs(axis.y).lessThan(0.99), vec3(0, 1, 0), vec3(1, 0, 0));
  const u = normalize(cross(seed, axis));
  const v = cross(axis, u);
  return Array.from({ length: 8 }, (_, k) => {
    const phi = (-2 * Math.PI * k) / 8;
    return diskCenter.add(u.mul(rho.mul(Math.cos(phi)))).add(v.mul(rho.mul(Math.sin(phi))));
  });
}
