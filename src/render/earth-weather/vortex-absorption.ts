// 近づきすぎた渦の中心どうしの吸収。同じ半球で、自分より強い渦へ半径の和の 2 倍より近づいた
// 谷は、近さに応じて深さを削られる — 強い渦が弱い渦を呑む。効きは相手の配置を前後 ±窓 で
// 標本化して最強の 1 点を取るので、出会い・別れ・生まれ・消えのどの瞬間にも深さは跳ばない。
// 対象は中緯度の低気圧どうしだけでなく、熱帯の渦どうし・熱帯と中緯度のあいだも同じ規則で
// 扱う (`DEVELOP/SPEC/RENDERING.md`「近づきすぎた 2 つの渦の中心は併存しない」)。
import * as THREE from 'three/webgpu';
import type { PressurePlacement } from './tracks';

// 浅い側の深さを、半径の和に対する距離の近さで削る幅。半径の和へ届く前に浅い側の深さが
// ほぼ 0 になるよう、和の 2 倍から削り始めて 0.95 倍で消える形に取る — 近づく速さで深さの
// 変化が急にならないよう、帯の幅は千 km 級に保つ。
const ABSORB_FADE_START = 2.0;
const ABSORB_FADE_FULL = 0.95;
// 吸収の効きを見る時間窓の半幅 [s] と刻み [s]。相手の配置を前後 ±窓 で標本化して最強の効きを
// 取る — 相手が生まれても埋まっても、近い時刻が窓へ出入りするあいだ効きは ~1 日かけて逓増・
// 逓減するので、浅い側の深さが相手の消滅と同時に跳んで戻らない。
const ABSORB_WINDOW = 24 * 3600;
export const ABSORB_WINDOW_STEP = 3 * 3600;
// 窓の半幅に入る刻みの数。
export const ABSORB_WINDOW_STEPS = Math.round(ABSORB_WINDOW / ABSORB_WINDOW_STEP);
// 窓の標本の効きをなめらかな最大でたたむ鋭さ。大きいほど本物の最大に近づく — 小さすぎると
// 弱い標本の寄与が積み上がって遠くの相手でも浅い側を沈めてしまう。標本の入れ替わり(argmax
// の跳び)がそのまま深さの勾配の跳びになるので、隣り合う標本どうしを混ぜる程度に取る。
const ABSORB_SOFTMAX = 12;
// 標本ごとの「居る度」が生まれと消えの両端で 0→1 になるまでの時間 [s]。深さで見ると呑む側が
// 埋まる速さで効きが抜けるので、一生の両端への時間で見る — 寿命によらず一定の勾配になる。
const ABSORB_LIFE_RAMP = 12 * 3600;
// 標本ごとの効きが全強度になる、呑む側の深さ [hPa]。居る度がまだ低い生まれたて・消えかけの
// 低気圧でも、深さがこれ以上あれば半径の和の内側の浅い側を沈め切れる。深さへの立ち上がりを
// 緩く取る — 浅い門にすると、発達の速い低気圧が近くへ現れたときに効きがその発達の速さで立つ。
const ABSORB_FADE_DEPTH = 10;
// 標本ごとの効きに掛ける「相手の深さの比」の帯の下端。比 = 相手の深さ ÷ 自分の深さで、
// 1 以上(その時点で相手が深い)ならその標本の効きは全強度、この値を下回る(相手が浅い)と
// 効かない。あいだは帯で繋ぐ — 硬い門にすると深さの比の入れ替わりで標本の寄与が点灯・消灯
// して深さが跳ぶので、連続の重みにする。近い深さどうしは互いに削り合う(併合で勝つ側も
// 弱まる)形にもなる。
const ABSORB_DOMINANCE_BAND = 0.15;

// 吸収を考えない生の配置と、その「居る度」。吸収する側・される側の判定はその時点の深さで
// 行う — 最深(一生の山)で決めると、最深勝ちの消えかけの渦が、健在だが最深負けの相手を
// 沈めきれないまま、自分も誰にも吸収されずに残ってしまう。
export interface RawVortex {
  readonly placement: PressurePlacement;
  // 吸収の効きのための「居る度」0〜1。生まれと消えの両端で ABSORB_LIFE_RAMP かけて立ち上がる。
  readonly presence: number;
}

// 一生の中の位置 life(0..1)と寿命 lifetime [s] から「居る度」を答える — 生まれと消えの両端で
// 立ち上がり、真ん中では 1。どの種類の渦でも同じ式で作る。
export function vortexPresence(life: number, lifetime: number): number {
  return Math.min(1, Math.min(life, 1 - life) * lifetime / ABSORB_LIFE_RAMP);
}

