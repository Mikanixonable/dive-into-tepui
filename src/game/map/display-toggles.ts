// マップの表示トグル。天体のクラス(惑星・準惑星・衛星・小天体・ラグランジュ点)と、積分で動く
// 個体の種別(自機・敵艦・弾薬・燃料・基地)を同じ表で持つ — 表示パネルの1ボタンが示す状態も、
// 保存される boolean の組も、この1つの表が正本。
import type { CelestialClass } from '../celestial/celestial-entity/celestial-entity-def';

export type MapDisplayToggles = {
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

export type MapDisplayMode = 'orbit' | 'label' | 'hidden';

// 軌道線(Orbit)は面積を食う——全登録天体ぶん描くと内側太陽系がその天体の軌道線で埋まる
// ため、数の多いクラス(dwarf・smallBody・satellite)は既定 off にする。planet だけは数が
// 少なく太陽系の骨格をなすので軌道線まで既定 on。一方 Name は focus-markers.ts の混雑抑制
// (画面上で近すぎるラベルを間引く)が効くので溢れる心配が無く、planet と同様 dwarf・
// smallBody・satellite も既定 on にする。lagrange は力学的に意味を持つ点(共線点の余裕・
// 三角点の安定性を満たすもの)だけに絞り込まれていて同じ懸念が当たらないため、既定 on にする。
export const DEFAULT_MAP_DISPLAY_TOGGLES: MapDisplayToggles = {
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
// (normalizeMapDisplayToggles)。lagrange は軌道という概念自体が
// 無いため children はラベルのみ。
interface MapDisplayCategory {
  readonly category: keyof MapDisplayToggles;
  readonly name: keyof MapDisplayToggles;
  readonly orbit: keyof MapDisplayToggles | null;
  readonly children: readonly (keyof MapDisplayToggles)[];
}

const MAP_DISPLAY_CATEGORIES: readonly MapDisplayCategory[] = [
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

// そのトグルキーを親に持つ表示カテゴリ。カテゴリの親キーでなければ undefined。
function mapDisplayCategoryOf(category: keyof MapDisplayToggles): MapDisplayCategory | undefined {
  return MAP_DISPLAY_CATEGORIES.find((entry) => entry.category === category);
}

// 保存されている boolean の組を、表示パネルの1ボタンが示す状態へ変換する。
export function mapDisplayModeOf(
  toggles: MapDisplayToggles, category: keyof MapDisplayToggles,
): MapDisplayMode {
  const entry = mapDisplayCategoryOf(category);
  if (entry === undefined || !toggles[entry.category] || !toggles[entry.name]) return 'hidden';
  return entry.orbit !== null && toggles[entry.orbit] ? 'orbit' : 'label';
}

// 表示パネルの1ボタンを押したときの次の状態。軌道を持つ対象は
// 「非表示 → ラベル → ラベル＋軌道」を循環し、軌道を持たないラグランジュ点だけは、
// 見た目が同じ状態を重複させず「非表示 / ラベル」を循環する。
export function nextMapDisplayMode(
  current: MapDisplayMode, hasOrbit: boolean,
): MapDisplayMode {
  if (!hasOrbit) return current === 'hidden' ? 'label' : 'hidden';
  switch (current) {
    case 'hidden': return 'label';
    case 'label': return 'orbit';
    case 'orbit': return 'hidden';
  }
}

// 表示パネルの表示状態を保存形式へ反映する。非表示ではカテゴリも閉じるため、
// 既存の category/icon/label/orbit の各利用側が同じ意味を受け取れる。
export function applyMapDisplayMode(
  current: MapDisplayToggles, category: keyof MapDisplayToggles, mode: MapDisplayMode,
): MapDisplayToggles {
  const entry = mapDisplayCategoryOf(category);
  if (entry === undefined) return current;
  const next = { ...current };
  const visible = mode !== 'hidden';
  next[entry.category] = visible;
  next[entry.name] = visible;
  if (entry.orbit !== null) next[entry.orbit] = mode === 'orbit';
  return next;
}

// 保存データ・既定値を読み込んだ直後に、クラス全体トグルを子の状態から一括で計算し直す。
// 過去バージョンの保存データや将来の手書き編集で親子が食い違っていても、ここを通せば正す。
export function normalizeMapDisplayToggles(toggles: MapDisplayToggles): MapDisplayToggles {
  const next = { ...toggles };
  for (const { category, children } of MAP_DISPLAY_CATEGORIES) {
    next[category] = children.some((child) => next[child]);
  }
  return next;
}

// カテゴリー名のトグル。恒星は表示の基準点なのでカテゴリー操作の対象外。
export function celestialClassVisible(cls: CelestialClass, toggles: MapDisplayToggles): boolean {
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
export function celestialNameVisible(cls: CelestialClass, toggles: MapDisplayToggles): boolean {
  if (!celestialClassVisible(cls, toggles)) return false;
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
