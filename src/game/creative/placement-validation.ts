// Creative のフォーム入力をDOMやTHREEに依存せず検証する小さな境界。
import { semiMajorFromPeriod } from '../../physics/elements';
import { AttractorId } from '../../physics/attractor';

export type EllipticPlacementInput = {
  bodyRadius: number; mu: number; sizeMode: 'apsides' | 'semiMajorEcc' | 'periodEcc';
  peAltKm: number; apAltKm: number; semiMajorKm: number; eccentricity: number; periodHours: number;
  anglesDeg: readonly number[];
};

// 入力が有効な楕円軌道を表すか検証する。問題なければ null、そうでなければエラーメッセージを返す。
export function validateEllipticPlacement(input: EllipticPlacementInput): string | null {
  const values = [input.peAltKm, input.apAltKm, input.semiMajorKm, input.eccentricity, input.periodHours, ...input.anglesDeg];
  if (!values.every(Number.isFinite)) return '全ての値に有限な数値を入力してください';
  if (!(input.eccentricity >= 0 && input.eccentricity < 1)) return '離心率は 0 以上 1 未満にしてください';
  if (input.sizeMode === 'apsides') return input.peAltKm >= 0 && input.apAltKm >= input.peAltKm ? null : '近地点・遠地点高度を見直してください';
  const a = input.sizeMode === 'semiMajorEcc' ? input.semiMajorKm * 1e3 : semiMajorFromPeriod(input.periodHours * 3600, input.mu);
  return a > 0 && a * (1 - input.eccentricity) > input.bodyRadius ? null : '近地点が天体表面より上の楕円軌道にしてください';
}

// 基地は敵の射程となる惑星近傍を避け、月基準の軌道要素かラグランジュ点指定でのみ設置できる。
// 問題なければ null、そうでなければエラーメッセージを返す。
export function validateBaseReference(
  objectType: 'player' | 'enemy' | 'ammo' | 'base', placementMode: 'elements' | 'libration', body: AttractorId,
): string | null {
  if (objectType !== 'base') return null;
  if (placementMode === 'elements' && body !== 'moon') return '基地は月を基準天体とする軌道要素指定かラグランジュ点指定でのみ配置できます';
  return null;
}
