// 天体の木への問い合わせ。フォーカス中の天体がどの系に属するか、カメラがいまどの系にいるかを、
// 親子関係と重力の効き方から答える。可視性・選択候補・一覧の並びがここを共有する。
import { attractorAccel, strongestAttractor } from '../../physics/attractor';
import type { CelestialMotion } from '../../physics/celestial-motion';
import { Vec3, lenSq } from '../../math/vec3';
import type { CelestialClass } from './celestial-entity/celestial-entity-def';

export type CelestialClassLookup = (id: string) => CelestialClass;

export function motionById(motions: readonly CelestialMotion[]): ReadonlyMap<string, CelestialMotion> {
  return new Map(motions.map((m) => [m.id, m]));
}

export function sameSystemIds(motions: readonly CelestialMotion[], focusId: string | undefined): ReadonlySet<string> {
  if (focusId === undefined) return new Set();
  const parent = motions.find((m) => m.id === focusId)?.primary?.id ?? null;
  const ids = new Set<string>([focusId]);
  if (parent !== null) ids.add(parent);
  for (const m of motions) {
    const p = m.primary?.id ?? null;
    if (p === focusId || (parent !== null && p === parent)) ids.add(m.id);
  }
  return ids;
}

// focus 天体と同じ惑星系に、position の主引力天体が属するかを返す。衛星をフォーカス
// した場合は親惑星を系の代表として扱い、親惑星周回・フォーカス衛星周回・同じ惑星の
// 別衛星周回をすべて含める。地球をフォーカスしている間は地球周回と月周回を含み、
// 土星周回のような別の惑星系は除く。画面上の遮蔽やカメラ距離では判定しないため、地球の
// 裏側に回った機体も引き続き対象になる。
//
// 天体以外(艦船・固定点など)へフォーカスしている場合は、どの天体系を表示するかを恣意的に
// 決めないため絞り込まない。これにより、対象艦へフォーカスした瞬間に他艦が消えない。
export function isPositionInFocusedSystem(
  motions: readonly CelestialMotion[],
  focusId: string | undefined,
  position: Vec3,
  celestialBodies: readonly CelestialMotion[],
  pivot: number,
): boolean {
  const byId = motionById(motions);
  const focus = focusId === undefined ? undefined : byId.get(focusId);
  if (focus === undefined) return true;

  const systemFocusId = focus.kind === 'satellite' ? focus.primary?.id ?? null : focus.id;
  const initial = strongestAttractor(position, celestialBodies, pivot).id;
  // 太陽を直接周回中でどの惑星系にも属さない対象は、どの惑星がフォーカスされていても常に含める。
  if (byId.get(initial)?.kind === 'star') return true;
  let current: string | null = initial;
  // 壊れた親子定義でも停止するよう、登録数を上限にする。
  for (let i = 0; current !== null && i <= motions.length; i++) {
    if (current === systemFocusId) return true;
    const m: CelestialMotion | undefined = byId.get(current);
    if (m === undefined) return false;
    current = m.primary?.id ?? null;
  }
  return false;
}

// focus の親を辿って主星まで遡った id の列(focus 自身を含む)。
export function ancestorsOf(byId: ReadonlyMap<string, CelestialMotion>, focusId: string): string[] {
  const chain: string[] = [];
  let cur: string | null = focusId;
  // 循環した親子定義でも止まるよう、登録数を上限にする。
  for (let i = 0; cur !== null && i <= byId.size; i++) {
    if (chain.includes(cur)) break;
    chain.push(cur);
    cur = byId.get(cur)?.primary?.id ?? null;
  }
  return chain;
}

// cameraPos で最も強く重力を及ぼす天体から主星まで遡った id の列(その天体自身を含む)。
// 最寄り天体が registry に未登録(生存中の重力天体)なら、その id 1つだけを返す。
export function systemChainAt(
  motions: readonly CelestialMotion[], cameraPos: Vec3,
  celestialBodies: readonly CelestialMotion[], pivot: number,
): readonly string[] {
  if (celestialBodies.length === 0) return [];
  const nearest = strongestAttractor(cameraPos, celestialBodies, pivot).id;
  return chainFromNearest(motionById(motions), nearest);
}

function chainFromNearest(byId: ReadonlyMap<string, CelestialMotion>, nearest: string): readonly string[] {
  if (!byId.has(nearest)) return [nearest];
  return ancestorsOf(byId, nearest);
}

// chain の列に、各天体の子(恒星の子は除く)を合わせた集合。近い順・各天体→その子の順に並ぶ
// 配列で返す(呼び出し側の選択肢が毎フレーム揺れないよう順序を固定する)。恒星の子は足さない
// — 足すと太陽を含む列で全惑星が並んでしまうため。
function membersFromChain(
  motions: readonly CelestialMotion[], byId: ReadonlyMap<string, CelestialMotion>, chain: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of chain) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
    if ((byId.get(id)?.primary ?? null) === null) continue;
    for (const child of motions) {
      if (seen.has(child.id) || (child.primary?.id ?? null) !== id) continue;
      seen.add(child.id);
      result.push(child.id);
    }
  }
  return result;
}

// systemChainAt の列に、各天体の子(恒星の子は除く)を合わせた集合。
export function systemMembersAt(
  motions: readonly CelestialMotion[], cameraPos: Vec3,
  celestialBodies: readonly CelestialMotion[], pivot: number,
): readonly string[] {
  return membersFromChain(
    motions, motionById(motions), systemChainAt(motions, cameraPos, celestialBodies, pivot));
}

// strongestAttractor をそのまま「いまいる系」の判定に使うと、勢力圏が極端に狭い天体(主星から
// 極端に近い衛星など)ではフレームごとの浮動小数点誤差やカメラの微小な移動だけで最強天体が
// 入れ替わり、系のラベルが明滅する(MAP.md 4節)。このトラッカーは直前フレームの勝者を
// STICKY_MARGIN_SQ 倍まで有利に扱い、新しい候補が明確に優勢でない限り系を切り替えない。
// per-frame で呼ぶ側(FocusMarkers・MapPickables など)がインスタンスを保持して使うこと。
const STICKY_MARGIN_SQ = 1.2 * 1.2;

export class NearbySystemTracker {
  private previousId: string | null = null;

  chainAt(
    motions: readonly CelestialMotion[], cameraPos: Vec3,
    celestialBodies: readonly CelestialMotion[], pivot: number,
  ): readonly string[] {
    if (celestialBodies.length === 0) return [];
    const nearest = this.pickNearest(cameraPos, celestialBodies, pivot);
    this.previousId = nearest;
    return chainFromNearest(motionById(motions), nearest);
  }

  membersAt(
    motions: readonly CelestialMotion[], cameraPos: Vec3,
    celestialBodies: readonly CelestialMotion[], pivot: number,
  ): readonly string[] {
    return membersFromChain(
      motions, motionById(motions), this.chainAt(motions, cameraPos, celestialBodies, pivot));
  }

  private pickNearest(
    cameraPos: Vec3, celestialBodies: readonly CelestialMotion[], pivot: number,
  ): string {
    const best = strongestAttractor(cameraPos, celestialBodies, pivot);
    if (this.previousId === null || this.previousId === best.id) return best.id;
    const previous = celestialBodies.find((a) => a.id === this.previousId);
    if (previous === undefined) return best.id;
    const bestAccel = lenSq(attractorAccel(cameraPos, best, pivot, pivot));
    const prevAccel = lenSq(attractorAccel(cameraPos, previous, pivot, pivot));
    return bestAccel > prevAccel * STICKY_MARGIN_SQ ? best.id : previous.id;
  }
}
