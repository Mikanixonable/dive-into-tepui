// 外皮の肉厚と構造質量(§10-3)。肉厚は区画ごとに決まり、内圧を持つ区画は薄肉圧力容器の式、持たない
// 区画は座屈と製造上の下限で決まる。タンクを大きくすると質量が半径に比例して増えるのはこのためで、
// 内圧の高い加圧式向けのタンクはポンプ式向けより厚く重くなる。
//
// トラスと分離機構は外皮を持たないため、肉厚ではなく断面の大きさと長さから質量を出す。

// 構造材。比強度(許容応力を密度で割った値)がアルミ合金・チタン合金・炭素繊維複合材の順に高い。
// 密度と許容応力は純元素ではなく合金・複合材としての代表値である。
export type StructuralMaterialId = 'aluminium' | 'titanium' | 'carbon-composite';

export interface StructuralMaterial {
  readonly id: StructuralMaterialId;
  readonly density: number; // kg/m³
  readonly allowableStress: number; // Pa
}

export const STRUCTURAL_MATERIALS: Readonly<Record<StructuralMaterialId, StructuralMaterial>> = {
  aluminium: { id: 'aluminium', density: 2800, allowableStress: 270e6 },
  titanium: { id: 'titanium', density: 4430, allowableStress: 830e6 },
  'carbon-composite': { id: 'carbon-composite', density: 1600, allowableStress: 600e6 },
};

// 溶接効率。継手が母材より弱いぶんを見込む。
export const WELD_EFFICIENCY = 0.85;

// 内圧に対する安全率。
export const PRESSURE_SAFETY_FACTOR = 1.5;

// 製造上の下限肉厚 [m]。これ以下には薄くできない。
export const MIN_MANUFACTURING_THICKNESS = 1.2e-3;

// 座屈に対する最小肉厚を決める細長比。外接円半径をこの値で割ったものを下限とする。
export const BUCKLING_RADIUS_RATIO = 400;

// 与圧区画の内圧 [Pa]。1気圧。
export const CABIN_PRESSURE = 101325;

// 内圧 p を受ける、外接円半径 r の薄肉円筒の肉厚 [m]。
export function pressurizedWallThickness(pressure: number, radius: number, material: StructuralMaterial): number {
  return (PRESSURE_SAFETY_FACTOR * pressure * radius) / (material.allowableStress * WELD_EFFICIENCY);
}

// 内圧を持たない区画の肉厚 [m]。座屈に対する最小肉厚と、製造上の下限肉厚の大きいほう。
export function unpressurizedWallThickness(radius: number): number {
  return Math.max(radius / BUCKLING_RADIUS_RATIO, MIN_MANUFACTURING_THICKNESS);
}

// 区画の肉厚 [m]。内圧を持つ区画でも、座屈と製造上の下限は下回れない。
export function wallThickness(pressure: number, radius: number, material: StructuralMaterial): number {
  return Math.max(pressurizedWallThickness(pressure, radius, material), unpressurizedWallThickness(radius));
}

// トラスの充填率。断面の大きさを一辺とする角柱のうち、実際に部材が占める体積の割合。骨組みなので
// 中実の棒よりはるかに小さい。
export const TRUSS_SOLIDITY = 0.03;

// 断面の大きさ sectionSize [m] のトラスの線密度 [kg/m]。
export function trussLinearDensity(sectionSize: number, material: StructuralMaterial): number {
  return material.density * TRUSS_SOLIDITY * sectionSize * sectionSize;
}

// 分離機構の質量の、接続口の断面積あたりの値 [kg/m²]。火工品と分離ばねと接手の総体を、口の大きさに
// 比例させて表す。
export const DECOUPLER_MASS_PER_AREA = 12;

// 断面積 area [m²] の口を隔てる分離機構の質量 [kg]。
export function decouplerMass(area: number): number {
  return DECOUPLER_MASS_PER_AREA * area;
}
