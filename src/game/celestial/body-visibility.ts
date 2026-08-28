// マップ上で「いま関心の対象になっている天体」の判定。マップのラベル・配置UIの基準天体は、
// この1つの集合を共有して表示を絞る — 2つが別々のフィルタを持つと「マップには出ているのに
// 基準天体の選択肢に無い」が起き、探しているものへ辿り着く道筋が読めなくなる。軌道オブジェクト
// 一覧も同じ MapVisibilityPolicy を経由し、表示設定と選択候補の食い違いを防ぐ。
// 可視性・選択候補はいずれもフォーカス天体という離散的な状態からの親子関係で決める(ズーム
// 距離のような連続量で判定すると操作の途中で行が明滅する)。systemChainAt だけはカメラ位置
// という連続量から系の呼び名を導く — 表示を絞る判定ではなく、いまいる場所の説明であるため。
import { CelestialBody, attractorAccel, strongestAttractor } from '../../physics/celestial-body';
import type { CelestialMotion } from '../../physics/celestial-motion';
import { Vec3, lenSq } from '../../math/vec3';
import type { BodyClass } from './celestial-entity-def';

// 天体 id の表示クラスを引く口。フォーカス id は艦など未登録の id でもありうるので、
// **未登録 id には既定の 'planet' を返すこと**(例外にしない)。
// このモジュールは tests が node で実行するため、THREE を経由する型を直接受け取れない —
// 天体の列挙・親子関係は motions(参照の木)で、表示クラスはこの写像で受ける。
export type BodyClassLookup = (id: string) => BodyClass;

function motionById(motions: readonly CelestialMotion[]): ReadonlyMap<string, CelestialMotion> {
  return new Map(motions.map((m) => [m.id, m]));
}

// クラスごとの表示トグル。恒星は常に見えるのでトグルを持たない(太陽系の基準点であり、
// 消えると現在地が読めなくなる)。Name(マーカーの点+ラベル)と Orbit(軌道線)は保存上は別の
// boolean のまま保つが、表示パネルでは「ラベル+軌道 / ラベル / 非表示」の1ボタンへまとめる。
// satellite の Orbit はこのトグルに加えて、フォーカス中の系かどうかという条件も AND で効く
// (map-visibility.ts の MapVisibilityPolicy)。lagrange は天体ではなく軌道概念も無いので、
// UI では「ラベル / 非表示」の2状態になる。
export type BodyClassToggles = {
  readonly planetVisible: boolean;
  readonly planetOrbit: boolean;
  readonly planetName: boolean;
  readonly dwarfVisible: boolean;
  readonly dwarfOrbit: boolean;
  readonly dwarfName: boolean;
  readonly satelliteVisible: boolean;
  readonly satelliteName: boolean;
  readonly satelliteOrbit: boolean;
  readonly smallBodyVisible: boolean;
  readonly smallBodyOrbit: boolean;
  readonly smallBodyName: boolean;
  readonly lagrangeVisible: boolean;
  readonly lagrangeName: boolean;
  readonly playerVisible: boolean;
  readonly playerName: boolean; readonly playerOrbit: boolean;
  readonly shipVisible: boolean;
  readonly shipName: boolean; readonly shipOrbit: boolean;
  readonly ammoVisible: boolean;
  readonly ammoName: boolean; readonly ammoOrbit: boolean;
  readonly fuelVisible: boolean;
  readonly fuelName: boolean; readonly fuelOrbit: boolean;
  readonly baseVisible: boolean;
  readonly baseName: boolean; readonly baseOrbit: boolean;
};

export type BodyClassDisplayMode = 'orbit' | 'label' | 'hidden';

// 軌道線(Orbit)は面積を食う——全登録天体ぶん描くと内側太陽系がその天体の軌道線で埋まる
// ため、数の多いクラス(dwarf・smallBody・satellite)は既定 off にする。planet だけは数が
// 少なく太陽系の骨格をなすので軌道線まで既定 on。一方 Name は focus-markers.ts の混雑抑制
// (画面上で近すぎるラベルを間引く)が効くので溢れる心配が無く、planet と同様 dwarf・
// smallBody・satellite も既定 on にする。lagrange は力学的に意味を持つ点(共線点の余裕・
// 三角点の安定性を満たすもの)だけに絞り込まれていて同じ懸念が当たらないため、既定 on にする。
export const DEFAULT_BODY_CLASS_TOGGLES: BodyClassToggles = {
  planetVisible: true,
  planetOrbit: true, planetName: true,
  dwarfVisible: true,
  dwarfOrbit: false, dwarfName: true,
  satelliteVisible: true,
  satelliteName: true, satelliteOrbit: true,
  smallBodyVisible: true,
  smallBodyOrbit: false, smallBodyName: true,
  lagrangeVisible: true,
  lagrangeName: true,
  playerVisible: true,
  playerName: true, playerOrbit: true,
  shipVisible: true,
  shipName: true, shipOrbit: true,
  ammoVisible: true,
  ammoName: true, ammoOrbit: false,
  fuelVisible: true,
  fuelName: true, fuelOrbit: false,
  baseVisible: true,
  baseName: true, baseOrbit: true,
};