// 渦 index の、吸収込みの配置。rawAt(j, k) は渦 j の時刻 +k 刻み(0 が現在)の生の配置を返す —
// 生の配置をその場で組むか表から引くかは呼び出し側が決める。同じ半球の渦どうしだけが効き合う
// (反対の半球の渦は赤道を越えて近づけない)。生まれる前と消えたあとは null。
export function absorbedVortexAt(
  index: number, vortexCount: number, surfaceRadius: number,
  rawAt: (index: number, offset: number) => RawVortex | null,
): PressurePlacement | null {
  const self = rawAt(index, 0);
  if (self === null) return null;
  // 吸収 — 近くの強い渦へ半径の和の 2 倍より近づいた谷は、近さに応じて深さを削る。効きは
  // 相手の配置を前後 ±窓 で標本化して最強の 1 点を取る — 相手の近い時刻が窓へ出入りする
  // あいだ効きは ~1 日かけて逓増・逓減するので、出会い・別れ・生まれ・消えのどの瞬間にも
  // 深さは跳ばない。各標本の効きはその時点での深さの比で重み付ける — 相手が深い標本ほど
  // 強く効き、比が入れ替わると窓の標本が端から順に効きを変えるので、入れ替わりの瞬間にも
  // 深さは跳ばない。
  const hemisphere = Math.sign(self.placement.latitude);
  let depth = self.placement.depth;
  for (let j = 0; j < vortexCount; j++) {
    if (j === index) continue;
    // 窓の標本の効きは、本物の最大をなめらかに近似した総和でたたむ — 最強の標本が隣の刻みへ
    // 移る瞬間にも効きは連続に移り、勾配が刻みの境で跳ばない。
    let softmax = 0;
    for (let k = -ABSORB_WINDOW_STEPS; k <= ABSORB_WINDOW_STEPS; k++) {
      const other = rawAt(j, k);
      if (other === null || Math.sign(other.placement.latitude) !== hemisphere) continue;
      // その標本の相手の深さと、現在の自分の深さの比で効きを重み付ける — 相手のほうが深い
      // (比が 1 を越える)標本は全強度で効き、帯を下回るほど相手が浅い標本は効かない。
      const share = self.placement.depth > 0
        ? other.placement.depth / self.placement.depth : 1;
      const weight = THREE.MathUtils.smoothstep(share, ABSORB_DOMINANCE_BAND, 1);
      if (weight <= 0) continue;
      const distance = greatCircleDistance(self.placement, other.placement, surfaceRadius);
      const edge = self.placement.radius + other.placement.radius;
      const fade = THREE.MathUtils.smoothstep(
        distance, edge * ABSORB_FADE_FULL, edge * ABSORB_FADE_START,
      );
      // 効きは近くて居る時刻が窓に入っているあいだ効き、出会いの前後 ~1 日に逓増・逓減がかかる。
      // 標本ごとの居る度は生まれ・消えで 0 へ逓減するので、相手が生まれた・埋まる瞬間にも効きは
      // 跳ばない — 呑む側の瞬間の深さを見ると、相手が埋まる速さで効きが抜けて抑えられていた側の
      // 深さが跳ぶ。帯の縁での効きは二乗で弱めて、総和で届きすぎないよう実効の帯をおおよそ
      // 1.4 倍までに留める。窓の端では 0 へ逓減。
      const taper = 0.5 + 0.5 * Math.cos(Math.PI * k / ABSORB_WINDOW_STEPS);
      const reach = (1 - fade) ** 2;
      // 居る度と現在の深さの強いほうを効きにする — 生まれたて・消えかけでも、深さがあれば
      // 半径の和の内側へ来た浅い谷をその時点で沈め切れる。
      const strength = Math.max(
        other.presence, Math.min(1, other.placement.depth / ABSORB_FADE_DEPTH),
      );
      softmax += Math.expm1(ABSORB_SOFTMAX * taper * strength * reach * weight);
    }
    if (softmax <= 0) continue;
    // 効きは総和の対数から — expm1/log1p の対で、効き 0 の標本は総和へ寄与しない。1 へ収まる
    // よう丸める — 複数の標本がほぼ最強で並ぶときの持ち上がりぶん。
    const grip = Math.min(1, Math.log1p(softmax) / ABSORB_SOFTMAX);
    depth *= 1 - grip;
  }
  return { ...self.placement, depth };
}

// 2 つの配置の中心の大圏距離 [m]。
function greatCircleDistance(
  a: PressurePlacement, b: PressurePlacement, surfaceRadius: number,
): number {
  const cosAngle = Math.sin(a.latitude) * Math.sin(b.latitude)
    + Math.cos(a.latitude) * Math.cos(b.latitude) * Math.cos(a.longitude - b.longitude);
  return surfaceRadius * Math.acos(Math.min(Math.max(cosAngle, -1), 1));
}
