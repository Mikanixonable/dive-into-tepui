// マップ上で「いま関心の対象になっている天体」の判定。マップのラベル・軌道オブジェクト一覧・
// 配置UIの基準天体は、この1つの集合を共有して表示を絞る — 3つが別々のフィルタを持つと
// 「マップには出ているのに一覧に無い」が起き、探しているものへ辿り着く道筋が読めなくなる。
// 可視性・選択候補はいずれもフォーカス天体という離散的な状態からの親子関係で決める(ズーム
// 距離のような連続量で判定すると操作の途中で行が明滅する)。systemChainAt だけはカメラ位置
// という連続量から系の呼び名を導く — 表示を絞る判定ではなく、いまいる場所の説明であるため。
import { Attractor, AttractorId, strongestAttractor } from '../../physics/attractor';
import { CelestialRegistry, primaryOf } from '../../physics/solar-system';
import { Vec3 } from '../../physics/vec3';
import { BodyClass, bodyClassOf } from './body-class';

// クラスごとの表示トグル。恒星は常に見えるのでトグルを持たない(太陽系の基準点であり、
// 消えると現在地が読めなくなる)。Icon(マーカーの点)と Label(名前)は別トグル——「位置だけ
// 知りたい(ラベルは煩雑)」「名前だけ確認したい(点は見飽きた)」がそれぞれ独立に成り立つため。
// Orbit(軌道線)はさらに別軸で、planet/dwarf/smallBody だけが持つ。satellite は衛星の参照軌道線が
// フォーカス中の系かどうかで別途決まる(environment-scene.ts の showsReferenceLine)ので Orbit
// トグルを持たない。lagrange は天体ではなく軌道概念も無いので Icon/Label の2軸のみ。
export type BodyClassToggles = {
  readonly planetOrbit: boolean;
  readonly planetIcon: boolean;
  readonly planetLabel: boolean;
  readonly dwarfOrbit: boolean;
  readonly dwarfIcon: boolean;
  readonly dwarfLabel: boolean;
  readonly satelliteIcon: boolean;
  readonly satelliteLabel: boolean;
  readonly satelliteOrbit: boolean;
  readonly smallBodyOrbit: boolean;
  readonly smallBodyIcon: boolean;
  readonly smallBodyLabel: boolean;
  readonly lagrangeIcon: boolean;
  readonly lagrangeLabel: boolean;
  readonly playerIcon: boolean; readonly playerLabel: boolean; readonly playerOrbit: boolean;
  readonly shipIcon: boolean; readonly shipLabel: boolean; readonly shipOrbit: boolean;
  readonly ammoIcon: boolean; readonly ammoLabel: boolean; readonly ammoOrbit: boolean;
  readonly baseIcon: boolean; readonly baseLabel: boolean; readonly baseOrbit: boolean;
};

// 既定 off は「登録数が多くマップが溢れるから」。planet は数が少なく太陽系の骨格をなすので
// 軌道線まで含めて既定 on、smallBody(小惑星・彗星)は軌道線だけが溢れるので Icon/Label のみ
// 既定 on にする。lagrange は FocusMarkers の構築時点で力学的に意味を持つ点(Ephemeris の
// hasUsableCollinearPoints / hasStableTriangularPoints)だけに絞り込み済みで同じ懸念が当たらない
// ため、既定 on にする。
export const DEFAULT_BODY_CLASS_TOGGLES: BodyClassToggles = {
  planetOrbit: true, planetIcon: true, planetLabel: true,
  dwarfOrbit: false, dwarfIcon: false, dwarfLabel: false,
  satelliteIcon: false, satelliteLabel: false, satelliteOrbit: false,
  smallBodyOrbit: false, smallBodyIcon: true, smallBodyLabel: true,
  lagrangeIcon: true, lagrangeLabel: true,
  playerIcon: true, playerLabel: true, playerOrbit: true,
  shipIcon: true, shipLabel: true, shipOrbit: true,
  ammoIcon: true, ammoLabel: true, ammoOrbit: true,
  baseIcon: true, baseLabel: true, baseOrbit: true,
};

