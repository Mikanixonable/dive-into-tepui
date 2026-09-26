// イベント材料(液水の親と氷コホート)を堆積 parcel へ写す、局所・全球の堆積
// adapter が共有する簿記と形状の部品。格子への射影とセル被覆は各 adapter の
// 格子が担い、ここでは材料の質量収支・footprint 形状の対応付け・形状から
// 楕円への固有値変換・parcel の組み立てを持つ。

import { dot } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import type { CloudEventMaterialCohorts } from './cloud-event-transport';
import type {
  CloudMassDeposition,
  CloudMassGrid,
  CloudMassParcel,
  CloudMassPhase,
} from './cloud-mass-deposition';

// 材料1単位の footprint 形。等方半径と接空間上の伸長ベクトルの組で、
// 接平面上の楕円は G = c²I + Σvvᵀ の固有値・固有ベクトルから復元する。
// 伸長が無い形は等半径の円。
export interface CloudEventFootprintShape {
  // 等方成分の半径。m。
  readonly isotropicRadiusM: number;
  // 伸長成分。長さが伸長距離 [m] のベクトルで、材料の位置の接平面方向へ伸びる。
  readonly elongationVectorsM: readonly Vec3[];
}

// イベント材料全体の footprint 形状指定。液水の親と氷コホートごとに形状を持つ。
export interface CloudEventFootprintShapes {
  readonly parentLiquid: CloudEventFootprintShape | null;
  readonly releasedIceCohorts: readonly CloudIceCohortFootprintShape[];
}

// 氷コホート1件の形状指定。cohortIndex は材料側のコホート番号と1対1で対応する。
export interface CloudIceCohortFootprintShape {
  readonly cohortIndex: number;
  readonly shape: CloudEventFootprintShape;
}

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function requirePositive(value: number, name: string): void {
  requireFinite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
}

// 質量・面積の総和の丸め誤差を抑える補正加算。
interface SumAccumulator {
  total: number;
  correction: number;
}

function addCompensated(accumulator: SumAccumulator, value: number): void {
  const adjusted = value - accumulator.correction;
  const next = accumulator.total + adjusted;
  accumulator.correction = (next - accumulator.total) - adjusted;
  accumulator.total = next;
}

function compensatedSum(values: readonly number[]): number {
  const accumulator: SumAccumulator = { total: 0, correction: 0 };
  for (const value of values) {
    addCompensated(accumulator, value);
  }
  return accumulator.total;
}

// ledger の totalMassKgM2 が親と氷コホートの成分和と一致することを確かめる。
function validateCloudEventMaterialMass(material: CloudEventMaterialCohorts): void {
  requireFinite(material.totalMassKgM2, 'totalMassKgM2');
  if (material.totalMassKgM2 < 0) throw new RangeError('totalMassKgM2 must be non-negative');
  const parentMassKgM2 = material.parent?.massKgM2 ?? 0;
  const cohortMassKgM2 = compensatedSum(
    material.releasedIceCohorts.map((cohort) => cohort.massKgM2));
  const componentMassKgM2 = parentMassKgM2 + cohortMassKgM2;
  const toleranceKgM2 = Math.max(Number.MIN_VALUE, Math.abs(componentMassKgM2) * 1e-10);
  if (!Number.isFinite(componentMassKgM2)
    || Math.abs(componentMassKgM2 - material.totalMassKgM2) > toleranceKgM2) {
    throw new RangeError('material totalMassKgM2 must equal its liquid and ice components');
  }
}

