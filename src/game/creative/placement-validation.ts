// Creative のフォーム入力をDOMやTHREEに依存せず検証する小さな境界。
import { semiMajorFromPeriod } from '../../physics/elements';
import { AttractorId } from '../../physics/attractor';

// UI 側が「どの入力欄が悪いか」を示すための識別子。
export type PlacementFieldId =
  | 'periapsisAltitude' | 'apoapsisAltitude' | 'semiMajorAxis' | 'eccentricity' | 'period'
  | 'inclination' | 'raan' | 'argumentOfPeriapsis' | 'trueAnomaly'
  | 'referenceBody' | 'inPlaneAmplitude' | 'outOfPlaneAmplitude';

export type PlacementFieldIssue = { field: PlacementFieldId; message: string };

export type EllipticPlacementInput = {
  bodyRadius: number; mu: number; sizeMode: 'apsides' | 'semiMajorEcc' | 'periodEcc';
  peAltKm: number; apAltKm: number; semiMajorKm: number; eccentricity: number; periodHours: number;
  incDeg: number; raanDeg: number; argpDeg: number; nuDeg: number;
};

// 入力が有効な楕円軌道を表すか、フィールドごとに検証する。問題がなければ空配列を返す。
export function validateEllipticPlacementFields(input: EllipticPlacementInput): PlacementFieldIssue[] {
  const issues: PlacementFieldIssue[] = [];
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
      issues.push({ field: 'periapsisAltitude', message: '近地点高度は 0 以上にしてください' });
    }
    if (Number.isFinite(input.peAltKm) && Number.isFinite(input.apAltKm) && input.apAltKm < input.peAltKm) {
      issues.push({ field: 'apoapsisAltitude', message: '遠地点高度は近地点高度以上にしてください' });
    }
  } else if (input.sizeMode === 'semiMajorEcc') {
    if (!Number.isFinite(input.semiMajorKm)) issues.push({ field: 'semiMajorAxis', message: '有限な数値を入力してください' });
  } else {
    if (!Number.isFinite(input.periodHours)) issues.push({ field: 'period', message: '有限な数値を入力してください' });
  }
  if (!Number.isFinite(input.eccentricity)) {
    issues.push({ field: 'eccentricity', message: '有限な数値を入力してください' });
  } else if (!(input.eccentricity >= 0 && input.eccentricity < 1)) {
    issues.push({ field: 'eccentricity', message: '離心率は 0 以上 1 未満にしてください' });
  }
  // apsides モードは近地点高度そのものを直接検証済みなので、ここでは半長軸/周期指定の
  // 2モードだけ、導出した近地点半径 a*(1-e) が天体表面より上かを見る。
  if (input.sizeMode !== 'apsides' && Number.isFinite(input.eccentricity) && input.eccentricity >= 0 && input.eccentricity < 1) {
    const a = input.sizeMode === 'semiMajorEcc' ? input.semiMajorKm * 1e3 : semiMajorFromPeriod(input.periodHours * 3600, input.mu);
    if (Number.isFinite(a) && !(a > 0 && a * (1 - input.eccentricity) > input.bodyRadius)) {
      issues.push({
        field: input.sizeMode === 'semiMajorEcc' ? 'semiMajorAxis' : 'period',
        message: '近地点が天体表面より上の楕円軌道にしてください',
      });
    }
  }
  return issues;
}

// 入力が有効な楕円軌道を表すか検証する。問題なければ null、そうでなければ最初のエラーメッセージを返す。
export function validateEllipticPlacement(input: EllipticPlacementInput): string | null {
  return validateEllipticPlacementFields(input)[0]?.message ?? null;
}

export type LibrationPlacementInput = {
  orbitKind: 'halo' | 'lissajous'; inPlaneAmplitudeKm: number; outOfPlaneAmplitudeKm: number;
};

// ラグランジュ点まわりの振幅入力をフィールドごとに検証する。問題がなければ空配列を返す。
// ハローの面内振幅は三次の振幅拘束で面外振幅から決まる(buildLibrationState 参照)ため、
// リサジューのときのみ面内振幅を検証する。
export function validateLibrationPlacementFields(input: LibrationPlacementInput): PlacementFieldIssue[] {
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
  objectType: 'player' | 'enemy' | 'ammo' | 'base', placementMode: 'elements' | 'libration', body: AttractorId,
): PlacementFieldIssue[] {
  if (objectType !== 'base') return [];
  if (placementMode === 'elements' && body !== 'moon') {
    return [{ field: 'referenceBody', message: '基地は月を基準天体とする軌道要素指定かラグランジュ点指定でのみ配置できます' }];
  }
  return [];
}

// 基地の基準天体制約を検証する。問題なければ null、そうでなければエラーメッセージを返す。
export function validateBaseReference(
  objectType: 'player' | 'enemy' | 'ammo' | 'base', placementMode: 'elements' | 'libration', body: AttractorId,
): string | null {
  return validateBaseReferenceFields(objectType, placementMode, body)[0]?.message ?? null;
}
