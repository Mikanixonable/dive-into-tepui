// 天体ID・役割・回転ゾーンの選択から、パネルへ表示する日本語ラベルを引き当てる。
import { frameRoleOf, FrameRole, FrameRotationSource } from '../../../physics/frame';
import type { CameraRotationFollow } from '../../camera/focus-camera';
import type { CelestialSystem } from '../../celestial/celestial-system';

// 役割の日本語表示名。
export function frameRoleName(role: FrameRole): string {
  return role === 'activeShip' ? '操作対象の船' : 'ターゲット';
}

// 回転ゾーンの選択を日本語表記へ変換する。天体を指す選択の表示名は celestialSystem から引く。
export function rotationSourceLabel(
  celestialSystem: CelestialSystem, source: FrameRotationSource | null,
): string {
  if (source === null) return '慣性系';
  if (source.kind === 'spin') return `${celestialSystem.nameOf(source.id)}自転系`;
  const role = frameRoleOf(source.id);
  return role !== null ? `${frameRoleName(role)}公転系` : `${celestialSystem.nameOf(source.id)}回転系`;
}

// カメラの回転追従の選択を日本語表記へ変換する。
export function rotationFollowLabel(
  celestialSystem: CelestialSystem, follow: CameraRotationFollow | null,
): string {
  if (follow !== null && follow.kind === 'attitude') return '姿勢追従';
  return rotationSourceLabel(celestialSystem, follow);
}