// 各クラスの「クラス全体」トグルと、その配下にある子トグル(ラベル・軌道線)の対応。
// 表示パネルのボタン構成もこの表を正本として組み立て、UI 側で別の対応関係を持たない。
// 子トグルは1つでもONならクラス全体を自動でONにし、全てOFFになれば自動でOFFにする
// (applyBodyClassToggle/normalizeBodyClassToggles)。lagrange は軌道という概念自体が
// 無いため children はラベルのみ。
interface BodyClassCategory {
  readonly category: keyof BodyClassToggles;
  readonly name: keyof BodyClassToggles;
  readonly orbit: keyof BodyClassToggles | null;
  readonly children: readonly (keyof BodyClassToggles)[];
}

const BODY_CLASS_CATEGORIES: readonly BodyClassCategory[] = [
  { category: 'planetVisible', name: 'planetName', orbit: 'planetOrbit', children: ['planetName', 'planetOrbit'] },
  { category: 'dwarfVisible', name: 'dwarfName', orbit: 'dwarfOrbit', children: ['dwarfName', 'dwarfOrbit'] },
  { category: 'satelliteVisible', name: 'satelliteName', orbit: 'satelliteOrbit', children: ['satelliteName', 'satelliteOrbit'] },
  { category: 'smallBodyVisible', name: 'smallBodyName', orbit: 'smallBodyOrbit', children: ['smallBodyName', 'smallBodyOrbit'] },
  { category: 'lagrangeVisible', name: 'lagrangeName', orbit: null, children: ['lagrangeName'] },
  { category: 'playerVisible', name: 'playerName', orbit: 'playerOrbit', children: ['playerName', 'playerOrbit'] },
  { category: 'shipVisible', name: 'shipName', orbit: 'shipOrbit', children: ['shipName', 'shipOrbit'] },
  { category: 'ammoVisible', name: 'ammoName', orbit: 'ammoOrbit', children: ['ammoName', 'ammoOrbit'] },
  { category: 'fuelVisible', name: 'fuelName', orbit: 'fuelOrbit', children: ['fuelName', 'fuelOrbit'] },
  { category: 'baseVisible', name: 'baseName', orbit: 'baseOrbit', children: ['baseName', 'baseOrbit'] },
];

function bodyClassCategoryOf(category: keyof BodyClassToggles): BodyClassCategory | undefined {
  return BODY_CLASS_CATEGORIES.find((entry) => entry.category === category);
}

// 保存されている boolean の組を、表示パネルの1ボタンが示す状態へ変換する。
export function bodyClassDisplayMode(
  toggles: BodyClassToggles, category: keyof BodyClassToggles,
): BodyClassDisplayMode {
  const entry = bodyClassCategoryOf(category);
  if (entry === undefined || !toggles[entry.category] || !toggles[entry.name]) return 'hidden';
  return entry.orbit !== null && toggles[entry.orbit] ? 'orbit' : 'label';
}

// 表示パネルの1ボタンを押したときの次の状態。軌道を持つ対象は
// 「非表示 → ラベル → ラベル＋軌道」を循環し、軌道を持たないラグランジュ点だけは、
// 見た目が同じ状態を重複させず「非表示 / ラベル」を循環する。
export function nextBodyClassDisplayMode(
  current: BodyClassDisplayMode, hasOrbit: boolean,
): BodyClassDisplayMode {
  if (!hasOrbit) return current === 'hidden' ? 'label' : 'hidden';
  switch (current) {
    case 'hidden': return 'label';
    case 'label': return 'orbit';
    case 'orbit': return 'hidden';
  }
}

