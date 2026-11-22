// 位置 r における日照率。天体暦(いつどこにいるか)ではなく、pivot で引いた各天体の位置と
// 半径から求める幾何。恒星・影を落とす天体をともに球とみなし、
// r から見た太陽円盤とその天体の円盤の重なり面積比で減光率を出す — 本影(重なり=太陽円盤全体)・
// 金環(天体の円盤が太陽円盤に内包)・半影(部分的に重なる)・完全日照(重なり無し)が場合分け
// 無しに1つの閉じた式から出る。
//
// 多数の位置で同じ区間の日照率を引くときは ShadowCasters を使う。影を落としえない天体を保守的な
// 幾何で先に除くだけで、値は全天体を走査した sunlitFactor と一致する。
import { distSq, type Vec3 } from '../math/vec3';
import type { CelestialBody } from './celestial-body';
import type { KinematicState } from './kinematic-state';

// 2円(半径 r1, r2、中心距離 d、すべて同じ角度単位)の交差面積。
function circleOverlapArea(r1: number, r2: number, d: number): number {
  if (d >= r1 + r2) return 0;
  if (d <= Math.abs(r1 - r2)) return Math.PI * Math.min(r1, r2) ** 2;
  const d1 = (d * d - r2 * r2 + r1 * r1) / (2 * d);
  const d2 = d - d1;
  const clampAcos = (x: number) => Math.acos(Math.min(1, Math.max(-1, x)));
  return (
    r1 * r1 * clampAcos(d1 / r1) - d1 * Math.sqrt(Math.max(0, r1 * r1 - d1 * d1)) +
    r2 * r2 * clampAcos(d2 / r2) - d2 * Math.sqrt(Math.max(0, r2 * r2 - d2 * d2))
  );
}

// r から見た太陽円盤のうち body に遮られていない面積比(0..1)。sunDir は太陽方向の単位
// ベクトルを成分で、sinSunAng は sin(sunAngRadius)。毎ステップ全エンティティぶん、天体の
// 数だけ走る経路なので、中間の Vec3 を作らずスカラで畳む。
function shadowedFraction(
  r: Vec3,
  sunDirX: number, sunDirY: number, sunDirZ: number,
  sunDist: number, sinSunAng: number, sunAngRadius: number,
  body: CelestialBody, pivot: number, t: number = pivot,
): number {
  if (body.kind === 'star' || body.def.radius <= 0) return 1; // 恒星自身・半径0の天体は影を落とさない
  const b = body.positionAt(pivot, t);
  const dx = b.x - r.x, dy = b.y - r.y, dz = b.z - r.z;
  const along = dx * sunDirX + dy * sunDirY + dz * sunDirZ;
  if (along <= 0 || along >= sunDist) return 1; // 艦より太陽から遠い側/背後にある天体は影を落とさない
  const distSq = dx * dx + dy * dy + dz * dz;
  const dist = Math.sqrt(distSq);
  if (dist <= body.def.radius) return 0; // 天体の内側なら太陽は見えない
  // 太陽線からの垂直距離が両円盤の視半径の和を超えていれば、重なりようがない。sin は
  // [0, π/2] で劣加法的(sin(a+b) ≤ sin a + sin b)なので、sin で測ったまま比べれば
  // 逆三角関数を通さずに安全側で落とせる — along > 0 なので離角は π/2 未満。
  const reach = sinSunAng * dist + body.def.radius;
  if (distSq - along * along > reach * reach) return 1;
  // LEO のように天体のすぐ近くでは R/d が 1 に近づくので、視半径は asin を取る
  // (小角近似のままだと地球の影の境界が数十度ずれる)。
  const bodyAngRadius = Math.asin(body.def.radius / dist);
  const sep = Math.acos(Math.min(1, Math.max(-1, along / dist)));
  const overlap = circleOverlapArea(sunAngRadius, bodyAngRadius, sep);
  return 1 - overlap / (Math.PI * sunAngRadius * sunAngRadius);
}

