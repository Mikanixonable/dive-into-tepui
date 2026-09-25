// ShipAssembly の現在値を、描画層が参照する不変な表示用データモデルへ変換する。
import type { ShipRenderAssembly } from '../../render/dynamic/ship/ship-render-contract';
import type { ShipAssembly } from './ship-assembly';
import type { ShipModuleInstance } from './ship-module-instance';

export function shipRenderAssembly(assembly: ShipAssembly): ShipRenderAssembly {
  return {
    modules: assembly.modules.map((module) => {
      const definition = assembly.definition(module.id);
      const transform = assembly.worldTransformOf(module.id);
      if (definition === null || transform === null) {
        throw new Error(`assembly module is incomplete: ${module.id}`);
      }
      return {
        id: module.id,
        modelId: definition.modelId,
        kind: module.kind,
        hp: module.hp,
        maxHp: definition.maxHp,
        deployed: deploymentOf(module),
        burning: module.kind === 'booster' ? module.ignited && module.fuel > 0 : null,
        transform,
      };
    }),
  };
}

function deploymentOf(module: ShipModuleInstance): number | null {
  return module.kind === 'radiator' || module.kind === 'solar_panel' ? module.deployed : null;
}
