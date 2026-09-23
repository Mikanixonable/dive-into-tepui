// モジュール船のケース。基地へ寄港した船と建造ゴースト、分離の前後を、ゲーム本体と同じ組み立てと
// モデルで組む。
import * as THREE from 'three/webgpu';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { createBasePreset, createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { splitAtDecoupler } from '../../src/game/ship/ship-decoupling';
import { DockSnapGuideView } from '../../src/render/dynamic/ship/dock-snap-guide-view';
import { buildShipModuleModel } from '../../src/render/dynamic/ship/ship-module-models';
import { ShipGhostView } from '../../src/render/dynamic/ship/ship-ghost-view';
import { labCamera, shipObject, type CaseBuilder, type LabCase } from './lab-case';

// カタログの定義 definitionId から、識別子 id のモジュールを1つ作る。
function module(definitionId: string, id: string) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
}

// 分離機を挟んでブースターを付けた船。
function separationPreset(): ShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(module('cockpit-standard', 'cockpit'));
  assembly.append(module('tank-3-main', 'tank'));
  assembly.append(module('decoupler-standard', 'decoupler'));
  assembly.append(module('booster-standard', 'booster'));
  return assembly;
}

// 基地の左の寄港口へ、小さな船を寄港させた組み。
function dockedPreset(): ShipAssembly {
  const vessel = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  vessel.addRoot(module('cockpit-standard', 'docked-cockpit'));
  vessel.prepend(module('docking-port-standard', 'docked-port'));
  vessel.append(module('tank-3-main', 'docked-tank'));
  return createBasePreset().mergedAtDock(vessel, 'dock-left', 'docked-port', 'docked').assembly;
}

// 物体を (x, y, z) [m] へ置き、機軸の端と側面の両方が見える姿勢へ回して返す。
function at(object: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  object.position.set(x, y, z);
  object.rotation.set(-0.35, 0.45, 0.08);
  return object;
}

// 基地: 船を寄港させた基地と、その右に建造ゴーストと吸着ガイドを置く。
function base(): LabCase {
  const docked = at(shipObject(dockedPreset()), -7, 0, -42);
  const ghost = new ShipGhostView(undefined, buildShipModuleModel, false);
  const guide = new DockSnapGuideView(undefined, false);
  // ゴーストは寄港した船にも基地にも重ならない位置に離し、ガイドはゴーストの奥の面へ付ける。
  ghost.sync({ modelId: 'tank-6-main', position: v3(12, 0, -36), rotation: Q_IDENTITY, valid: true });
  guide.sync({ position: v3(12, 0, -39.5), rotation: Q_IDENTITY, radius: 3, valid: true });
  return {
    objects: [docked, ghost.object, guide.object],
    camera: labCamera(),
    viewTarget: new THREE.Vector3(2, 0, -40),
  };
}

// 分離: 分離前の船と、分離機で分けた 2 隻を並べる。
function separation(): LabCase {
  const source = separationPreset();
  const split = splitAtDecoupler(source, 'decoupler');
  return {
    // 互いに重ならないよう、左から横一列に並べる。
    objects: [
      at(shipObject(source), -17, 0, -40),
      at(shipObject(split.retained), 1, 0, -40),
      at(shipObject(split.detached), 16, 0, -40),
    ],
    camera: labCamera(),
    viewTarget: new THREE.Vector3(0, 0, -40),
  };
}

// 戦闘艦: 展開された太陽電池とラジエーター、コックピット、タンク、推進器が美しく見える構図。
function combat(): LabCase {
  const combatShip = createDefaultCombatPreset();
  for (const m of combatShip.modules) {
    if (m.kind === 'solar_panel' || m.kind === 'radiator') {
      combatShip.setDeployment(m.id, 1.0);
    }
  }
  const obj = at(shipObject(combatShip), 0, -1, -25);
  obj.rotation.set(0.35, -2.35, 0.1);
  return {
    objects: [obj],
    camera: labCamera(),
    viewTarget: new THREE.Vector3(0, -1, -25),
  };
}

export const SHIP_CASES = {
  'modular-ship-base': base,
  'modular-ship-separation': separation,
  'modular-ship-combat': combat,
} as const satisfies Record<string, CaseBuilder>;
