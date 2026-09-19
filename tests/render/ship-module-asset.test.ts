// 焼き込み済み ship module asset とカタログの契約。モデルの UUID や頂点列ではなく、
// module 境界、メートル単位、+Z 接続面、semantic anchor だけを固定する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import shipModulesData from '../../src/assets/models/shipModules.json';
import { buildShipModuleModel } from '../../src/render/dynamic/ship/ship-module-models';
import { disposeOwnedRenderResources } from '../../src/render/dispose-owned-render-resources';
import { test } from '../harness';

function parsedRoot(): THREE.Group {
  return new THREE.ObjectLoader().parse(shipModulesData) as THREE.Group;
}

function moduleRoots(root: THREE.Group): Map<string, THREE.Object3D> {
  const result = new Map<string, THREE.Object3D>();
  for (const child of root.children) {
    const modelId = child.userData.moduleModelId;
    if (typeof modelId !== 'string') continue;
    assert.equal(result.has(modelId), false, `duplicate module model: ${modelId}`);
    result.set(modelId, child);
  }
  return result;
}

function semanticAnchor(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let result: THREE.Object3D | null = null;
  root.traverse((child) => {
    if (child.userData.semanticAnchor === name) result = child;
  });
  return result;
}

export function register(): void {
  test('ship module asset: catalog の全 modelId が独立した等倍 Group を持つ', () => {
    const root = parsedRoot();
    const modules = moduleRoots(root);
    const modelIds = new Set(SHIP_MODULE_CATALOG.all().map(definition => definition.modelId));
    assert.deepEqual(new Set(modules.keys()), modelIds);
    assert.deepEqual(root.scale.toArray(), [1, 1, 1]);
    for (const [modelId, module] of modules) {
      assert.equal(module.type, 'Group', `${modelId} is not an independent Group`);
      assert.deepEqual(module.scale.toArray(), [1, 1, 1], `${modelId} has a baked root scale`);
    }
  });

  test('ship module asset: 全 module の接続面は定義長の ±Z に一致する', () => {
    const modules = moduleRoots(parsedRoot());
    for (const definition of SHIP_MODULE_CATALOG.all()) {
      const module = modules.get(definition.modelId);
      assert.ok(module !== undefined, definition.modelId);
      const aft = semanticAnchor(module, 'connection:aft');
      const forward = semanticAnchor(module, 'connection:forward');
      assert.ok(aft !== null && forward !== null, `${definition.modelId} lacks axial anchors`);
      assert.ok(Math.abs(aft.position.z + definition.length / 2) < 1e-9, definition.modelId);
      assert.ok(Math.abs(forward.position.z - definition.length / 2) < 1e-9, definition.modelId);
      assert.equal(aft.position.x, 0);
      assert.equal(aft.position.y, 0);
      assert.equal(forward.position.x, 0);
      assert.equal(forward.position.y, 0);
    }
  });

  test('ship module asset: 能力を持つ module は対応する semantic anchor を保つ', () => {
    const modules = moduleRoots(parsedRoot());
    const expected: Readonly<Record<string, readonly string[]>> = {
      thruster: ['thrust'],
      booster: ['thrust'],
      rcs: ['rcs:1,0', 'rcs:-1,0', 'rcs:0,1', 'rcs:0,-1', 'rcs:roll:+', 'rcs:roll:-'],
      weapon: ['muzzle:left', 'muzzle:right', 'belt'],
      radiator: ['panel-hinge'],
      solar_panel: ['panel-hinge'],
      docking_port: ['docking-port'],
      dock: ['construction-dock'],
      decoupler: ['decoupler'],
    };
    for (const definition of SHIP_MODULE_CATALOG.all()) {
      const module = modules.get(definition.modelId);
      assert.ok(module !== undefined, definition.modelId);
      for (const anchor of expected[definition.kind] ?? []) {
        assert.ok(semanticAnchor(module, anchor) !== null, `${definition.modelId} lacks ${anchor}`);
      }
    }
  });

  test('ship module asset: instance は geometry を共有し material と状態だけを分離する', () => {
    const first = buildShipModuleModel('cockpit-standard');
    const second = buildShipModuleModel('cockpit-standard');
    const firstMesh = first.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const secondMesh = second.getObjectByProperty('isMesh', true) as THREE.Mesh;
    assert.ok(firstMesh !== undefined && secondMesh !== undefined);
    assert.equal(firstMesh.geometry, secondMesh.geometry);
    assert.notEqual(firstMesh.material, secondMesh.material);
    assert.equal(firstMesh.userData.ownsGeometry, false);
    assert.equal(firstMesh.userData.ownsMaterial, true);
    disposeOwnedRenderResources(first);
    disposeOwnedRenderResources(second);
  });
}