// 表示パネルの表示状態を保存形式へ反映する。非表示ではカテゴリも閉じるため、
// 既存の category/icon/label/orbit の各利用側が同じ意味を受け取れる。
export function applyBodyClassDisplayMode(
  current: BodyClassToggles, category: keyof BodyClassToggles, mode: BodyClassDisplayMode,
): BodyClassToggles {
  const entry = bodyClassCategoryOf(category);
  if (entry === undefined) return current;
  const next = { ...current };
  const visible = mode !== 'hidden';
  next[entry.category] = visible;
  next[entry.name] = visible;
  if (entry.orbit !== null) next[entry.orbit] = mode === 'orbit';
  return next;
}

// クリックされたキー1つの反映。子キーなら該当クラスのクラス全体トグルを子の状態から
// 再計算し、クラス全体キーそのものなら子を全て同じ値へ揃える(表示パネルの唯一の更新口)。
export function applyBodyClassToggle(
  current: BodyClassToggles, key: keyof BodyClassToggles, on: boolean,
): BodyClassToggles {
  const asCategory = BODY_CLASS_CATEGORIES.find((c) => c.category === key);
  if (asCategory !== undefined) {
    const next = { ...current, [key]: on };
    for (const child of asCategory.children) next[child] = on;
    return next;
  }
  const owner = BODY_CLASS_CATEGORIES.find((c) => c.children.includes(key));
  if (owner === undefined) return { ...current, [key]: on };
  const next = { ...current, [key]: on };
  next[owner.category] = owner.children.some((child) => next[child]);
  return next;
}

// 保存データ・既定値を読み込んだ直後に、クラス全体トグルを子の状態から一括で計算し直す。
// 過去バージョンの保存データや将来の手書き編集で親子が食い違っていても、ここを通せば正す。
export function normalizeBodyClassToggles(toggles: BodyClassToggles): BodyClassToggles {
  const next = { ...toggles };
  for (const { category, children } of BODY_CLASS_CATEGORIES) {
    next[category] = children.some((child) => next[child]);
  }
  return next;
}

// カテゴリー名のトグル。恒星は表示の基準点なのでカテゴリー操作の対象外。
export function bodyClassVisible(cls: BodyClass, toggles: BodyClassToggles): boolean {
  switch (cls) {
    case 'planet': return toggles.planetVisible;
    case 'dwarf': return toggles.dwarfVisible;
    case 'satellite': return toggles.satelliteVisible;
    case 'smallBody': return toggles.smallBodyVisible;
    default: return true;
  }
}

// トグルで足されるクラス(planet/dwarf/satellite/smallBody)の Name を、そのクラスのトグル値
// から読む。恒星・focus 近傍の常時表示はここを経由しない(呼び出し側の判断)。
export function bodyNameVisible(cls: BodyClass, toggles: BodyClassToggles): boolean {
  if (!bodyClassVisible(cls, toggles)) return false;
  switch (cls) {
    case 'planet': return toggles.planetName;
    case 'dwarf': return toggles.dwarfName;
    case 'satellite': return toggles.satelliteName;
    case 'smallBody': return toggles.smallBodyName;
    default: return false;
  }
}