// トグルで足されるクラス(planet/dwarf/satellite/smallBody)の Icon/Label を、そのクラスの
// トグル値から読む。恒星・focus 近傍の常時表示はここを経由しない(呼び出し側の判断)。
function classIconLabel(cls: BodyClass, toggles: BodyClassToggles): { icon: boolean; label: boolean } {
  switch (cls) {
    case 'planet': return { icon: toggles.planetIcon, label: toggles.planetLabel };
    case 'dwarf': return { icon: toggles.dwarfIcon, label: toggles.dwarfLabel };
    case 'satellite': return { icon: toggles.satelliteIcon, label: toggles.satelliteLabel };
    case 'smallBody': return { icon: toggles.smallBodyIcon, label: toggles.smallBodyLabel };
    default: return { icon: false, label: false };
  }
}

// focusId と同じ系にある天体(自分・親・子・親を共有する兄弟)。UI が「いま見ている系」を
// 先頭に出すときの判定もこれを使う — 可視性と選択候補の並びで系の切り方が食い違わないように。
// focusId が undefined(フォーカス中の天体が無い)なら空集合を返す。
export function sameSystemIds(registry: CelestialRegistry, focusId: AttractorId | undefined): ReadonlySet<AttractorId> {
  if (focusId === undefined) return new Set();
  const parent = registry[focusId] === undefined ? null : primaryOf(registry, focusId);
  const ids = new Set<AttractorId>([focusId]);
  if (parent !== null) ids.add(parent);
  for (const id of Object.keys(registry)) {
    const p = primaryOf(registry, id);
    if (p === focusId || (parent !== null && p === parent)) ids.add(id);
  }
  return ids;
}

// focus 天体を根にした系に、position の主引力天体が属するかを返す。地球をフォーカス
// している間は地球周回と月周回を含め、土星周回のような別の惑星系は除く。画面上の遮蔽や
// カメラ距離では判定しないため、地球の裏側に回った機体も引き続き対象になる。
//
// 天体以外(艦船・固定点など)へフォーカスしている場合は、どの天体系を表示するかを恣意的に
// 決めないため絞り込まない。これにより、対象艦へフォーカスした瞬間に他艦が消えない。
export function isPositionInFocusedSystem(
  registry: CelestialRegistry,
  focusId: AttractorId | undefined,
  position: Vec3,
  attractors: readonly Attractor[],
): boolean {
  if (focusId === undefined || registry[focusId] === undefined) return true;

  let current: AttractorId | null = strongestAttractor(position, attractors).id;
  // 壊れた親子定義でも停止するよう、レジストリ数を上限にする。
  for (let i = 0; current !== null && i <= Object.keys(registry).length; i++) {
    if (current === focusId) return true;
    if (registry[current] === undefined) return false;
    current = primaryOf(registry, current);
  }
  return false;
}

// focus の親を辿って主星まで遡った id の列(focus 自身を含む)。
function ancestorsOf(registry: CelestialRegistry, focusId: AttractorId): AttractorId[] {
  const chain: AttractorId[] = [];
  let cur: AttractorId | null = focusId;
  // 循環した registry でも止まるよう、登録数を上限にする。
  for (let i = 0; cur !== null && i <= Object.keys(registry).length; i++) {
    if (chain.includes(cur)) break;
    chain.push(cur);
    cur = registry[cur] === undefined ? null : primaryOf(registry, cur);
  }
  return chain;
}