// r のまわりへ body が落としうる影の濃さの上限 0..1。両円盤が最も都合よく重なったとき —
// すなわち視半径の比の二乗(天体の円盤が恒星円盤を覆いきるなら 1)— を返すので、**この値が
// 小さい天体は、r のまわりのどこにも絵に出るほどの影を落とせない。**
//
// 上限は r と body の距離だけで決まる。r から見て body が恒星の手前にあるかどうかで値が
// 変わると、body 自身の夜側のように影の落ちた先が見えている位置関係でも 0 になってしまう。
// 恒星自身と半径 0 の天体は影を落とさず、天体の内側からは恒星が完全に隠れる。
export function maxShadowedFraction(
  r: Vec3, star: CelestialBody, body: CelestialBody, pivot: number,
): number {
  if (body.kind === 'star' || body.def.radius <= 0) return 0;
  const s = star.positionAt(pivot);
  const tx = s.x - r.x, ty = s.y - r.y, tz = s.z - r.z;
  const sunDist = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (sunDist < 1) return 0; // 位置が恒星に一致(退化)
  const b = body.positionAt(pivot);
  const dx = b.x - r.x, dy = b.y - r.y, dz = b.z - r.z;
  const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (dist <= body.def.radius) return 1;
  const occAngRadius = Math.asin(body.def.radius / dist);
  const sunAngRadius = Math.asin(Math.min(1, star.def.radius / sunDist));
  return Math.min(1, (occAngRadius / sunAngRadius) ** 2);
}

// 位置 r における日照率 0..1。celestialBodies は影を落としうる全天体(恒星自身は無視する)。
// 複数天体の影は各々の減光率の積で合成する — 2天体が同時に太陽面へ重なって
// 掩蔽し合う状況は現実的に起きないため、重なり領域を厳密に扱うより素直な近似とした。
export function sunlitFactor(
  r: Vec3, star: CelestialBody, celestialBodies: readonly CelestialBody[], pivot: number,
  t: number = pivot,
): number {
  const s = star.positionAt(pivot, t);
  const tx = s.x - r.x, ty = s.y - r.y, tz = s.z - r.z;
  const sunDist = Math.sqrt(tx * tx + ty * ty + tz * tz);
  if (sunDist < 1) return 1; // 位置が恒星に一致(退化)
  const inv = 1 / sunDist;
  const sinSunAng = Math.min(1, star.def.radius / sunDist);
  const sunAngRadius = Math.asin(sinSunAng);

  let lit = 1;
  for (const body of celestialBodies) {
    lit *= shadowedFraction(
      r, tx * inv, ty * inv, tz * inv, sunDist, sinSunAng, sunAngRadius, body, pivot, t);
    if (lit === 0) return 0; // 本影に入った時点で、以降の天体を見ても答えは変わらない
  }
  return Math.min(1, Math.max(0, lit));
}

// 浮動小数の丸めへの余裕(相対)。shadowedFraction は垂直距離の2乗を distSq − along² で出すので、
// 大きな距離では桁落ちで距離の2乗の数 ulp ずれる。ここで落とす天体はその誤差を見込んでもなお影を落とせない
// ものに限る。
const SHADOW_CULL_ROUNDING = 1e-12;

// 個体の近傍へ絞り込む範囲の下限 [m]。止まった個体でも、1歩の加速ぶんの移動を収める。
const NEAR_REACH_FLOOR = 1;

// 候補1体の、区間の基準時刻 pivot における位置と、区間内でそこから動きうる距離の上限 [m]。
interface Located {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly drift: number;
}

interface ShadowCaster extends Located {
  readonly body: CelestialBody;
}

// pivot で引いた位置と、区間 [tStart, tEnd] でそこから動きうる距離の上限。positionAt(pivot, t) は
// pivot からの2次の外挿なので、両端の変位の和が区間内のどの時刻の変位も上から抑える。
function locate(body: CelestialBody, pivot: number, tStart: number, tEnd: number): Located {
  const p = body.positionAt(pivot);
  const a = body.positionAt(pivot, tStart);
  const b = body.positionAt(pivot, tEnd);
  const drift = Math.hypot(a.x - p.x, a.y - p.y, a.z - p.z) + Math.hypot(b.x - p.x, b.y - p.y, b.z - p.z);
  return { x: p.x, y: p.y, z: p.z, drift };
}

// 中心 center から reach 以内の位置を、区間内のどの時刻でも照らす太陽の幾何。候補ごとの判定で
// 共通の部分を1度だけ解く。sunDistLow が正でなければ、太陽が範囲に入りうるので何も除けない。
interface SunView {
  readonly cx: number;
  readonly cy: number;
  readonly cz: number;
  readonly reach: number;
  readonly ux: number;
  readonly uy: number;
  readonly uz: number;
  readonly sunDistLow: number;
  readonly sinSunAngHigh: number;
  // 太陽線が範囲内で動きうる距離 [m]。
  readonly lineShift: number;
}

