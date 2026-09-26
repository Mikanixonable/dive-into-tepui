// 焼き込み済み ship module asset とカタログの契約。モデルの UUID や頂点列ではなく、
// module 境界、メートル単位、+Z 接続面、semantic anchor だけを固定する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import {
  buildShipModuleModel,
  getShipModuleTemplates,
  loadShipModuleModels,
} from '../../src/render/dynamic/ship/ship-module-models';
import { disposeOwnedRenderResources } from '../../src/render/dispose-owned-render-resources';
import {
  RADIATOR_FOLD_COUNT,
  RADIATOR_PANEL_WIDTH,
  RADIATOR_SEGMENT_LENGTH,
  SOLAR_PANEL_COUNT,
  SOLAR_PANEL_SPAN,
  SOLAR_PANEL_WIDTH,
} from '../../src/physics/player-shape';
import { test } from '../harness';

function parsedRoot(): THREE.Group {
  return getShipModuleTemplates();
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

function objectByName(root: THREE.Object3D, name: string): THREE.Object3D | null {
  let result: THREE.Object3D | null = null;
  root.traverse((child) => {
    if (child.name === name) result = child;
  });
  return result;
}

// object の module 局所座標での位置と向き。anchor は可動部の子として入れ子になりうる。
function transformInModule(module: THREE.Object3D, object: THREE.Object3D): { position: THREE.Vector3, quaternion: THREE.Quaternion } {
  module.updateMatrixWorld(true);
  const local = module.matrixWorld.clone().invert().multiply(object.matrixWorld);
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  local.decompose(position, quaternion, new THREE.Vector3());
  return { position, quaternion };
}

export function register(): void {
  test('ship module asset: catalog の全 modelId が独立した等倍 Group を持つ', async () => {
    await loadShipModuleModels();
    const root = parsedRoot();
    const modules = moduleRoots(root);
    const modelIds = new Set(SHIP_MODULE_CATALOG.all().map(definition => definition.modelId));
    assert.deepEqual(new Set(modules.keys()), modelIds);
    assert.deepEqual(root.scale.toArray(), [1, 1, 1]);
    for (const [modelId, module] of modules) {
      assert.ok(module.type === 'Group' || module.type === 'Object3D', `${modelId} is not an independent Group/Object3D`);
      assert.deepEqual(module.scale.toArray(), [1, 1, 1], `${modelId} has a baked root scale`);
    }
  });

  test('ship module asset: 全 module の接続面は定義長の ±Z に一致する', async () => {
    await loadShipModuleModels();
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

  test('ship module asset: interface ring は接続面と同じ +Z 法線を持つ', async () => {
    await loadShipModuleModels();
    const modules = moduleRoots(parsedRoot());
    const module = modules.get('dock-standard');
    assert.ok(module !== undefined);
    const ring = objectByName(module, 'interface-ring');
    assert.ok(ring !== null);
    const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(ring.quaternion);
    assert.ok(normal.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-9);
  });

  test('ship module asset: tank band は船体軸と同じ +Z 法線を持つ', async () => {
    await loadShipModuleModels();
    const modules = moduleRoots(parsedRoot());
    const module = modules.get('tank-6-main');
    assert.ok(module !== undefined);
    const bands: THREE.Object3D[] = [];
    module.traverse((child) => {
      if (child.name === 'tank-band') bands.push(child);
    });
    assert.ok(bands.length > 0);
    for (const band of bands) {
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(band.quaternion);
      assert.ok(normal.distanceTo(new THREE.Vector3(0, 0, 1)) < 1e-9);
    }
  });

  test('ship module asset: 能力を持つ module は対応する semantic anchor を保つ', async () => {
    await loadShipModuleModels();
    const modules = moduleRoots(parsedRoot());
    const expected: Readonly<Record<string, readonly string[]>> = {
      thruster: ['thrust'],
      booster: ['thrust'],
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

  test('ship module asset: 噴射口 anchor はノズル出口面にあり、排気は機軸の後方を向く', async () => {
    await loadShipModuleModels();
    const modules = moduleRoots(parsedRoot());
    for (const modelId of ['thruster-standard', 'booster-standard']) {
      const module = modules.get(modelId);
      assert.ok(module !== undefined);
      const thrust = semanticAnchor(module, 'thrust');
      assert.ok(thrust !== null);
      const { position, quaternion } = transformInModule(module, thrust);
      const box = new THREE.Box3().setFromObject(module);
      assert.ok(Math.abs(position.z - box.min.z) < 0.05, `${modelId} thrust z ${position.z} vs exit ${box.min.z}`);
      const exhaust = new THREE.Vector3(0, 0, 1).applyQuaternion(quaternion);
      assert.ok(exhaust.distanceTo(new THREE.Vector3(0, 0, -1)) < 1e-6);
    }
  });

  test('ship module asset: RCS の噴射口は6方向のトルクをどれも出せる', async () => {
    await loadShipModuleModels();
    const module = moduleRoots(parsedRoot()).get('rcs-standard');
    assert.ok(module !== undefined);
    const nozzles: THREE.Object3D[] = [];
    module.traverse((child) => {
      if (typeof child.userData.semanticAnchor === 'string' && child.userData.semanticAnchor.startsWith('rcs:')) nozzles.push(child);
    });
    // 軸まわり(roll)はモジュール中心、軸に直交する向き(pitch/yaw)はモジュール前方の重心を支点に測る
    for (const [axis, pivot] of [
      [new THREE.Vector3(0, 0, 1), new THREE.Vector3()], [new THREE.Vector3(0, 0, -1), new THREE.Vector3()],
      [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 5)], [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 5)],
      [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 5)], [new THREE.Vector3(0, -1, 0), new THREE.Vector3(0, 0, 5)],
    ] as const) {
      const produced = nozzles.some((nozzle) => {
        const exhaust = new THREE.Vector3(0, 0, 1).applyQuaternion(nozzle.quaternion);
        const torque = nozzle.position.clone().sub(pivot).cross(exhaust.negate());
        return torque.dot(axis) > 1e-3;
      });
      assert.ok(produced, `no nozzle produces torque about ${axis.toArray()}`);
    }
  });

  test('ship module asset: 機関砲の砲身先端は定義の砲口に一致する', async () => {
    await loadShipModuleModels();
    const definition = SHIP_MODULE_CATALOG.require('weapon-gatling');
    const module = moduleRoots(parsedRoot()).get(definition.modelId);
    assert.ok(module !== undefined);
    const box = new THREE.Box3().setFromObject(module);
    for (const muzzle of definition.muzzles) assert.ok(Math.abs(box.max.z - muzzle.z) < 1e-3, `muzzle z ${muzzle.z} vs ${box.max.z}`);
  });

  test('ship module asset: 主推進器の噴射口はジンバルの支点と一緒に振れる', async () => {
    await loadShipModuleModels();
    const module = moduleRoots(parsedRoot()).get('thruster-standard');
    assert.ok(module !== undefined);
    const gimbal = semanticAnchor(module, 'engine-gimbal');
    const thrust = semanticAnchor(module, 'thrust');
    assert.ok(gimbal !== null && thrust !== null);
    let ancestor = thrust.parent;
    while (ancestor !== null && ancestor !== gimbal) ancestor = ancestor.parent;
    assert.equal(ancestor, gimbal, 'thrust is not a descendant of engine-gimbal');
  });

  test('ship module asset: 砲身束は後座する機関部に保持され、固定砲架と独立する', async () => {
    await loadShipModuleModels();
    const module = buildShipModuleModel('weapon-gatling');
    const recoil = semanticAnchor(module, 'gun-recoil:0');
    const rotor = semanticAnchor(module, 'barrel-rotor:0');
    const feed = semanticAnchor(module, 'feed-drum');
    assert.ok(recoil !== null && rotor !== null && feed !== null);
    const travel: unknown = recoil.userData.recoilTravel;
    assert.ok(typeof travel === 'number' && travel > 0 && Number.isFinite(travel));
    assert.equal(rotor.parent, recoil);
    const rotorBefore = transformInModule(module, rotor).position;
    const feedBefore = transformInModule(module, feed).position;
    // 砲身束と機関部が同じ距離だけ後退し、固定の給弾ドラムは取付位置を保つ。
    recoil.position.z -= travel;
    const rotorAfter = transformInModule(module, rotor).position;
    assert.ok(Math.abs(rotorBefore.z - rotorAfter.z - travel) < 1e-6);
    assert.ok(transformInModule(module, feed).position.distanceTo(feedBefore) < 1e-6);
    assert.ok(Math.abs(rotorAfter.x - rotorBefore.x) < 1e-6);
    assert.ok(Math.abs(rotorAfter.y - rotorBefore.y) < 1e-6);
    disposeOwnedRenderResources(module);
  });

  test('ship module asset: 機関砲は砲口ごとに砲口の軸上で機軸まわりに回る砲身束を持つ', async () => {
    await loadShipModuleModels();
    const definition = SHIP_MODULE_CATALOG.require('weapon-gatling');
    const module = moduleRoots(parsedRoot()).get(definition.modelId);
    assert.ok(module !== undefined);
    const rotors: THREE.Object3D[] = [];
    module.traverse((child) => {
      if (child.userData.semanticAnchor?.startsWith('barrel-rotor:')) rotors.push(child);
    });
    assert.equal(rotors.length, definition.muzzles.length);
    definition.muzzles.forEach((muzzle, index) => {
      const rotor = semanticAnchor(module, `barrel-rotor:${index}`);
      assert.ok(rotor !== null, `lacks barrel-rotor:${index}`);
      const barrelCount: unknown = rotor.userData.barrelCount;
      assert.ok(typeof barrelCount === 'number' && Number.isInteger(barrelCount) && barrelCount > 0, `barrelCount ${String(barrelCount)}`);
      const { position, quaternion } = transformInModule(module, rotor);
      assert.ok(Math.abs(position.x - muzzle.x) < 1e-6 && Math.abs(position.y - muzzle.y) < 1e-6, `rotor ${index} off muzzle axis`);
      assert.ok(quaternion.angleTo(new THREE.Quaternion()) < 1e-6, `rotor ${index} spin axis is not module +Z`);
    });
  });

  test('ship module asset: 展開部品は実寸に対応する枚数と幅を持つ', async () => {
    await loadShipModuleModels();
    const modules = moduleRoots(parsedRoot());
    const expected = [
      {
        modelId: 'radiator-standard',
        count: RADIATOR_FOLD_COUNT,
        width: 0.08, // 厚み (X)
        height: RADIATOR_PANEL_WIDTH * 0.96, // 放熱幅 (Y)
        depth: RADIATOR_SEGMENT_LENGTH * 0.96, // 展開長 (Z)
      },
      {
        modelId: 'solar-panel-standard',
        count: SOLAR_PANEL_COUNT,
        width: SOLAR_PANEL_SPAN * 0.96, // 翼幅 (X)
        height: 0.06, // 厚み (Y)
        depth: SOLAR_PANEL_WIDTH * 0.96, // 展開長 (Z)
      },
    ] as const;
    for (const spec of expected) {
      const module = modules.get(spec.modelId);
      assert.ok(module !== undefined);
      const panels: THREE.Mesh[] = [];
      module.traverse((child) => {
        if (child.name === 'deployable-panel' || child.name.startsWith('deployable-panel:')) {
          assert.ok(child instanceof THREE.Mesh);
          panels.push(child as THREE.Mesh);
        }
      });
      assert.equal(panels.length, spec.count, `${spec.modelId} panel count`);
      for (const panel of panels) {
        panel.geometry.computeBoundingBox();
        const bbox = panel.geometry.boundingBox;
        assert.ok(bbox !== null);
        const size = new THREE.Vector3();
        bbox.getSize(size);
        assert.ok(Math.abs(size.x - spec.width) < 1e-3, `${spec.modelId} width: ${size.x} expected ${spec.width}`);
        assert.ok(Math.abs(size.y - spec.height) < 1e-3, `${spec.modelId} height: ${size.y} expected ${spec.height}`);
        assert.ok(Math.abs(size.z - spec.depth) < 1e-3, `${spec.modelId} depth: ${size.z} expected ${spec.depth}`);
      }
      const hinges: THREE.Object3D[] = [];
      module.traverse((child) => {
        if (child.userData.semanticAnchor?.startsWith('panel-hinge:')) hinges.push(child);
      });
      assert.equal(hinges.length, spec.count, `${spec.modelId} hinge count`);
      assert.deepEqual(
        hinges.map((hinge) => hinge.userData.panelIndex),
        [...Array(spec.count).keys()],
      );
    }
  });

  test('ship module asset: instance は geometry を共有し material と状態だけを分離する', async () => {
    await loadShipModuleModels();
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

  test('ship module asset: 各モジュールの寸法とバウンディングボックスはカタログ規格に整合する', async () => {
    await loadShipModuleModels();
    const modules = moduleRoots(parsedRoot());

    // 1. Cockpit: 全長 3.0m (z in [-1.5, +1.5])
    const cockpit = modules.get('cockpit-standard');
    assert.ok(cockpit !== undefined);
    const boxCockpit = new THREE.Box3().setFromObject(cockpit);
    assert.ok(boxCockpit.max.z <= 1.55, `cockpit max.z (${boxCockpit.max.z}) exceeds +1.5m`);
    assert.ok(boxCockpit.min.z >= -1.55, `cockpit min.z (${boxCockpit.min.z}) extends below -1.5m`);

    // 2. Thruster: 前面接続面 z = +0.50m を超えて前方に突き出ないこと (z <= 0.55m)
    const thruster = modules.get('thruster-standard');
    assert.ok(thruster !== undefined);
    const boxThruster = new THREE.Box3().setFromObject(thruster);
    assert.ok(boxThruster.max.z <= 0.55, `thruster max.z (${boxThruster.max.z}) protrudes forward of connection plane +0.5m`);

    // 3. Booster: 全長 6.0m (z in [-3.0, +3.0])
    const booster = modules.get('booster-standard');
    assert.ok(booster !== undefined);
    const boxBooster = new THREE.Box3().setFromObject(booster);
    assert.ok(boxBooster.max.z <= 3.05, `booster max.z (${boxBooster.max.z}) exceeds +3.0m`);
    assert.ok(boxBooster.min.z >= -3.05, `booster min.z (${boxBooster.min.z}) extends below -3.0m`);

    // 4. RCS module: 全長 1.0m (z in [-0.5, +0.5])
    const rcs = modules.get('rcs-standard');
    assert.ok(rcs !== undefined);
    const boxRcs = new THREE.Box3().setFromObject(rcs);
    assert.ok(boxRcs.max.z <= 0.55, `rcs max.z (${boxRcs.max.z}) exceeds +0.5m`);
    assert.ok(boxRcs.min.z >= -0.55, `rcs min.z (${boxRcs.min.z}) extends below -0.5m`);

    // 5. Decoupler: 全長 1.0m (平坦な切断面, z in [-0.5, +0.5])
    const decoupler = modules.get('decoupler-standard');
    assert.ok(decoupler !== undefined);
    const boxDecoupler = new THREE.Box3().setFromObject(decoupler);
    assert.ok(boxDecoupler.max.z <= 0.55, `decoupler max.z (${boxDecoupler.max.z}) exceeds +0.5m`);
    assert.ok(boxDecoupler.min.z >= -0.55, `decoupler min.z (${boxDecoupler.min.z}) extends below -0.5m`);

    // 6. Docking port / Dock: 後端接続面 z=-0.5m (min.z >= -0.55m)、前端は嵌合ガイド爪が相手側へ突出 (max.z <= 0.75m)
    for (const modelId of ['dock-standard', 'docking-port-standard']) {
      const mod = modules.get(modelId);
      assert.ok(mod !== undefined, modelId);
      const box = new THREE.Box3().setFromObject(mod);
      assert.ok(box.min.z >= -0.55, `${modelId} min.z (${box.min.z}) extends below -0.5m`);
      assert.ok(box.max.z <= 0.75, `${modelId} guide petals max.z (${box.max.z}) exceed +0.75m`);
    }
  });
}
