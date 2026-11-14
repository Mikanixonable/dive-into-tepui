// 建造画面の視点を寄せる対象を、船体の姿勢と運動状態から求める。
import type { Vec3 } from '../../math/vec3';
import type { ModularShip } from './modular-ship';

// 視点を寄せる対象。船体の中の1点(ECI [m])と、それを収める外接半径 [m]。
export interface ConstructionFocus {
  readonly position: Vec3;
  readonly radius: number;
}

// モジュールの ECI 位置と外接半径。読めなければ null。
export function constructionModuleFocus(
  ship: ModularShip, moduleId: string | null,
): ConstructionFocus | null {
  if (moduleId === null) return null;
  const transform = ship.assembly.worldTransformOf(moduleId);
  const definition = ship.assembly.definition(moduleId);
  if (transform === null || definition === null) return null;
  // 船体の重心を差し引いたルート位置へ、モジュールの相対位置を姿勢で回して載せる。
  return {
    position: ship.motion.assemblyToEci(transform.position),
    radius: Math.hypot(definition.length, definition.diameter) / 2,
  };
}