// 恒星、およびフォーカス中の天体の親・兄弟・子——トグルの状態に関わらず Icon/Label が
// 両方見える id の集合。「距離が近いもの」をズーム距離で判定すると操作の途中で行が明滅するので、
// 離散的に切り替わるこの親子関係で代用する。focusId が undefined なら恒星のみ。
export function alwaysFullyVisibleIds(
  registry: CelestialRegistry, focusId: AttractorId | undefined,
): ReadonlySet<AttractorId> {
  const ids = new Set<AttractorId>();
  for (const id of Object.keys(registry)) {
    const cls = bodyClassOf(registry, id);
    if (cls === 'star') ids.add(id);
  }

  if (focusId === undefined) return ids;

  for (const id of ancestorsOf(registry, focusId)) ids.add(id);
  // 兄弟は「惑星系の中の兄弟」に限る。恒星の子はすべて互いに兄弟なので、そこまで含めると
  // 惑星にフォーカスしただけで全太陽周回天体が出てしまう(惑星どうしの表示は planetOrbit/
  // planetIcon/planetLabel トグルが別途受け持つ)。
  const focusParent = registry[focusId] === undefined ? null : primaryOf(registry, focusId);
  const siblingsMatter = focusParent !== null && registry[focusParent]?.kind !== 'star';
  for (const id of sameSystemIds(registry, focusId)) {
    // focusId 自身は未登録(生存中の重力天体)でもありうるので、primaryOf を引く前に弾く。
    if (siblingsMatter || id === focusId || primaryOf(registry, id) === focusId) ids.add(id);
  }
  return ids;
}

// いま表示する(=候補・計算対象になる)天体の集合。alwaysFullyVisibleIds に加え、
// クラスの Icon か Label のどちらかが立っている天体を足す——どちらも off の天体はマップ上の
// 何にもならないので、ピック候補や配置UIの基準天体からも除く。
export function visibleBodyIds(
  registry: CelestialRegistry, focusId: AttractorId | undefined, toggles: BodyClassToggles,
): ReadonlySet<AttractorId> {
  const visible = new Set(alwaysFullyVisibleIds(registry, focusId));
  for (const id of Object.keys(registry)) {
    const cls = bodyClassOf(registry, id);
    const { icon, label } = classIconLabel(cls, toggles);
    if (icon || label) visible.add(id);
  }
  return visible;
}

// 天体 id 1つの Icon/Label 表示可否。alwaysFullyVisibleIds に含まれる天体は呼び出し側で
// 個別に true/true とすること(この関数はクラストグルだけを読む)。
export function bodyIconLabel(
  registry: CelestialRegistry, toggles: BodyClassToggles, id: AttractorId,
): { icon: boolean; label: boolean } {
  return classIconLabel(bodyClassOf(registry, id), toggles);
}

// cameraPos で最も強く重力を及ぼす天体から主星まで遡った id の列(その天体自身を含む)。
// 最寄り天体が registry に未登録(生存中の重力天体)なら、その id 1つだけを返す。
export function systemChainAt(
  registry: CelestialRegistry, cameraPos: Vec3, attractors: readonly Attractor[],
): readonly AttractorId[] {
  if (attractors.length === 0) return [];
  const nearest = strongestAttractor(cameraPos, attractors).id;
  if (registry[nearest] === undefined) return [nearest];
  return ancestorsOf(registry, nearest);
}

// systemChainAt の列に、各天体の子(恒星の子は除く)を合わせた集合。近い順・各天体→その子の
// 順に並ぶ配列で返す(呼び出し側の選択肢が毎フレーム揺れないよう順序を固定する)。恒星の子は
// 足さない — 足すと太陽を含む列で全惑星が並んでしまうため。
export function systemMembersAt(
  registry: CelestialRegistry, cameraPos: Vec3, attractors: readonly Attractor[],
): readonly AttractorId[] {
  const chain = systemChainAt(registry, cameraPos, attractors);
  const seen = new Set<AttractorId>();
  const result: AttractorId[] = [];
  for (const id of chain) {
    if (!seen.has(id)) {
      seen.add(id);
      result.push(id);
    }
    if (registry[id] === undefined || primaryOf(registry, id) === null) continue;
    for (const childId of Object.keys(registry)) {
      if (seen.has(childId) || primaryOf(registry, childId) !== id) continue;
      seen.add(childId);
      result.push(childId);
    }
  }
  return result;
}