// 材料の footprint 形状指定を検査し、氷コホート番号から形状への対応表を返す。
// 液水の親とその形状は存在が一致していなければならず、氷コホートは1件につき
// 明示の1形状を要する。
function validateCloudEventFootprintShapes(
  material: CloudEventMaterialCohorts,
  footprintShapes: CloudEventFootprintShapes,
): ReadonlyMap<number, CloudEventFootprintShape> {
  if (material.parent === null && footprintShapes.parentLiquid !== null) {
    throw new RangeError('parentLiquid must be null when no liquid parent exists');
  }
  if (material.parent !== null && footprintShapes.parentLiquid === null) {
    throw new RangeError('parentLiquid is required for a liquid parent');
  }
  const footprints = footprintShapes.releasedIceCohorts;
  if (footprints.length !== material.releasedIceCohorts.length) {
    throw new RangeError('each released ice cohort requires one explicit footprint shape');
  }
  const shapes = new Map<number, CloudEventFootprintShape>();
  for (const footprint of footprints) {
    if (!Number.isInteger(footprint.cohortIndex) || footprint.cohortIndex < 0) {
      throw new RangeError('footprint cohortIndex must be a non-negative integer');
    }
    if (shapes.has(footprint.cohortIndex)) {
      throw new RangeError('duplicate released ice cohort footprint');
    }
    shapes.set(footprint.cohortIndex, footprint.shape);
  }
  const cohortIndices = new Set<number>();
  for (const cohort of material.releasedIceCohorts) {
    if (!Number.isInteger(cohort.cohortIndex) || cohort.cohortIndex < 0) {
      throw new RangeError('released ice cohortIndex must be a non-negative integer');
    }
    if (cohortIndices.has(cohort.cohortIndex)) {
      throw new RangeError('released ice cohortIndex values must be unique');
    }
    cohortIndices.add(cohort.cohortIndex);
    if (!shapes.has(cohort.cohortIndex)) {
      throw new RangeError(`missing footprint shape for ice cohort ${cohort.cohortIndex}`);
    }
  }
  if (shapes.size !== cohortIndices.size) {
    throw new RangeError('footprint shape refers to an unknown ice cohort');
  }
  return shapes;
}

// footprint の等方半径と伸長ベクトルから、接平面基底の上の楕円へ変換する。
// 伸長ベクトルは接空間のまま運ばれるので、東・北基底へ落として 2×2 形状行列
// G = c²I + Σvvᵀ を組み、その固有値を半軸、固有ベクトルを主軸方位とする。
// 材料方向と基底の中心が離れるほど基底のずれで形状が歪む近似を含む。
export function footprintEllipseAtBasis(
  shape: CloudEventFootprintShape,
  eastUnitVector: Vec3,
  northUnitVector: Vec3,
): {
  readonly majorRadiusM: number;
  readonly minorRadiusM: number;
  readonly majorAxisAzimuthRad: number;
} {
  requirePositive(shape.isotropicRadiusM, 'footprint isotropicRadiusM');
  const isotropicSquaredM2 = shape.isotropicRadiusM * shape.isotropicRadiusM;
  let g11 = isotropicSquaredM2;
  let g12 = 0;
  let g22 = isotropicSquaredM2;
  for (const vector of shape.elongationVectorsM) {
    requireFinite(vector.x, 'elongation.x');
    requireFinite(vector.y, 'elongation.y');
    requireFinite(vector.z, 'elongation.z');
    const eastM = dot(vector, eastUnitVector);
    const northM = dot(vector, northUnitVector);
    g11 += eastM * eastM;
    g12 += eastM * northM;
    g22 += northM * northM;
  }
  const traceHalfM2 = (g11 + g22) / 2;
  const offDiagonalRadiusM2 = Math.hypot((g11 - g22) / 2, g12);
  const majorSquaredM2 = traceHalfM2 + offDiagonalRadiusM2;
  const minorSquaredM2 = Math.max(traceHalfM2 - offDiagonalRadiusM2, Number.MIN_VALUE);
  return {
    majorRadiusM: Math.sqrt(majorSquaredM2),
    minorRadiusM: Math.sqrt(minorSquaredM2),
    // 対称 2×2 の大固有値の主軸方位。等方(g12=0 かつ g11=g22)では不定だが、
    // そのとき半軸が等しく方位は結果に効かない。
    majorAxisAzimuthRad: Math.atan2(2 * g12, g11 - g22) / 2,
  };
}

