// 天体ID・役割・回転ゾーンの選択から、パネルへ表示する日本語ラベルを引き当てる。
// 状態サマリーと図案タイルで語彙の長さが違うので、用途ごとに関数を分ける。
import { frameRoleOf, type FrameRole, type FrameRotationSource } from '../../../physics/frame';
import type { CelestialBodies } from '../../celestial/celestial-bodies';
import type { CameraReferencePlane, CameraRotationFollow } from '../../viewer/focus-camera-selection';

// 役割の日本語表示名。
export function frameRoleName(role: FrameRole): string {
  return role === 'controlled' ? '操作対象' : 'ターゲット';
}

// 基準面の日本語名。
export function referencePlaneLabel(plane: CameraReferencePlane): string {
  switch (plane) {
    case 'ecliptic': return '黄道面';
    case 'equator': return '赤道面';
    case 'moonOrbit': return '月軌道面';
  }
}

// 状態サマリー向けに、回転ゾーンの選択を日本語表記へ変換する。天体を指す選択の表示名は
// celestialBodies から引く。
export function rotationSourceLabel(
  celestialBodies: CelestialBodies, source: FrameRotationSource | null,
): string {
  if (source === null) return '慣性';
  if (source.kind === 'spin') return `${celestialBodies.nameOf(source.id)}自転`;
  const role = frameRoleOf(source.id);
  if (role !== null) return `${frameRoleName(role)}公転`;
  const name = celestialBodies.nameOf(source.id);
  const primary = celestialBodies.findMotion(source.id)?.primary ?? null;
  return primary !== null
    ? `${celestialBodies.nameOf(primary.id)}–${name}公転`
    : `${name}公転`;
}

// 状態サマリー向けに、カメラの回転追従の選択を日本語表記へ変換する。
export function rotationFollowLabel(
  celestialBodies: CelestialBodies, follow: CameraRotationFollow | null,
): string {
  if (follow !== null && follow.kind === 'attitude') return '姿勢追従';
  return rotationSourceLabel(celestialBodies, follow);
}

// 図案タイル向けの短い回転ラベル。狭い幅でも改行・省略で崩れない短さへ整える。
export function rotationTileLabel(
  celestialBodies: CelestialBodies, follow: CameraRotationFollow | null,
): string {
  if (follow === null) return '慣性';
  if (follow.kind === 'attitude') return '姿勢追従';
  if (follow.kind === 'spin') {
    const motion = celestialBodies.findMotion(follow.id);
    return motion === null ? '自転' : `${celestialBodies.nameOf(follow.id)}自転`;
  }
  const role = frameRoleOf(follow.id);
  if (role !== null) return role === 'controlled' ? '自機公転' : '標的公転';
  if (celestialBodies.findMotion(follow.id) === null) return '公転';
  const name = celestialBodies.nameOf(follow.id);
  const primary = celestialBodies.findMotion(follow.id)?.primary ?? null;
  if (primary === null) return `${name}公転`;
  const pName = celestialBodies.nameOf(primary.id);
  // 短い天体名(地球-月・太陽-地球など)は連結して「誰との回転系か」を1語で見せる。
  return `${pName}–${name}`;
}

// 回転セクションの見出し右端に出す、現在選択中の回転の短い意味説明。
export function rotationHintLabel(
  celestialBodies: CelestialBodies, follow: CameraRotationFollow | null,
): string {
  if (follow === null) return '恒星に対して固定';
  if (follow.kind === 'attitude') return '機体の姿勢に追従';
  if (follow.kind === 'spin') {
    return celestialBodies.findMotion(follow.id) !== null
      ? `${celestialBodies.nameOf(follow.id)}の地表が静止`
      : '対象の自転に追従';
  }
  const role = frameRoleOf(follow.id);
  if (role !== null) return `${frameRoleName(role)}の公転に追従`;
  const motion = celestialBodies.findMotion(follow.id);
  if (motion === null) return '対象の公転に追従';
  const name = celestialBodies.nameOf(follow.id);
  const primary = motion.primary;
  return primary !== null
    ? `${celestialBodies.nameOf(primary.id)}–${name}線が静止`
    : `${name}の公転に追従`;
}