function sunViewOf(center: Vec3, reach: number, sun: Located, sunRadius: number): SunView {
  const sx = sun.x - center.x, sy = sun.y - center.y, sz = sun.z - center.z;
  const sunDist = Math.sqrt(sx * sx + sy * sy + sz * sz);
  const sunDistLow = sunDist - reach - sun.drift;
  return {
    cx: center.x, cy: center.y, cz: center.z, reach,
    ux: sx / sunDist, uy: sy / sunDist, uz: sz / sunDist,
    sunDistLow, sinSunAngHigh: Math.min(1, sunRadius / sunDistLow), lineShift: reach + sun.drift,
  };
}

// view の範囲のどの位置 r でも、区間内のどの時刻でも、caster が shadowedFraction で 1 以外を
// 返しうるか。偽なら、その範囲の日照率の積から caster を除いても値は1ビットも変わらない。
//
// shadowedFraction が影の幾何へ進むのは、天体が r と太陽の間にあり(along > 0)、太陽線からの垂直
// 距離が sinSunAng·dist + R 以下のときだけ。r・天体・太陽をそれぞれ reach・drift ぶん動かしたとき、
// 太陽線は区間 [r, s] の上でどこも reach + sunDrift 以内しか動かないので、垂直距離は
// ε = reach + sunDrift + drift 以上は縮まない。along は天体と r の移動に加え、太陽方向の回転ぶん
// (距離 × 2(reach + sunDrift)/太陽距離)しか増えない。
function mayShadowNear(view: SunView, caster: ShadowCaster): boolean {
  const { reach, ux, uy, uz, sunDistLow, lineShift } = view;
  if (!(sunDistLow > 0)) return true;
  const bx = caster.x - view.cx, by = caster.y - view.cy, bz = caster.z - view.cz;
  const dist = Math.sqrt(bx * bx + by * by + bz * bz);
  // 太陽線上で天体の足が区間 [r, s] から caster.drift ぶんはみ出す分も、線の移動に含める。
  const eps = lineShift + caster.drift + caster.drift * lineShift / sunDistLow;
  const rounding = SHADOW_CULL_ROUNDING * (dist + eps);
  // 天体が r より太陽から遠い側にしかいられない。
  const along = bx * ux + by * uy + bz * uz;
  const alongHigh = along + reach + caster.drift + (dist + reach + caster.drift) * 2 * lineShift / sunDistLow;
  if (alongHigh + rounding < 0) return false;
  // 太陽線から、太陽円盤と天体円盤の視半径の和より遠くにしかいられない。垂直距離は外積で
  // 打ち消しなく求める。
  const px = by * uz - bz * uy, py = bz * ux - bx * uz, pz = bx * uy - by * ux;
  const perpLow = Math.sqrt(px * px + py * py + pz * pz) - eps - rounding;
  if (perpLow <= 0) return true;
  const reachHigh = view.sinSunAngHigh * (dist + reach + caster.drift) + caster.body.def.radius;
  // 2乗どうしの比較なので、丸めの余裕も距離の2乗に比例させる。
  return perpLow * perpLow <= reachHigh * reachHigh + SHADOW_CULL_ROUNDING * (dist + eps) ** 2;
}

// 個体の近傍へ絞る前に、まず絞っておく広い範囲の半径 [m]。交戦圏(半径 30 km)に集まった個体が
// 1つの範囲に収まり、個体ごとの判定が全天体ではなくその範囲の候補(ふつう数体)だけを見るで済む。
const REGION_RADIUS = 1e5;
// 区間ごとに持つ広い範囲の数の上限。散らばった個体が範囲を作り続けても走査が伸びないようにする。
const REGION_CACHE_SIZE = 8;

