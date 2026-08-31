// Creative のフォーム入力をDOMやTHREEに依存せず検証する小さな境界。
import { semiMajorFromPeriod } from '../../physics/elements';
import { getApsisLabelSpec } from '../hud/orbit/orbit-labels';
import type { ObjectType } from '../random-name';

// UI 側が「どの入力欄が悪いか」を示すための識別子。
export type PlacementFieldId =
  | 'periapsisAltitude' | 'apoapsisAltitude' | 'semiMajorAxis' | 'eccentricity' | 'period'
  | 'inclination' | 'raan' | 'argumentOfPeriapsis' | 'trueAnomaly'
  | 'referenceCelestialBody' | 'inPlaneAmplitude' | 'outOfPlaneAmplitude';

export type PlacementFieldIssue = { field: PlacementFieldId; message: string };

export type EllipticSizeInput =
  | { sizeMode: 'apsides'; peAltKm: number; apAltKm: number }
  | { sizeMode: 'semiMajorEcc'; semiMajorKm: number; eccentricity: number }
  | { sizeMode: 'periodEcc'; periodHours: number; eccentricity: number };

export type EllipticPlacementInput = {
  centerRadius: number; mu: number; centerId?: string;
  incDeg: number; raanDeg: number; argpDeg: number; nuDeg: number;
} & EllipticSizeInput;

// 入力が有効な楕円軌道を表すか、フィールドごとに検証する。問題がなければ空配列を返す。
export function validateEllipticPlacementFields(input: EllipticPlacementInput): PlacementFieldIssue[] {
  const issues: PlacementFieldIssue[] = [];
  const peSpec = getApsisLabelSpec('pe', input.centerId ?? 'earth');
  const apSpec = getApsisLabelSpec('ap', input.centerId ?? 'earth');

  const angleFields: readonly [PlacementFieldId, number][] = [
    ['inclination', input.incDeg], ['raan', input.raanDeg],
    ['argumentOfPeriapsis', input.argpDeg], ['trueAnomaly', input.nuDeg],
  ];
  for (const [field, value] of angleFields) {
    if (!Number.isFinite(value)) issues.push({ field, message: '有限な数値を入力してください' });
  }
  if (input.sizeMode === 'apsides') {
    if (!Number.isFinite(input.peAltKm)) issues.push({ field: 'periapsisAltitude', message: '有限な数値を入力してください' });
    if (!Number.isFinite(input.apAltKm)) issues.push({ field: 'apoapsisAltitude', message: '有限な数値を入力してください' });
    if (Number.isFinite(input.peAltKm) && input.peAltKm < 0) {
      issues.push({ field: 'periapsisAltitude', message: `${peSpec.nameJa}高度は 0 以上にしてください` });
    }
    if (Number.isFinite(input.peAltKm) && Number.isFinite(input.apAltKm) && input.apAltKm < input.peAltKm) {
      issues.push({ field: 'apoapsisAltitude', message: `${apSpec.nameJa}高度は${peSpec.nameJa}高度以上にしてください` });
    }
    return issues;
  }
  if (input.sizeMode === 'semiMajorEcc') {
    if (!Number.isFinite(input.semiMajorKm)) issues.push({ field: 'semiMajorAxis', message: '有限な数値を入力してください' });
  } else {
    if (!Number.isFinite(input.periodHours)) issues.push({ field: 'period', message: '有限な数値を入力してください' });
  }
  if (!Number.isFinite(input.eccentricity)) {
    issues.push({ field: 'eccentricity', message: '有限な数値を入力してください' });
  } else if (!(input.eccentricity >= 0 && input.eccentricity < 1)) {
    issues.push({ field: 'eccentricity', message: '離心率は 0 以上 1 未満にしてください' });
  }
  // 導出した近地点半径 a*(1-e) が天体表面より上かを見る(apsides モードは近地点高度
  // そのものを上で直接検証済みなので、ここは半長軸/周期指定の2モードだけが通る)。
  if (Number.isFinite(input.eccentricity) && input.eccentricity >= 0 && input.eccentricity < 1) {
    const a = input.sizeMode === 'semiMajorEcc' ? input.semiMajorKm * 1e3 : semiMajorFromPeriod(input.periodHours * 3600, input.mu);
    if (Number.isFinite(a) && !(a > 0 && a * (1 - input.eccentricity) > input.centerRadius)) {
      issues.push({
        field: input.sizeMode === 'semiMajorEcc' ? 'semiMajorAxis' : 'period',
        message: `${peSpec.nameJa}が天体表面より上の楕円軌道にしてください`,
      });
    }
  }
  return issues;
}

export type LagrangePlacementInput =
  | { orbitKind: 'halo'; outOfPlaneAmplitudeKm: number }
  | { orbitKind: 'lissajous'; inPlaneAmplitudeKm: number; outOfPlaneAmplitudeKm: number };

// ラグランジュ点まわりの振幅入力をフィールドごとに検証する。問題がなければ空配列を返す。
// ハローの面内振幅は三次の振幅拘束で面外振幅から決まる(buildLagrangeState 参照)ため、
// リサジューのときのみ面内振幅を検証する。
export function validateLagrangePlacementFields(input: LagrangePlacementInput): PlacementFieldIssue[] {
  const issues: PlacementFieldIssue[] = [];
  if (!(Number.isFinite(input.outOfPlaneAmplitudeKm) && input.outOfPlaneAmplitudeKm > 0)) {
    issues.push({ field: 'outOfPlaneAmplitude', message: '面外振幅には有限の正数を入力してください' });
  }
  if (input.orbitKind === 'lissajous' && !(Number.isFinite(input.inPlaneAmplitudeKm) && input.inPlaneAmplitudeKm > 0)) {
    issues.push({ field: 'inPlaneAmplitude', message: '面内振幅には有限の正数を入力してください' });
  }
  return issues;
}

// 基地は敵の射程となる惑星近傍を避け、月基準の軌道要素かラグランジュ点指定でのみ設置できる。
// 問題がなければ空配列を返す。
export function validateBaseReferenceFields(
  objectType: ObjectType, placementMode: 'elements' | 'lagrange', celestialBody?: string,
): PlacementFieldIssue[] {
  if (objectType !== 'base') return [];
  if (placementMode === 'elements' && celestialBody !== 'moon') {
    return [{ field: 'referenceCelestialBody', message: '基地は月を基準天体とする軌道要素指定かラグランジュ点指定でのみ配置できます' }];
  }
  return [];
}