// 材料1単位ずつ parcel を組み立てる。液水の親と氷コホートを parcelAt で1件ずつ
// 作り、parcel が触れた格子セルの index を併せて返す。
export function cloudEventMaterialParcels(
  material: CloudEventMaterialCohorts,
  sourceAreaM2: number,
  footprintShapes: CloudEventFootprintShapes,
  parcelAt: (
    phase: CloudMassPhase,
    massKgM2: number,
    directionUnitVector: Vec3,
    geometricHeightM: number,
    footprintShape: CloudEventFootprintShape,
  ) => CloudMassParcel,
): {
  readonly parcels: readonly CloudMassParcel[];
  readonly touchedCellIndices: readonly number[];
} {
  requirePositive(sourceAreaM2, 'sourceAreaM2');
  validateCloudEventMaterialMass(material);
  const iceFootprintShapes = validateCloudEventFootprintShapes(material, footprintShapes);

  const parcels: CloudMassParcel[] = [];
  if (material.parent !== null && footprintShapes.parentLiquid !== null) {
    parcels.push(parcelAt(
      'liquid', material.parent.massKgM2, material.parent.directionUnitVector,
      material.parent.geometricHeightM, footprintShapes.parentLiquid));
  }
  for (const cohort of material.releasedIceCohorts) {
    const footprintShape = iceFootprintShapes.get(cohort.cohortIndex);
    if (footprintShape === undefined) throw new Error('validated ice footprint shape is unavailable');
    parcels.push(parcelAt(
      'ice', cohort.massKgM2, cohort.directionUnitVector, cohort.geometricHeightM,
      footprintShape));
  }

  const touchedCellIndices: number[] = [];
  const touched = new Set<number>();
  for (const parcel of parcels) {
    for (const overlap of parcel.overlaps) {
      if (!touched.has(overlap.cellIndex)) {
        touched.add(overlap.cellIndex);
        touchedCellIndices.push(overlap.cellIndex);
      }
    }
  }
  return { parcels, touchedCellIndices };
}

// 材料が供給した質量の相別期待値 [kg]。堆積の質量収支の照合元。
export function expectedMaterialMassByPhaseKg(
  material: CloudEventMaterialCohorts,
  sourceAreaM2: number,
): Readonly<Record<CloudMassPhase, number>> {
  return {
    liquid: (material.parent?.massKgM2 ?? 0) * sourceAreaM2,
    ice: compensatedSum(material.releasedIceCohorts.map((cohort) => cohort.massKgM2))
      * sourceAreaM2,
  };
}

// 堆積結果の相別質量 [kg]。質量が載るのは parcel の footprint が触れたセルだけなので、
// 照合はそのセルだけで行う — 触れていないセルは堆積の組み立て方から値を持たない。
export function depositedMassKgByPhase(
  deposition: CloudMassDeposition,
  grid: CloudMassGrid,
  touchedCellIndices: readonly number[],
): Readonly<Record<CloudMassPhase, number>> {
  const liquid: SumAccumulator = { total: 0, correction: 0 };
  const ice: SumAccumulator = { total: 0, correction: 0 };
  for (const layer of deposition.columnsByLayer) {
    for (const index of touchedCellIndices) {
      const cellAreaM2 = grid.cells[index]!.areaM2;
      addCompensated(liquid, layer.liquidKgM2ByCell[index]! * cellAreaM2);
      addCompensated(ice, layer.iceKgM2ByCell[index]! * cellAreaM2);
    }
  }
  addCompensated(liquid, deposition.unassignedMassKgByPhase.liquid);
  addCompensated(ice, deposition.unassignedMassKgByPhase.ice);
  return { liquid: liquid.total, ice: ice.total };
}

// 堆積の前後で相別質量が一致することを確かめる。
export function validateDepositedMassBalance(
  expected: Readonly<Record<CloudMassPhase, number>>,
  actual: Readonly<Record<CloudMassPhase, number>>,
): void {
  for (const phase of ['liquid', 'ice'] as const) {
    const targetKg = expected[phase];
    requireFinite(targetKg, `expected ${phase} mass`);
    requireFinite(actual[phase], `deposited ${phase} mass`);
    const toleranceKg = Math.max(Number.MIN_VALUE, Math.abs(targetKg) * 1e-10);
    if (Math.abs(actual[phase] - targetKg) > toleranceKg) {
      throw new RangeError(`${phase} mass is not conserved by event material deposition`);
    }
  }
}
