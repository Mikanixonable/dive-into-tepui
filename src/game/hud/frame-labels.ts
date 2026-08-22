// 天体(CelestialBodyId)の日本語表示名の引き当て。表示名自体は
// game/celestial/celestial-registry.ts が唯一の定義元で、ここは参照するだけ。
import { CelestialBodyId } from '../../physics/celestial-body';
import { FrameAnchorId, frameRoleOf, FrameRole, FrameRotationSource } from '../../physics/frame';
import { SolarSystemId } from '../../physics/solar-system';
import { CELESTIAL_VIEWS } from '../celestial/celestial-registry';

// id の日本語表示名。CELESTIAL_VIEWS に手作りエントリがある(現実の太陽系の天体)ならそれを、
// なければ(カスタムレジストリの架空天体)id をそのまま表示名として使う。
export function celestialBodyName(id: CelestialBodyId): string {
  return id in CELESTIAL_VIEWS ? CELESTIAL_VIEWS[id as SolarSystemId].name : id;
}

// 役割の日本語表示名。
export function frameRoleName(role: FrameRole): string {
  return role === 'activeShip' ? '操作対象の船' : 'ターゲット';
}

// 役割トークンの FrameAnchorId 表記。
export function frameRoleAnchorId(role: FrameRole): FrameAnchorId {
  return `@${role}`;
}

// 回転ゾーンの選択(サマリ行の rotText)を日本語表記へ変換する。
export function rotationSourceLabel(source: FrameRotationSource | null): string {
  if (source === null) return '慣性系';
  if (source.kind === 'spin') return `${celestialBodyName(source.id)}自転系`;
  const role = frameRoleOf(source.id);
  return role !== null ? `${frameRoleName(role)}公転系` : `${celestialBodyName(source.id)}回転系`;
}
