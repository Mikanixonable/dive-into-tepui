// モジュール船の組み上がり、建造ゴースト、分離前後を本番と同じ asset loader で確認する。
import * as THREE from 'three/webgpu';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { createBasePreset, createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { shipPhysicsShape } from '../../src/game/ship/ship-physics-shape';
import { DockSnapGuideView } from '../../src/render/dynamic/ship/dock-snap-guide-view';
import { ModularShipView } from '../../src/render/dynamic/ship/modular-ship-view';
import { buildShipModuleModel } from '../../src/render/dynamic/ship/ship-module-models';
import { ShipGhostView } from '../../src/render/dynamic/ship/ship-ghost-view';
import type { LabCase } from './cases';

const FOV_DEG = 50;
const VIEW_WIDTH = 960;
const VIEW_HEIGHT = 540;

function camera(): THREE.PerspectiveCamera {
  const result = new THREE.PerspectiveCamera(FOV_DEG, VIEW_WIDTH / VIEW_HEIGHT, 0.1, 1_000);
  result.position.set(0, 0, 0);
  result.lookAt(0, 0, -1);
  result.updateMatrixWorld();
  return result;
}

function module(definitionId: string, id: string) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
}

function separationPreset(): ShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(module('cockpit-standard', 'cockpit'));
  assembly.append(module('tank-3-main', 'tank'));
  assembly.append(module('decoupler-standard', 'decoupler'));
  assembly.append(module('booster-standard', 'booster'));
  return assembly;
}

function shipObject(assembly: ShipAssembly): THREE.Object3D {
  const shape = shipPhysicsShape(assembly);
  if (shape === null) throw new Error('render-lab ship assembly is empty');
  const view = new ModularShipView(buildShipModuleModel, undefined, false);
  view.sync(assembly, shape.centerOffset);
  // LabCase が scene と共に寿命を持つため、ここでは表示 root だけを渡す。
  view.object.userData.renderLabShipView = view;
  return view.object;
}

function at(object: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  object.position.set(x, y, z);
  object.rotation.set(-0.35, 0.45, 0.08);
  return object;
}

function modularShipCase(assembly: ShipAssembly, depth = -28): LabCase {
  const object = at(shipObject(assembly), 0, 0, depth);
  return { objects: [object], camera: camera(), viewTarget: object.position };
}

function constructionGhost(): LabCase {
  const base = at(shipObject(createBasePreset()), -4, 0, -32);
  const ghost = new ShipGhostView(undefined, buildShipModuleModel, false);
  const guide = new DockSnapGuideView(undefined, false);
  const position = v3(5, 0, -27);
  ghost.sync({ modelId: 'tank-6-main', position, rotation: Q_IDENTITY, valid: true });
  guide.sync({ position: v3(5, 0, -30.5), rotation: Q_IDENTITY, radius: 3, valid: true });
  return {
    objects: [base, ghost.object, guide.object],
    camera: camera(),
    viewTarget: new THREE.Vector3(0, 0, -30),
  };
}

function separatedShips(): LabCase {
  const source = separationPreset();
  const decouplerEdge = source.graph.find(edge => edge.childId === 'decoupler');
  if (decouplerEdge === undefined) throw new Error('render-lab separation preset lacks decoupler edge');
  const [inner, outerWithDecoupler] = source.splitAt(decouplerEdge.id);
  outerWithDecoupler.removeModule('booster');
  const outer = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  outer.addRoot(module('booster-standard', 'booster-after'));
  const innerObject = at(shipObject(inner), -5, 0, -30);
  const outerObject = at(shipObject(outer), 6, 0, -30);
  return {
    objects: [innerObject, outerObject],
    camera: camera(),
    viewTarget: new THREE.Vector3(0, 0, -30),
  };
}

export const SHIP_CASES: Record<string, () => LabCase> = {
  'modular-ship-default': () => modularShipCase(createDefaultCombatPreset()),
  'modular-ship-base': () => modularShipCase(createBasePreset(), -36),
  'modular-ship-ghost': constructionGhost,
  'modular-ship-pre-separation': () => modularShipCase(separationPreset()),
  'modular-ship-post-separation': separatedShips,
};
