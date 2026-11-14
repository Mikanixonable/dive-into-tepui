// 点から恒星へ向かう経路の、大気 1 体ぶんの幾何と、散乱係数 1 あたりの光学的厚みを出す式。
// 大気の描画(視線区間の透過率・内部散乱の積分)・直射光の透過率表・天空光表の焼き込みが
// **同じ経路式**を通るための共有場所 — どれかだけが変わると、薄明で大気と地表の明るさが
// 食い違う。扁平な天体では、極軸方向へ引き伸ばして真球へ写した空間で評価する。
// GPU で走る式は TSL、表を焼く側・テストが使う式は値版の孪生で、行対応で並べて持つ。
import {
  PI, abs, dot, exp, float, greaterThan, length, max, normalize, select, sqrt, sub,
} from 'three/tsl';
import type { FloatNode, Vec3Node } from '../tsl-types';

// 極半径/赤道半径の下限。潰し量はこの逆数なので、0 を塞ぐ。太陽系で最も扁平な土星でも 0.90。
export const MIN_POLAR_RATIO = 1e-3;

// 極半径/赤道半径から、真球への写像が極軸方向へ引き伸ばす量を取る。真球で 0。
export function polarStretchOf(polarRatio: number): number {
  return 1 / Math.max(polarRatio, MIN_POLAR_RATIO) - 1;
}

// ベクトルを、極軸方向へ引き伸ばして天体を真球にした空間へ写す。地表も大気の等密度面も
// この空間では中心を共有する球面になる。**この空間の長さは描画座標の長さではない** —
// 実寸として使う値は、その向きの伸び率で割ってから返すこと。
export function toSphereSpace(vector: Vec3Node, polarAxis: Vec3Node, polarStretch: FloatNode): Vec3Node {
  return vector.add(polarAxis.mul(dot(vector, polarAxis).mul(polarStretch)));
}

// 半径 r の点から天頂角余弦 mu(0 以上)の向きへ大気の外まで抜けるまでの、散乱係数 1 あたりの
// 光学的厚み。Chapman 関数を Ch0/((Ch0−1)·mu+1) で近似する — mu=1 で 1、mu=0 で √(πr/2H) と
// 両端で厳密値に一致し、その間を単調に埋める。
function outwardDepth(
  radius: FloatNode, mu: FloatNode, surfaceRadius: FloatNode, scaleHeight: FloatNode,
): FloatNode {
  const chapmanZero = sqrt(PI.mul(radius).div(scaleHeight).mul(0.5));
  const chapman = chapmanZero.div(chapmanZero.sub(1).mul(mu).add(1));
  return scaleHeight.mul(exp(surfaceRadius.sub(radius).div(scaleHeight))).mul(chapman);
}

// 半径 radius・天頂角余弦 mu の点から大気の外へ抜けるまでの、散乱係数 1 あたりの光学的厚み。
// 降る向き(mu<0)の経路は、最接近点で折り返す2本の上向きの経路として組み、最接近点が地表より
// 内側へ落ちる向きでは地表で打ち切る。**打ち切った値は、地平線を掠める経路の厚みの続きである**
// — 天体内部を貫通する直射日光の遮蔽は呼び出し側(大気積分の horizonVisibility、表面側の
// 影パス)が判定する。
//
// **どちらの枝も outwardDepth へ渡す余弦を非負に保つ** — select は選ばれない枝も評価するので、
// 負の余弦を通すと Chapman 近似の分母が 0 を跨ぎ、選ばれない側で無限大が湧く。
export function depthToSpace(
  radius: FloatNode, mu: FloatNode, surfaceRadius: FloatNode, scaleHeight: FloatNode,
): FloatNode {
  const ascending = outwardDepth(radius, abs(mu), surfaceRadius, scaleHeight);
  const perigee = max(radius.mul(sqrt(max(float(1).sub(mu.mul(mu)), 0))), surfaceRadius);
  const descending = outwardDepth(perigee, float(0), surfaceRadius, scaleHeight).mul(2).sub(ascending);
  return select(greaterThan(mu, 0), ascending, descending);
}

