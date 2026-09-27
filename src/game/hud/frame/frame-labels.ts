// 天体ID・役割・回転ゾーンの選択から、パネルへ表示する日本語ラベルを引き当てる。
// 状態サマリーと回転ゾーンの選択肢で語彙が違う(「自転系」と「自転座標系」など)ので、
// 関数も用途ごとに分ける。
import { frameRoleOf, FrameRole, FrameRotationSource } from '../../../physics/frame';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { CameraRotationFollow } from '../../viewer/focus-camera-selection';

// 役割の日本語表示名。
export function frameRoleName(role: FrameRole): string {
  return role === 'controlled' ? '操作対象' : 'ターゲット';
}

// 状態サマリー向けに、回転ゾーンの選択を日本語表記へ変換する。天体を指す選択の表示名は
// celestialBodies から引く。
export function rotationSourceLabel(
  celestialBodies: CelestialBodies, source: FrameRotationSource | null,
): string {
  if (source === null) return '慣性系';
  if (source.kind === 'spin') return `${celestialBodies.nameOf(source.id)}自転系`;
  const role = frameRoleOf(source.id);
  return role !== null ? `${frameRoleName(role)}公転系` : `${celestialBodies.nameOf(source.id)}回転系`;
}

// 状態サマリー向けに、カメラの回転追従の選択を日本語表記へ変換する。
export function rotationFollowLabel(
  celestialBodies: CelestialBodies, follow: CameraRotationFollow | null,
): string {
  if (follow !== null && follow.kind === 'attitude') return '姿勢追従';
  return rotationSourceLabel(celestialBodies, follow);
}

// 回転ゾーンの選択肢向けに、回転対象を日本語表記へ変換する。
export function rotationSourceChoiceLabel(
  celestialBodies: CelestialBodies, source: FrameRotationSource,
): string {
  if (source.kind === 'spin') return `${celestialBodies.nameOf(source.id)}自転座標系`;
  const role = frameRoleOf(source.id);
  if (role !== null) return `${frameRoleName(role)}の公転`;
  const name = celestialBodies.nameOf(source.id);
  const primary = celestialBodies.findMotion(source.id)?.primary ?? null;
  return primary !== null
    ? `${celestialBodies.nameOf(primary.id)}-${name}回転座標系`
    : `${name}回転座標系`;
}

// 回転ゾーンの選択肢向けに、カメラの回転追従を日本語表記へ変換する。
// 天体レジストリに無い id(機体)は種別名だけで書く。
export function rotationFollowChoiceLabel(
  celestialBodies: CelestialBodies, follow: CameraRotationFollow,
): string {
  if (follow.kind === 'attitude') return '姿勢追従';
  if (celestialBodies.findMotion(follow.id) === null) {
    return follow.kind === 'revolution' ? '公転' : '自転';
  }
  return rotationSourceChoiceLabel(celestialBodies, follow);
}