// focusId と同じ系にある天体(自分・親・子・親を共有する兄弟)。UI が「いま見ている系」を
// 先頭に出すときの判定もこれを使う — 可視性と選択候補の並びで系の切り方が食い違わないように。
// focusId が undefined(フォーカス中の天体が無い)なら空集合を返す。
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
  celestialBodies: readonly CelestialBody[],
): boolean {
  const byId = motionById(motions);
  const focus = focusId === undefined ? undefined : byId.get(focusId);
  if (focus === undefined) return true;

  const systemFocusId = focus.kind === 'satellite' ? focus.primary?.id ?? null : focus.id;
  const initial = strongestAttractor(position, celestialBodies).id;
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
function ancestorsOf(byId: ReadonlyMap<string, CelestialMotion>, focusId: string): string[] {
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

// 恒星、フォーカス中の天体の親・兄弟・子、およびカメラが現在属する系の天体——トグルの
// 状態に関わらず名前が見える id の集合。「距離が近いもの」をズーム距離で判定
// すると操作の途中で行が明滅するので、カメラ位置から求めた重力系のメンバーで代用する。
// focusId が undefined でも、nearbyIds に渡された近傍系は残す。
export function alwaysFullyVisibleIds(
  motions: readonly CelestialMotion[], bodyClass: BodyClassLookup, focusId: string | undefined,
  nearbyIds: Iterable<string> = [],
  toggles?: BodyClassToggles,
): ReadonlySet<string> {
  const byId = motionById(motions);
  const ids = new Set<string>();
  for (const m of motions) {
    if (m.kind === 'star') ids.add(m.id);
  }

  // nearbyIds は systemMembersAt() など、呼び出し側がカメラ位置から求めた系の集合。
  // 未登録の重力源が混ざっても、ここは天体ラベルの集合なので無視する。
  for (const id of nearbyIds) {
    if (byId.has(id) && (toggles === undefined || bodyClassVisible(bodyClass(id), toggles))) {
      ids.add(id);
    }
  }

  if (focusId === undefined) return ids;

  for (const id of ancestorsOf(byId, focusId)) {
    if (toggles === undefined || bodyClassVisible(bodyClass(id), toggles)) ids.add(id);
  }
  // 兄弟は「惑星系の中の兄弟」に限る。恒星の子はすべて互いに兄弟なので、そこまで含めると
  // 惑星にフォーカスしただけで全太陽周回天体が出てしまう(惑星どうしの表示は planetOrbit/
  // planetName トグルが別途受け持つ)。
  const focusParent = byId.get(focusId)?.primary ?? null;
  const siblingsMatter = focusParent !== null && focusParent.kind !== 'star';
  for (const id of sameSystemIds(motions, focusId)) {
    // focusId 自身は未登録(生存中の重力天体)でもありうるので、親を引く前に弾く。
    if ((siblingsMatter || id === focusId || (byId.get(id)?.primary?.id ?? null) === focusId)
      && (toggles === undefined || bodyClassVisible(bodyClass(id), toggles))) {
      ids.add(id);
    }
  }
  return ids;
}

// cameraPos で最も強く重力を及ぼす天体から主星まで遡った id の列(その天体自身を含む)。
// 最寄り天体が registry に未登録(生存中の重力天体)なら、その id 1つだけを返す。
export function systemChainAt(
  motions: readonly CelestialMotion[], cameraPos: Vec3, celestialBodies: readonly CelestialBody[],
): readonly string[] {
  if (celestialBodies.length === 0) return [];
  const nearest = strongestAttractor(cameraPos, celestialBodies).id;
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
  motions: readonly CelestialMotion[], cameraPos: Vec3, celestialBodies: readonly CelestialBody[],
): readonly string[] {
  return membersFromChain(motions, motionById(motions), systemChainAt(motions, cameraPos, celestialBodies));
}

// strongestAttractor をそのまま「いまいる系」の判定に使うと、勢力圏が極端に狭い天体(主星から
// 極端に近い衛星など)ではフレームごとの浮動小数点誤差やカメラの微小な移動だけで最強天体が
// 入れ替わり、系のラベルが明滅する(MAP.md 4節)。このトラッカーは直前フレームの勝者を
// STICKY_MARGIN_SQ 倍まで有利に扱い、新しい候補が明確に優勢でない限り系を切り替えない。
// per-frame で呼ぶ側(FocusMarkers・MapPickables など)がインスタンスを保持して使うこと。
const STICKY_MARGIN_SQ = 1.2 * 1.2;

export class NearbySystemTracker {
  private previousId: string | null = null;

  chainAt(motions: readonly CelestialMotion[], cameraPos: Vec3, celestialBodies: readonly CelestialBody[]): readonly string[] {
    if (celestialBodies.length === 0) return [];
    const nearest = this.pickNearest(cameraPos, celestialBodies);
    this.previousId = nearest;
    return chainFromNearest(motionById(motions), nearest);
  }

  membersAt(motions: readonly CelestialMotion[], cameraPos: Vec3, celestialBodies: readonly CelestialBody[]): readonly string[] {
    return membersFromChain(motions, motionById(motions), this.chainAt(motions, cameraPos, celestialBodies));
  }

  private pickNearest(cameraPos: Vec3, celestialBodies: readonly CelestialBody[]): string {
    const best = strongestAttractor(cameraPos, celestialBodies);
    if (this.previousId === null || this.previousId === best.id) return best.id;
    const previous = celestialBodies.find((a) => a.id === this.previousId);
    if (previous === undefined) return best.id;
    const bestAccel = lenSq(attractorAccel(cameraPos, best, best.state.t));
    const prevAccel = lenSq(attractorAccel(cameraPos, previous, previous.state.t));
    return bestAccel > prevAccel * STICKY_MARGIN_SQ ? best.id : previous.id;
  }
}