// 半径 radius・天頂角余弦 mu の点から、地表の上 [center−halfThickness, center+halfThickness]
// にある薄い層を通り抜けるまでの幾何学的な路長。層の密度形は問わず、殻の中を通る長さだけを
// 返す — 層内の密度の重みは係数側が畳み込む(テントなら層を通る長さに平均密度比を掛ける)。
// mu<0 の経路は depthToSpace と同じく、最接近点で折り返す2本として数える。
export function layerDepthValue(
  radius: number, mu: number, surfaceRadius: number,
  center: number, halfThickness: number,
): number {
  const perpSq = radius * radius * (1 - mu * mu);
  const inner = surfaceRadius + center - halfThickness;
  const outer = surfaceRadius + center + halfThickness;
  const innerSpan = Math.sqrt(Math.max(inner * inner - perpSq, 0));
  const outerSpan = Math.sqrt(Math.max(outer * outer - perpSq, 0));
  const descending = mu < 0;
  // 層の下からは両殻を順に抜ける長さ。層の中からは外殻までの長さから、内殻へ潜って戻る
  // 2 往復ぶんを引く(潜らない mu では内殻の項が 0 に潰れる)。層の上からは、降りる経路だけが
  // 内外の殻を 2 往復ぶん通る。
  const below = outerSpan - innerSpan;
  const inside = -radius * mu + outerSpan - (descending ? innerSpan * 2 : 0);
  const above = descending ? (outerSpan - innerSpan) * 2 : 0;
  return radius < inner ? below : radius < outer ? inside : above;
}

// 大気を持つ天体 1 体ぶんの、太陽方向の経路を真球空間で引くための幾何。値は TSL ノードで受ける。
// **光学係数はここには置かない** — 経路の消衰は、透過率表(sun-transmittance-tables.ts)が
// 焼き込み側でこの幾何の値版を使って評価する。
export interface SunPathAtmosphere {
  readonly center: Vec3Node;
  readonly surfaceRadius: FloatNode;
  readonly polarAxis: Vec3Node;
  readonly polarStretch: FloatNode;
}

// 点(描画座標)から恒星の位置(描画座標)へ向かう経路の、真球空間での形。
export interface SunPathGeometry {
  // 天体中心から点へのベクトル(真球空間)と、その長さ。大気が無い真空中でも 1 の床を張る。
  readonly offset: Vec3Node;
  readonly radius: FloatNode;
  // 点から恒星へのベクトル(描画座標)。
  readonly toSun: Vec3Node;
  // 恒星の天頂角余弦。
  readonly sunMu: FloatNode;
  // 真球空間の長さを実寸へ戻す係数。
  readonly sunPathScale: FloatNode;
}

// 点から恒星へ向かう経路の形を、大気を持つ天体の真球空間で引く。
export function sunPathGeometry(
  point: Vec3Node, sunPosition: Vec3Node, atmosphere: SunPathAtmosphere,
): SunPathGeometry {
  const offset = toSphereSpace(
    sub(point, atmosphere.center), atmosphere.polarAxis, atmosphere.polarStretch,
  );
  const radius = max(length(offset), max(atmosphere.surfaceRadius, float(1)));
  const toSun = sub(sunPosition, point);
  const stretchedToSun = toSphereSpace(toSun, atmosphere.polarAxis, atmosphere.polarStretch);
  const sunMu = dot(offset.div(radius), normalize(stretchedToSun));
  // 厚みは引き伸ばした空間の長さで出るので、その向きの伸び率で実寸へ戻す。
  const sunPathScale = max(length(toSun), 1).div(max(length(stretchedToSun), 1));
  return { offset, radius, toSun, sunMu, sunPathScale };
}

// 三角テントの密度の、ピークに対する平均の比。層を通る幾何学的な路長に掛けて、
// ピーク密度での係数が受ける実効の厚みに直す。
export const TENT_MEAN_DENSITY = 0.5;

// ---- 値版(焼き込みとテストが使う) -------------------------------------------

// outwardDepth の値版。式は TSL 版と同じ(対応が崩れたら焼く表と GPU の絵が食い違う)。
export function outwardDepthValue(
  radius: number, mu: number, surfaceRadius: number, scaleHeight: number,
): number {
  const chapmanZero = Math.sqrt(Math.PI * radius / scaleHeight * 0.5);
  const chapman = chapmanZero / ((chapmanZero - 1) * mu + 1);
  return scaleHeight * Math.exp((surfaceRadius - radius) / scaleHeight) * chapman;
}

// depthToSpace の値版。式は TSL 版と同じ。
export function depthToSpaceValue(
  radius: number, mu: number, surfaceRadius: number, scaleHeight: number,
): number {
  const ascending = outwardDepthValue(radius, Math.abs(mu), surfaceRadius, scaleHeight);
  if (mu > 0) return ascending;
  const perigee = Math.max(radius * Math.sqrt(Math.max(1 - mu * mu, 0)), surfaceRadius);
  return outwardDepthValue(perigee, 0, surfaceRadius, scaleHeight) * 2 - ascending;
}
