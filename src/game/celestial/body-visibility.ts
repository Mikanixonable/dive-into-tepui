// マップ上で「いま関心の対象になっている天体」の判定。マップのラベル・軌道オブジェクト一覧・
// 配置UIの基準天体は、この1つの集合を共有して表示を絞る — 3つが別々のフィルタを持つと
// 「マップには出ているのに一覧に無い」が起き、探しているものへ辿り着く道筋が読めなくなる。
import { AttractorId } from '../../physics/attractor';
import { CelestialRegistry, primaryOf } from '../../physics/solar-system';
import { bodyClassOf } from './body-class';

// クラスごとの表示トグル。恒星と惑星は常に見えるのでトグルを持たない(太陽系の骨格であり、
// 消えると現在地が読めなくなる)。軌道表示(Orbit)とアイコンラベル表示(Label)は別トグル
// ——「軌道は要らないが位置だけ知りたい」「ラベルは煩雑だが軌道の形は見たい」がそれぞれ
// 独立に成り立つため。satellite は衛星の参照軌道線がフォーカス中の系かどうかで別途決まる
// (environment-scene.ts の showsReferenceLine)ので Orbit トグルを持たない。lagrange は
// ラグランジュ点ラベルの表示可否で、天体ではなく軌道概念もないので単一の軸のまま。
export type BodyClassToggles = {
  readonly dwarfOrbit: boolean;
  readonly dwarfLabel: boolean;
  readonly satelliteLabel: boolean;
  readonly smallBodyOrbit: boolean;
  readonly smallBodyLabel: boolean;
  readonly lagrange: boolean;
};

// 既定 off は「登録数が多くマップが溢れるから」。smallBody(小惑星・準惑星・彗星)は例外で、
// 軌道線は溢れるが位置だけは把握したいことが多いため Label のみ既定 on にする。lagrange は
// FocusMarkers の構築時点で力学的に意味を持つ点(Ephemeris の hasUsableCollinearPoints /
// hasStableTriangularPoints)だけに絞り込み済みで同じ懸念が当たらないため、既定 on にする。
export const DEFAULT_BODY_CLASS_TOGGLES: BodyClassToggles = {
  dwarfOrbit: false, dwarfLabel: false,
  satelliteLabel: false,
  smallBodyOrbit: false, smallBodyLabel: true,
  lagrange: true,
};

// focusId と同じ系にある天体(自分・親・子・親を共有する兄弟)。UI が「いま見ている系」を
// 先頭に出すときの判定もこれを使う — 可視性と選択候補の並びで系の切り方が食い違わないように。
export function sameSystemIds(registry: CelestialRegistry, focusId: AttractorId): ReadonlySet<AttractorId> {
  const parent = registry[focusId] === undefined ? null : primaryOf(registry, focusId);
  const ids = new Set<AttractorId>([focusId]);
  if (parent !== null) ids.add(parent);
  for (const id of Object.keys(registry)) {
    const p = primaryOf(registry, id);
    if (p === focusId || (parent !== null && p === parent)) ids.add(id);
  }
  return ids;
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

// いま表示する天体の集合。3つの規則の和で、どれか1つでも当たれば見える:
//   1. 恒星と惑星は常に見える。
//   2. フォーカス中の天体の親・兄弟・子は、クラスに関わらず見える — 木星にフォーカスすれば
//      ガリレオ衛星が現れ、離れれば引っ込む。「距離が近いもの」をズーム距離で判定すると
//      ズーム操作の途中で行が明滅するので、離散的に切り替わるこの親子関係で代用する。
//   3. トグルで明示的に足したクラスは全数見える。
export function visibleBodyIds(
  registry: CelestialRegistry, focusId: AttractorId, toggles: BodyClassToggles,
): ReadonlySet<AttractorId> {
  const ids = Object.keys(registry);
  const visible = new Set<AttractorId>();

  for (const id of ids) {
    const cls = bodyClassOf(registry, id);
    if (cls === 'star' || cls === 'planet') visible.add(id);
    else if (cls === 'dwarf' ? toggles.dwarfLabel : cls === 'satellite' ? toggles.satelliteLabel : toggles.smallBodyLabel) visible.add(id);
  }

  for (const id of ancestorsOf(registry, focusId)) visible.add(id);
  // 兄弟は「惑星系の中の兄弟」に限る。恒星の子はすべて互いに兄弟なので、そこまで含めると
  // 惑星にフォーカスしただけで全太陽周回天体が出てしまう(その階層は 1. が既に賄っている)。
  const focusParent = registry[focusId] === undefined ? null : primaryOf(registry, focusId);
  const siblingsMatter = focusParent !== null && registry[focusParent]?.kind !== 'star';
  for (const id of sameSystemIds(registry, focusId)) {
    // focusId 自身は未登録(生存中の重力天体)でもありうるので、primaryOf を引く前に弾く。
    if (siblingsMatter || id === focusId || primaryOf(registry, id) === focusId) visible.add(id);
  }
  return visible;
}
