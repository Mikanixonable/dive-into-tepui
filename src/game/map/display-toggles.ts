// マップの表示トグル。天体のクラス(惑星・準惑星・衛星・小天体・ラグランジュ点)と、積分で動く
// 個体の種別(自機・敵艦・弾薬・燃料・基地)のラベル・軌道線を同じ表で持つ — 表示パネルのチップが
// 示す状態も、保存される boolean の組も、この1つの表が正本。
import type { CelestialClass } from '../celestial/celestial-entity/celestial-entity-def';

export interface MapDisplayToggles {
  readonly planetOrbit: boolean;
  readonly planetName: boolean;
  readonly dwarfOrbit: boolean;
  readonly dwarfName: boolean;
  readonly satelliteName: boolean;
  readonly satelliteOrbit: boolean;
  readonly smallBodyOrbit: boolean;
  readonly smallBodyName: boolean;
  readonly lagrangeName: boolean;
  readonly playerName: boolean; readonly playerOrbit: boolean;
  readonly enemyName: boolean; readonly enemyOrbit: boolean;
  readonly ammoName: boolean; readonly ammoOrbit: boolean;
  readonly fuelName: boolean; readonly fuelOrbit: boolean;
  readonly baseName: boolean; readonly baseOrbit: boolean;
  readonly orbitSlotName: boolean; readonly orbitSlotOrbit: boolean;
}

// ラベル・軌道線をまとめた対象クラス。どちらかが ON ならそのクラスはマップに現れる。
export type MapDisplayCategory =
  | 'planetVisible' | 'dwarfVisible' | 'satelliteVisible' | 'smallBodyVisible' | 'lagrangeVisible'
  | 'playerVisible' | 'enemyVisible' | 'ammoVisible' | 'fuelVisible' | 'baseVisible'
  | 'orbitSlotVisible';

// 既定値(SPEC/MAP.md「表示するオブジェクトの選択」)。準惑星・小天体の軌道線は、数が多く
// 内側太陽系を埋めるので off。
// ラベルは混雑時に間引かれるので全クラス on。
export const DEFAULT_MAP_DISPLAY_TOGGLES: MapDisplayToggles = {
  planetOrbit: true, planetName: true,
  dwarfOrbit: false, dwarfName: true,
  satelliteName: true, satelliteOrbit: true,
  smallBodyOrbit: false, smallBodyName: true,
  lagrangeName: true,
  playerName: true, playerOrbit: true,
  enemyName: true, enemyOrbit: true,
  ammoName: true, ammoOrbit: false,
  fuelName: true, fuelOrbit: false,
  baseName: true, baseOrbit: true,
  orbitSlotName: true, orbitSlotOrbit: true,
};

// 各対象クラスに属するトグル(ラベル・軌道線)。軌道を持たない lagrange は orbit が null。
const MAP_DISPLAY_CATEGORIES: Readonly<Record<MapDisplayCategory, {
  readonly name: keyof MapDisplayToggles;
  readonly orbit: keyof MapDisplayToggles | null;
}>> = {
  planetVisible: { name: 'planetName', orbit: 'planetOrbit' },
  dwarfVisible: { name: 'dwarfName', orbit: 'dwarfOrbit' },
  satelliteVisible: { name: 'satelliteName', orbit: 'satelliteOrbit' },
  smallBodyVisible: { name: 'smallBodyName', orbit: 'smallBodyOrbit' },
  lagrangeVisible: { name: 'lagrangeName', orbit: null },
  playerVisible: { name: 'playerName', orbit: 'playerOrbit' },
  enemyVisible: { name: 'enemyName', orbit: 'enemyOrbit' },
  ammoVisible: { name: 'ammoName', orbit: 'ammoOrbit' },
  fuelVisible: { name: 'fuelName', orbit: 'fuelOrbit' },
  baseVisible: { name: 'baseName', orbit: 'baseOrbit' },
  orbitSlotVisible: { name: 'orbitSlotName', orbit: 'orbitSlotOrbit' },
};

// 対象クラスがマップに現れるか。ラベル・軌道線のどちらかが on なら現れる。
export function mapDisplayCategoryVisible(toggles: MapDisplayToggles, category: MapDisplayCategory): boolean {
  const { name, orbit } = MAP_DISPLAY_CATEGORIES[category];
  return toggles[name] || (orbit !== null && toggles[orbit]);
}

// 保存された文字列をトグルの組へ読み直す。読めなければ既定値に戻る。
export function parseMapDisplayToggles(text: string | null): MapDisplayToggles {
  try {
    if (!text) return DEFAULT_MAP_DISPLAY_TOGGLES;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return DEFAULT_MAP_DISPLAY_TOGGLES;
    return { ...DEFAULT_MAP_DISPLAY_TOGGLES, ...parsed };
  } catch {
    return DEFAULT_MAP_DISPLAY_TOGGLES;
  }
}

// トグルの組を保存へ載せる文字列にする。
export function formatMapDisplayToggles(toggles: MapDisplayToggles): string {
  return JSON.stringify(toggles);
}

// 天体クラスがマップに現れるか。恒星は表示の基準点なので常に true。
export function celestialClassVisible(cls: CelestialClass, toggles: MapDisplayToggles): boolean {
  switch (cls) {
    case 'planet': return mapDisplayCategoryVisible(toggles, 'planetVisible');
    case 'dwarf': return mapDisplayCategoryVisible(toggles, 'dwarfVisible');
    case 'satellite': return mapDisplayCategoryVisible(toggles, 'satelliteVisible');
    case 'smallBody': return mapDisplayCategoryVisible(toggles, 'smallBodyVisible');
    default: return true;
  }
}

// 天体クラスの名前トグル。恒星は false。
export function celestialNameVisible(cls: CelestialClass, toggles: MapDisplayToggles): boolean {
  switch (cls) {
    case 'planet': return toggles.planetName;
    case 'dwarf': return toggles.dwarfName;
    case 'satellite': return toggles.satelliteName;
    case 'smallBody': return toggles.smallBodyName;
    default: return false;
  }
}
