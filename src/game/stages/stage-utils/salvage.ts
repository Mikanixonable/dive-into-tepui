// 撃破した敵が落とす素材サルベージ(実軌道上に残る漂流物)の配置と回収。
// サルベージはコックピットを持たない船体で、接近して相対速度を落とすか、
// ドッキングして船体へ取り込むことで回収でき、素材は最寄りの基地へ加わる
// (GAME.md 11.4)。落とすかどうかと量はステージが決め、ここは置き方と
// 回収の判定だけを持つ。
import { len, sub } from '../../../math/vec3';
import type { KinematicState } from '../../../physics/kinematic-state';
import { ModularShip } from '../../ship/modular-ship';
import { ShipAssembly } from '../../ship/ship-assembly';
import { SHIP_MODULE_CATALOG } from '../../ship/ship-module-catalog';
import { createShipModuleInstance } from '../../ship/ship-module-instance';
import type { EntityRegistry } from '../../dynamic/entity-registry';
import type { EntityRoster } from '../../dynamic/entity-roster';
import type * as THREE from 'three/webgpu';

// サルベージの根モジュール id。ドッキングで取り込まれたかは、この部品が
// 別の船体へ移ったことで判定する。
export const SALVAGE_ROOT_MODULE_ID = 'salvage-tank';
// 回収とみなす距離 [m] と相対速度 [m/s]。漂流デブリの回収と同じ物差し。
export const SALVAGE_CAPTURE_DISTANCE = 200;
export const SALVAGE_CAPTURE_RELATIVE_SPEED = 15;

// 回収1件ぶんの結果。素材は拠点 baseId の備蓄へ加わる。
export interface SalvageRecovery {
  readonly baseId: string;
  readonly materials: number;
}

export interface SerializedSalvage {
  // サルベージのエンティティ id → その素材量。船体そのものは動的システムが持つ。
  readonly amounts: Readonly<Record<string, number>>;
}

// サルベージの船体。タンクにドッキング口を付けただけの物資で、質量を持つ。
export function buildSalvageAssembly(): ShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, false);
  const instance = (definitionId: string, id: string) =>
    createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
  assembly.addRoot(instance('tank-6-main', SALVAGE_ROOT_MODULE_ID));
  assembly.connectSide(instance('docking-port-standard', 'salvage-docking-port'), SALVAGE_ROOT_MODULE_ID, 'side:+y');
  assembly.assertValid();
  return assembly;
}

// 軌道上のサルベージとその素材量の台帳。回収のたびに項目が消える。
export class Salvage {
  private readonly amounts = new Map<string, number>();

  // 追跡中のサルベージの素材量から組む。省いた値は空の台帳から始める。
  public constructor(amounts: Readonly<Record<string, number>> = {}) {
    for (const [id, materials] of Object.entries(amounts)) this.amounts.set(id, materials);
  }

  // 直列化した台帳から復元する。記録が無ければ空の台帳から始める。
  public static deserialize(serialized: SerializedSalvage | null | undefined): Salvage {
    return new Salvage(serialized?.amounts ?? {});
  }

  // 台帳を直列化した形へ畳む。
  public serialize(): SerializedSalvage {
    return { amounts: Object.fromEntries(this.amounts) };
  }

  // 追跡中のサルベージの数。
  public get trackedCount(): number { return this.amounts.size; }

  // state の位置・速度でサルベージを1つ置き、素材量を台帳へ載せる。
  public spawn(
    state: KinematicState, materials: number,
    registry: EntityRegistry & EntityRoster, scene: THREE.Scene,
  ): ModularShip {
    const ship = ModularShip.create(
      { name: '素材サルベージ', assembly: buildSalvageAssembly(), state },
      registry,
      scene,
    );
    registry.add(ship);
    this.amounts.set(ship.id, materials);
    return ship;
  }

  // 回収判定を1フレーム分進め、このフレームに回収された分を返す。ships は
  // その時点の全船体、fallbackBaseId は基地が1つも見つからないときの備蓄先。
  public update(
    ships: readonly ModularShip[], fallbackBaseId: string,
  ): readonly SalvageRecovery[] {
    const recovered: SalvageRecovery[] = [];
    for (const [id, materials] of [...this.amounts]) {
      const salvage = ships.find((ship) => ship.id === id);
      if (salvage !== undefined && salvage.motion.alive) {
        const capturer = ships.find((ship) => (
          ship.id !== id && ship.assembly.playerOwned && ship.motion.alive
          && len(sub(ship.motion.state.r, salvage.motion.state.r)) < SALVAGE_CAPTURE_DISTANCE
          && len(sub(ship.motion.state.v, salvage.motion.state.v)) < SALVAGE_CAPTURE_RELATIVE_SPEED
        ));
        if (capturer === undefined) continue;
        salvage.motion.kill();
        this.amounts.delete(id);
        recovered.push({ baseId: this.nearestBaseId(ships, salvage, fallbackBaseId), materials });
        continue;
      }
      // サルベージの船体が消えている場合、根モジュールが別船体へ移っていれば
      // ドッキングで取り込まれた回収、移っていなければ喪失として台帳から落とす。
      this.amounts.delete(id);
      const holder = ships.find((ship) => (
        !this.amounts.has(ship.id) && ship.assembly.moduleIds.includes(SALVAGE_ROOT_MODULE_ID)
      ));
      if (holder !== undefined) {
        recovered.push({ baseId: this.nearestBaseId(ships, holder, fallbackBaseId), materials });
      }
    }
    return recovered;
  }

  // from の位置に最も近い、基地の役割を持つ生存中の船体の id。無ければ fallbackBaseId。
  private nearestBaseId(
    ships: readonly ModularShip[], from: ModularShip, fallbackBaseId: string,
  ): string {
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const ship of ships) {
      if (!ship.motion.alive || ship.assembly.role !== 'base') continue;
      const distance = len(sub(ship.motion.state.r, from.motion.state.r));
      if (distance < bestDistance) {
        bestDistance = distance;
        best = ship.id;
      }
    }
    return best ?? fallbackBaseId;
  }
}
