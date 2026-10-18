// 建造の入口: 操作対象の船体が持つ使用可能な建造ドックの列挙と、指定・最寄りのドックから
// 建造セッションを開く処理。始められない理由はヒントで通知する。
import { qRotate } from '../../math/quat';
import { add, lenSq, sub, type Vec3 } from '../../math/vec3';
import type { ShipModuleInstance } from './ship-module-instance';
import type { ModularShip } from './modular-ship';
import type { Notifier } from '../../hud/notifier';
import type { ShipConstruction } from './ship-construction';

// 使用可能な建造ドックか。健全な(hp > 0 の)建造ドックだけが使え、接続中かどうかは問わない。
export function isUsableConstructionDock(module: ShipModuleInstance): boolean {
  return module.kind === 'dock' && module.hp > 0;
}

// ship が持つ使用可能な建造ドックの一覧。
export function usableConstructionDocks(ship: ModularShip): readonly ShipModuleInstance[] {
  return ship.assembly.modules.filter(isUsableConstructionDock);
}

// ship が建造を始められる状態か。健全なコックピットで操縦でき、使用可能な建造ドックを持つこと。
export function hasUsableConstructionDock(ship: ModularShip): boolean {
  return ship.capabilities.controllable && usableConstructionDocks(ship).length > 0;
}

// 建造セッションの開始口。選んだドックと、カメラに最も近い使用可能ドックの2経路を持つ。
export class ConstructionEntry {
  public constructor(
    private readonly construction: ShipConstruction,
    private readonly notifier: Notifier,
  ) {}

  // dockId のドックから建造を始める。始められたら true。拒否理由はヒントで示す。
  public startAt(ship: ModularShip, dockId: string): boolean {
    try {
      this.construction.start(ship, dockId);
      return true;
    } catch (error) {
      this.notifier.hint(error instanceof Error ? error.message : '建造を開始できません', undefined, 'warn');
      return false;
    }
  }

  // 使用可能なドックのうち cameraPosition(ECI [m])に最も近いものから建造を始める。
  // 始められるドックが無ければ理由をヒントで示す。
  public startNearestDock(ship: ModularShip, cameraPosition: Vec3): void {
    if (!ship.capabilities.controllable) {
      this.notifier.hint('健全なコックピットから操作できる船体が必要です', undefined, 'warn');
      return;
    }
    const docks = usableConstructionDocks(ship);
    if (docks.length === 0) {
      this.notifier.hint('使用可能な建造ドックがありません', undefined, 'warn');
      return;
    }
    let nearest: ShipModuleInstance | null = null;
    let nearestDistance = Infinity;
    for (const dock of docks) {
      const position = moduleEci(ship, dock.id);
      const distance = position === null ? Infinity : lenSq(sub(position, cameraPosition));
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = dock;
      }
    }
    if (nearest !== null) this.startAt(ship, nearest.id);
  }
}

// モジュールの ECI 位置 [m]。assembly 座標の配置を船体の現在の位置・姿勢へ写す。
function moduleEci(ship: ModularShip, moduleId: string): Vec3 | null {
  const transform = ship.assembly.worldTransformOf(moduleId);
  if (transform === null) return null;
  const root = sub(ship.motion.state.r, qRotate(ship.motion.att.q, ship.motion.centerOffset));
  return add(root, qRotate(ship.motion.att.q, transform.position));
}
