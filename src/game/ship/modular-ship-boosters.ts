// モジュール船の booster module の点火と燃焼の進行、燃焼管理の表示モデルを所有する。
import { LOCAL_FORWARD, qRotate } from '../../math/quat';
import { scale, type Vec3 } from '../../math/vec3';
import type { PresentationBurnManagement } from '../presentation-ports';
import type { ModularShipMotion } from './modular-ship-motion';
import type { ShipAssembly } from './ship-assembly';
import type { ShipCapabilities } from './ship-capabilities';

// booster の燃焼と表示モデルが読む、艦の面。
interface ModularShipBoosterPort {
  readonly motion: ModularShipMotion;
  readonly assembly: ShipAssembly;
  readonly capabilities: ShipCapabilities;
}

export class ModularShipBoosters {
  public constructor(private readonly port: ModularShipBoosterPort) {}

  // 点火済み booster module を同時に進め、区間平均推力を現在質量の対数平均で加速度へ直す。
  public step(simDt: number): Vec3 | null {
    if (!(simDt > 0)) return null;
    // 区間で燃やせた割合だけ各 booster の推力を足す。
    const massBefore = this.port.motion.mass;
    let averageThrust = 0;
    let consumedAny = false;
    for (const booster of this.port.capabilities.modules('booster', true)) {
      if (!booster.ignited || booster.fuel <= 0) continue;
      const definition = this.port.assembly.definition(booster.id);
      if (definition === null) continue;
      const rate = definition.abilities.fuelConsumptionRate ?? 0;
      const requested = rate * simDt;
      const consumed = rate > 0 ? this.port.assembly.consumeBoosterFuel(booster.id, requested) : 0;
      const burnRatio = rate > 0 ? Math.min(1, consumed / requested) : 1;
      averageThrust += (definition.abilities.thrust ?? 0) * burnRatio;
      consumedAny ||= consumed > 0;
    }
    if (consumedAny) this.port.motion.synchronizeAssembly();
    if (!(averageThrust > 0)) return null;
    // 燃料消費で質量が動いたので、区間の対数平均質量で加速度へ直す。
    const massAfter = this.port.motion.mass;
    const meanMass = Math.abs(massBefore - massAfter) < 1e-12
      ? massAfter
      : (massBefore - massAfter) / Math.log(massBefore / massAfter);
    const acceleration = meanMass > 0 ? averageThrust / meanMass : 0;
    return acceleration > 0
      ? scale(qRotate(this.port.motion.att.q, LOCAL_FORWARD), acceleration)
      : null;
  }

  // booster module の点火状態を切り替え、切替後の状態を返す。booster でなければ失敗にする。
  public toggleIgnition(moduleId: string): boolean {
    const booster = this.port.assembly.module(moduleId);
    if (booster?.kind !== 'booster') throw new Error(`not a booster module: ${moduleId}`);
    const ignited = !(booster.ignited && booster.fuel > 0 && booster.hp > 0);
    this.port.assembly.setIgnited(moduleId, ignited);
    this.port.motion.invalidatePrediction();
    const updated = this.port.assembly.module(moduleId);
    return updated?.kind === 'booster' && updated.ignited;
  }

  // ブースターとデカプラーがある艦の燃焼管理表示を組み立てる。
  public burnManagementViewModel(): PresentationBurnManagement | null {
    // booster・decoupler がどちらも無ければ表示するものは無い。
    const boosters = this.port.capabilities.modules('booster');
    const decouplers = this.port.capabilities.modules('decoupler');
    if (boosters.length === 0 && decouplers.length === 0) return null;
    const activeFuel = boosters.reduce((total, module) => total + module.fuel, 0);
    const activeFuelMax = boosters.reduce(
      (total, module) => total + (this.port.assembly.definition(module.id)?.abilities.fuelCapacity ?? 0), 0,
    );
    const anyIgnited = boosters.some(module => module.ignited && module.fuel > 0 && module.hp > 0);
    // 残量と点火状態から燃焼段の状態を決め、モジュール1つ1行の項目へ並べる。
    return {
      stageCount: boosters.length,
      totalMass: this.port.motion.mass,
      activeFuel,
      activeFuelMax,
      burnState: boosters.length === 0 ? 'idle'
        : activeFuel <= 0 ? 'empty' : anyIgnited ? 'burning' : 'ready',
      modules: [
        ...decouplers.map(module => ({
          id: module.id,
          kind: 'decoupler' as const,
          state: module.hp > 0 ? 'connected' as const : 'destroyed' as const,
        })),
        ...boosters.map(module => ({
          id: module.id,
          kind: 'booster' as const,
          state: module.fuel <= 0 ? 'fuel-empty' as const : module.ignited ? 'burning' as const : 'stopped' as const,
        })),
      ],
    };
  }
}
