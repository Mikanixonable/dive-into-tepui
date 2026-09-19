// クリエイティブモードの物体配置フォームの入力値を、入力欄ごとに検証する。
import { semiMajorFromPeriod } from '../../physics/elements';
import { getApsisLabelSpec } from '../hud/orbit/orbit-labels';
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';

// 検証に落ちた入力欄の識別子。
export type PlacementFieldId =
  | 'periapsisAltitude' | 'apoapsisAltitude' | 'semiMajorAxis' | 'eccentricity' | 'period'
  | 'inclination' | 'raan' | 'argumentOfPeriapsis' | 'trueAnomaly'
  | 'referenceCelestialBody' | 'inPlaneAmplitude' | 'outOfPlaneAmplitude';

export interface PlacementFieldIssue { readonly field: PlacementFieldId; readonly message: string }

type EllipticSizeInput =
  | { readonly sizeMode: 'apsides'; readonly peAltKm: number; readonly apAltKm: number }
  | { readonly sizeMode: 'semiMajorEcc'; readonly semiMajorKm: number; readonly eccentricity: number }
  | { readonly sizeMode: 'periodEcc'; readonly periodHours: number; readonly eccentricity: number };

export type EllipticPlacementInput = {
  readonly centerRadius: number; readonly mu: number; readonly centerId?: string;
  readonly incDeg: number; readonly raanDeg: number; readonly argpDeg: number; readonly nuDeg: number;
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
  // 導出した近地点半径 a(1-e) が天体表面より上か。
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

type LagrangePlacementInput =
  | { readonly orbitKind: 'halo'; readonly outOfPlaneAmplitudeKm: number }
  | {
    readonly orbitKind: 'lissajous'; readonly inPlaneAmplitudeKm: number; readonly outOfPlaneAmplitudeKm: number;
  };

// ラグランジュ点まわりの振幅入力をフィールドごとに検証する。問題がなければ空配列を返す。
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

// 基地の設置先の制約(SPEC GAME.md 9.1「基地の設置先」)を検証する。問題がなければ空配列を返す。
export function validateBaseReferenceFields(
  entityKind: DynamicEntityKind, placementMode: 'elements' | 'lagrange', celestialBody?: string,
): PlacementFieldIssue[] {
  if (entityKind !== 'base') return [];
  if (placementMode === 'elements' && celestialBody !== 'moon') {
    return [{ field: 'referenceCelestialBody', message: '基地は月を基準天体とする軌道要素指定かラグランジュ点指定でのみ配置できます' }];
  }
  return [];
}
