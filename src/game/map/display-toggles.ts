// マップの表示トグル。天体のクラス(惑星・準惑星・衛星・小天体・ラグランジュ点)と、積分で動く
// 個体の種別(自機・敵艦・弾薬・燃料・基地)を同じ表で持つ — 表示パネルの1ボタンが示す状態も、
// 保存される boolean の組も、この1つの表が正本。
import type { CelestialClass } from '../celestial/celestial-entity/celestial-entity-def';

export interface MapDisplayToggles {
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
  readonly enemyVisible: boolean;
  readonly enemyName: boolean; readonly enemyOrbit: boolean;
  readonly ammoVisible: boolean;
  readonly ammoName: boolean; readonly ammoOrbit: boolean;
  readonly fuelVisible: boolean;
  readonly fuelName: boolean; readonly fuelOrbit: boolean;
  readonly baseVisible: boolean;
  readonly baseName: boolean; readonly baseOrbit: boolean;
}

export type MapDisplayMode = 'orbit' | 'label' | 'hidden';

// 既定値(SPEC/MAP.md §4)。準惑星・小天体の軌道線は、数が多く内側太陽系を埋めるので off。
// ラベルは混雑時に間引かれるので全クラス on。
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
  enemyVisible: true,
  enemyName: true, enemyOrbit: true,
  ammoVisible: true,
  ammoName: true, ammoOrbit: false,
  fuelVisible: true,
  fuelName: true, fuelOrbit: false,
  baseVisible: true,
  baseName: true, baseOrbit: true,
};

// 各クラスの「クラス全体」トグルと、その配下にある子トグル(ラベル・軌道線)の対応。
// 表示パネルのボタン構成もこの表が正本。軌道を持たない lagrange は orbit が null。
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
  { category: 'enemyVisible', name: 'enemyName', orbit: 'enemyOrbit', children: ['enemyName', 'enemyOrbit'] },
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

// 表示パネルの1ボタンを押したときの次の状態。軌道を持つ対象は「非表示 → ラベル →
// ラベル＋軌道」、持たない対象は「非表示 / ラベル」を循環する。
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

// 表示パネルの表示状態を保存形式へ反映する。非表示ならクラス全体のトグルも閉じる。
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

// クラス全体トグルを子の状態から計算し直す — 子が1つでも on なら on。保存データ・既定値を
// 読み込んだ直後に通し、親子の食い違いを正す。
export function normalizeMapDisplayToggles(toggles: MapDisplayToggles): MapDisplayToggles {
  const next = { ...toggles };
  for (const { category, children } of MAP_DISPLAY_CATEGORIES) {
    next[category] = children.some((child) => next[child]);
  }
  return next;
}

// 保存された文字列をトグルの組へ読み直す。読めなければ既定値に戻る。
export function parseMapDisplayToggles(text: string | null): MapDisplayToggles {
  try {
    if (!text) return DEFAULT_MAP_DISPLAY_TOGGLES;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_MAP_DISPLAY_TOGGLES;
    return normalizeMapDisplayToggles({ ...DEFAULT_MAP_DISPLAY_TOGGLES, ...parsed });
  } catch {
    return DEFAULT_MAP_DISPLAY_TOGGLES;
  }
}

// トグルの組を保存へ載せる文字列にする。
export function formatMapDisplayToggles(toggles: MapDisplayToggles): string {
  return JSON.stringify(toggles);
}

// 天体クラスの表示トグル。恒星は表示の基準点なので常に true。
export function celestialClassVisible(cls: CelestialClass, toggles: MapDisplayToggles): boolean {
  switch (cls) {
    case 'planet': return toggles.planetVisible;
    case 'dwarf': return toggles.dwarfVisible;
    case 'satellite': return toggles.satelliteVisible;
    case 'smallBody': return toggles.smallBodyVisible;
    default: return true;
  }
}

// 天体クラスの名前トグル。クラス全体が非表示なら false、恒星は false。
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