// 1区間のあいだ影を落としうる天体の候補と、その上での日照率。
//
// 日照率は全天体の減光率の積なので、影を落としえない天体(shadowedFraction が厳密に 1)を除いても
// 値は変わらない。毎ステップ全個体ぶん全天体を走査する費用を、区間に1度の分類と、個体の近傍への
// 絞り込み(near)で、影を落としうる数体の走査へ縮める。**除く判定は保守的な幾何だけで、近似は無い。**
// 絞り込んだ候補の外の位置を問われたら、絞り込む前の候補で答える。
export class ShadowCasters {
  // near が使い回す広い範囲(中心と、そのまわり REGION_RADIUS 以内の候補)。区間の中だけで有効な
  // キャッシュ。
  private readonly regions: { readonly center: Vec3; readonly casters: ShadowCasters }[] = [];

  // bodies は候補の天体。domain は候補が有効な範囲と、その外の位置を答える絞り込む前の候補で、
  // null なら全域で有効。
  private constructor(
    private readonly star: CelestialBody | null,
    private readonly sun: Located | null,
    private readonly pivot: number,
    private readonly casters: readonly ShadowCaster[],
    private readonly bodies: readonly CelestialBody[],
    private readonly domain: {
      readonly center: Vec3; readonly reach: number; readonly parent: ShadowCasters;
    } | null,
  ) {}

  // star が照らし bodies が影を落とす区間 [tStart, tEnd] の候補を、pivot で位置を引いて組む。恒星自身と
  // 半径 0 の天体は影を落とさないので候補に入れない。star が null なら日照率は恒等的に 0。
  public static classify(
    star: CelestialBody | null, bodies: readonly CelestialBody[], pivot: number, tStart: number, tEnd: number,
  ): ShadowCasters {
    if (star === null) return new ShadowCasters(null, null, pivot, [], [], null);
    const casters: ShadowCaster[] = [];
    for (const body of bodies) {
      if (body.kind === 'star' || body.def.radius <= 0) continue;
      casters.push({ body, ...locate(body, pivot, tStart, tEnd) });
    }
    return new ShadowCasters(
      star, locate(star, pivot, tStart, tEnd), pivot, casters, casters.map((c) => c.body), null,
    );
  }

  // state から dt [s] の1歩を積分する個体の近傍で影を落としうる候補だけに絞る。範囲は1歩で動く
  // 見込み(速さ × dt の倍)で、外れた位置は絞り込む前の候補で答えるので、範囲は正しさに関わらず
  // 速さだけを左右する。
  public near(state: KinematicState, dt: number): ShadowCasters {
    const { x, y, z } = state.v;
    const reach = 2 * Math.sqrt(x * x + y * y + z * z) * Math.abs(dt) + NEAR_REACH_FLOOR;
    const source = reach <= REGION_RADIUS ? this.regionAround(state.r, reach) : this;
    return source.narrowed(state.r, reach, this);
  }

  // 区間内の時刻 t、位置 r における日照率 0..1。全天体を走査した sunlitFactor と同じ値を返す。
  public sunlitAt(r: Vec3, t: number): number {
    if (this.star === null) return 0;
    const domain = this.domain;
    if (domain !== null && distSq(r, domain.center) > domain.reach * domain.reach) {
      return domain.parent.sunlitAt(r, t);
    }
    return sunlitFactor(r, this.star, this.bodies, this.pivot, t);
  }

  // center から reach 以内の位置を包む広い範囲の候補。無ければ center のまわりに作って覚える。
  private regionAround(center: Vec3, reach: number): ShadowCasters {
    for (const region of this.regions) {
      if (Math.sqrt(distSq(center, region.center)) + reach <= REGION_RADIUS) return region.casters;
    }
    const casters = this.narrowed(center, REGION_RADIUS, this);
    if (this.regions.length >= REGION_CACHE_SIZE) this.regions.shift();
    this.regions.push({ center, casters });
    return casters;
  }

  // 自分の候補のうち、center から reach 以内で影を落としうるものだけの候補。範囲の外の位置は
  // fallback が答える。自分の範囲に収まる範囲でだけ呼ぶ。
  private narrowed(center: Vec3, reach: number, fallback: ShadowCasters): ShadowCasters {
    if (this.star === null || this.sun === null) return this;
    const view = sunViewOf(center, reach, this.sun, this.star.def.radius);
    const casters: ShadowCaster[] = [];
    for (const caster of this.casters) {
      if (mayShadowNear(view, caster)) casters.push(caster);
    }
    return new ShadowCasters(
      this.star, this.sun, this.pivot, casters, casters.map((c) => c.body),
      { center, reach, parent: fallback },
    );
  }
}
