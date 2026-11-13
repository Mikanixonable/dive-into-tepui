import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Q_IDENTITY, qFromAxisAngle } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { RADIATOR_FOLD_COUNT } from '../../src/physics/player-shape';
import { deployablePanelPoses } from '../../src/physics/ship-panel-layout';
import { ModularShipView } from '../../src/render/dynamic/ship/modular-ship-view';
import { ShipModuleView } from '../../src/render/dynamic/ship/ship-module-view';
import type { ShipModuleRenderInput, ShipModuleRenderKind } from '../../src/render/dynamic/ship/ship-render-contract';
import { test } from '../harness';

function modelFactory(modelId: string): THREE.Group {
  const root = new THREE.Group();
  root.name = `module:${modelId}`;
  const anchor = new THREE.Object3D();
  anchor.name = modelId === 'tank-3-main' ? 'anchor:tank-only' : 'anchor:connection:forward';
  anchor.userData.semanticAnchor = modelId === 'tank-3-main' ? 'tank-only' : 'connection:forward';
  anchor.position.set(0, 0, 1);
  root.add(anchor);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(2, 1, 4), new THREE.MeshBasicMaterial());
  mesh.geometry.translate(0.5, 0, 0);
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  root.add(mesh);
  return root;
}

function moduleInput(
  modelId: string, id: string, kind: ShipModuleRenderKind, hp = 100, maxHp = 100,
  deployed: number | null = null,
): ShipModuleRenderInput {
  return {
    id, modelId, kind, hp, maxHp, deployed, burning: null,
    transform: { position: v3(), rotation: Q_IDENTITY },
  };
}

function at(input: ShipModuleRenderInput, position: ReturnType<typeof v3>): ShipModuleRenderInput {
  return { ...input, transform: { position, rotation: input.transform.rotation } };
}

export function register(): void {
  test('ship module view: transform, semantic anchor, and state are synchronized', () => {
    const module = at(moduleInput('cockpit-standard', 'cockpit-1', 'cockpit', 40), v3(2, 3, 4));
    const view = new ShipModuleView(module, modelFactory);
    view.sync({
      ...module,
      transform: { position: v3(2, 3, 4), rotation: qFromAxisAngle(v3(0, 1, 0), Math.PI / 2) },
    });

    assert.deepEqual(view.object.position.toArray(), [2, 3, 4]);
    assert.ok(view.semanticAnchor('connection:forward') !== null);
    assert.equal(view.visualState.damage, 0.6);
    assert.equal(view.object.userData.shipModuleId, 'cockpit-1');
    view.dispose();
  });

  test('ship module view: COM offset keeps model and transform in the same meter frame', () => {
    const module = moduleInput('cockpit-standard', 'cockpit-1', 'cockpit');
    const view = new ShipModuleView(module, modelFactory);
    view.sync(at(module, v3(10, 20, 30)), v3(1, 2, 3));
    assert.deepEqual(view.object.position.toArray(), [9, 18, 27]);
    view.dispose();
  });

  test('modular ship view: append/remove rebuilds only the changed module views', () => {
    const cockpit = moduleInput('cockpit-standard', 'cockpit', 'cockpit');
    const tank = at(moduleInput('tank-3-main', 'tank', 'tank'), v3(0, 0, 3));
    const view = new ModularShipView(modelFactory);
    view.sync([cockpit, tank]);
    const tankView = view.module('tank');
    const cockpitView = view.module('cockpit');
    assert.equal(view.moduleCount, 2);
    assert.equal(view.object.children.length, 2);
    view.sync([cockpit]);
    assert.equal(view.moduleCount, 1);
    assert.equal(view.module('tank'), null);
    assert.equal(view.module('cockpit'), cockpitView);
    assert.equal(view.object.children.length, 1);
    assert.ok(tankView !== null);
    view.dispose();
    assert.equal(view.object.children.length, 0);
    view.dispose();
  });

  test('ship module view: definition replacement rebuilds the model and anchor index', () => {
    const first = moduleInput('cockpit-standard', 'module-1', 'cockpit');
    const second = moduleInput('tank-3-main', 'module-1', 'tank');
    const view = new ShipModuleView(first, modelFactory);
    assert.ok(view.semanticAnchor('connection:forward') !== null);
    view.replaceModule(at(second, v3(1, 2, 3)));
    assert.equal(view.semanticAnchor('connection:forward'), null);
    assert.ok(view.semanticAnchor('tank-only') !== null);
    assert.equal(view.object.userData.shipModuleModelId, 'tank-3-main');
    view.dispose();
  });

  test('modular ship view: deployment is exposed without mutating shared materials', () => {
    const radiator = moduleInput('radiator-standard', 'radiator', 'radiator', 50, 50, 1);
    const view = new ModularShipView(modelFactory);
    view.sync([radiator]);
    assert.equal(view.module('radiator')?.visualState.deployed, 1);
    view.dispose();
  });

  test('ship module view: panel-hinge は module state の展開度と全損状態へ同期する', () => {
    const panelFactory = () => {
      const root = new THREE.Group();
      const hinge = new THREE.Object3D();
      hinge.userData.semanticAnchor = 'panel-hinge';
      root.add(hinge);
      for (let index = 0; index < RADIATOR_FOLD_COUNT; index++) {
        const panel = new THREE.Object3D();
        panel.userData = { semanticAnchor: `panel-hinge:${index}`, panelKind: 'radiator', panelIndex: index };
        hinge.add(panel);
      }
      return root;
    };
    const view = new ShipModuleView(moduleInput('radiator-standard', 'radiator', 'radiator', 50, 50, 0), panelFactory);
    const assertPoses = (deployed: number): void => {
      const expected = deployablePanelPoses('radiator', 0, deployed);
      for (const panel of view.semanticAnchors('panel-hinge:')) {
        const pose = expected[panel.userData.panelIndex as number]!;
        assert.ok(panel.position.distanceTo(new THREE.Vector3(pose.origin.x, pose.origin.y, pose.origin.z)) < 1e-12);
        const rotation = new THREE.Quaternion(pose.rotation.x, pose.rotation.y, pose.rotation.z, pose.rotation.w);
        assert.ok(panel.quaternion.angleTo(rotation) < 1e-9);
      }
    };
    assertPoses(0);
    view.sync(moduleInput('radiator-standard', 'radiator', 'radiator', 50, 50, 1));
    assertPoses(1);
    view.sync(moduleInput('radiator-standard', 'radiator', 'radiator', 0, 50, 1));
    assert.equal(view.semanticAnchor('panel-hinge')?.visible, false);
    view.dispose();
  });

  test('ship module view: 選択の宣言で白い輪郭の殻が現れ、ずらしが位置へ乗り、消すと元へ戻る', () => {
    const module = at(moduleInput('cockpit-standard', 'cockpit-1', 'cockpit'), v3(2, 3, 4));
    const view = new ShipModuleView(module, modelFactory);
    assert.deepEqual(view.object.position.toArray(), [2, 3, 4]);
    assert.equal(view.object.getObjectByName('ship-module-emphasis:cockpit-1'), undefined);

    view.sync(module, v3(), { tone: 'selected', intensity: 1, offset: v3(0, 0, 0.5) });
    const shell = view.object.getObjectByName('ship-module-emphasis:cockpit-1') as THREE.Object3D;
    assert.ok(shell !== undefined && shell.visible);
    assert.deepEqual(view.object.position.toArray(), [2, 3, 4.5]);
    const shellMesh = shell.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const outlineMaterial = shellMesh.material as THREE.MeshBasicMaterial;
    assert.equal(outlineMaterial.transparent, true);
    assert.equal(outlineMaterial.side, THREE.BackSide);
    assert.equal(outlineMaterial.depthTest, true);
    assert.equal(outlineMaterial.depthWrite, false);
    assert.equal(outlineMaterial.toneMapped, false);
    assert.equal(outlineMaterial.color.getHex(), 0xffffff);
    assert.equal(outlineMaterial.opacity, 0.9);
    assert.equal(shellMesh.layers.isEnabled(3), true, '殻が overlay チャンネルに無い');
    // 殻は本体と同じ形状を共有し、bounding box の中心を基点に両側へ 0.12m ずつ膨らませる。
    const bodyMesh = view.object.children[0]!.getObjectByProperty('isMesh', true) as THREE.Mesh;
    assert.equal(shellMesh.geometry, bodyMesh.geometry);
    // 中心が x へ 0.5 ずれた 2×1×4 の box: x は 1+0.24/2、y は 1+0.24/1、z は 1+0.24/4。
    assert.ok(Math.abs(shell.scale.x - 1.12) < 1e-9);
    assert.ok(Math.abs(shell.scale.y - 1.24) < 1e-9);
    assert.ok(Math.abs(shell.scale.z - 1.06) < 1e-9);
    assert.ok(Math.abs(shell.position.x - -0.06) < 1e-9);

    // tone が変わると加算の殻へ切り替わり、色と不透明度と拡大を戻す。
    view.sync(module, v3(), { tone: 'conflict', intensity: 0.5, offset: v3(0, 0, 0.5) });
    const washMaterial = shellMesh.material as THREE.MeshBasicMaterial;
    assert.notEqual(washMaterial, outlineMaterial);
    assert.equal(washMaterial.blending, THREE.AdditiveBlending);
    assert.equal(washMaterial.color.getHex(), 0xff5b63);
    assert.equal(washMaterial.opacity, 0.225);
    assert.deepEqual(shell.scale.toArray(), [1, 1, 1]);
    assert.deepEqual(shell.position.toArray(), [0, 0, 0]);

    // 宣言が消えれば殻は伏せられ、位置も元へ戻る。
    view.sync(module);
    assert.equal(shell.visible, false);
    assert.deepEqual(view.object.position.toArray(), [2, 3, 4]);
    view.dispose();
    view.dispose();
  });

  test('modular ship view: 宣言はモジュール id ごとに届き、宣言の無いモジュールは変わらない', () => {
    const cockpit = at(moduleInput('cockpit-standard', 'cockpit', 'cockpit'), v3(0, 0, 0));
    const tank = at(moduleInput('tank-3-main', 'tank', 'tank'), v3(0, 0, 3));
    const view = new ModularShipView(modelFactory);
    view.sync([cockpit, tank]);
    const emphasis = new Map([
      ['tank', { tone: 'piece' as const, intensity: 1, offset: v3(1, 0, 0) }],
    ]);
    view.sync([cockpit, tank], v3(), emphasis);
    assert.deepEqual(view.module('tank')?.object.position.toArray(), [1, 0, 3]);
    assert.deepEqual(view.module('cockpit')?.object.position.toArray(), [0, 0, 0]);
    assert.equal(
      view.module('cockpit')?.object.getObjectByName('ship-module-emphasis:cockpit'), undefined,
      '宣言の無いモジュールに殻が付いている',
    );
    const tankShell = view.module('tank')?.object.getObjectByName('ship-module-emphasis:tank');
    assert.ok(tankShell !== undefined && tankShell.visible);
    const tankShellMesh = tankShell.getObjectByProperty('isMesh', true) as THREE.Mesh;
    assert.equal((tankShellMesh.material as THREE.MeshBasicMaterial).color.getHex(), 0x53c8f0);

    // 宣言が外れれば殻は伏せられ、ずらしも 0 に戻る。
    view.sync([cockpit, tank]);
    assert.equal(tankShell.visible, false);
    assert.deepEqual(view.module('tank')?.object.position.toArray(), [0, 0, 3]);
    view.dispose();
  });

  test('ship module view: モデル差し替えで殻も新しい形状へ組み直される', () => {
    const first = moduleInput('cockpit-standard', 'module-1', 'cockpit');
    const second = at(moduleInput('tank-3-main', 'module-1', 'tank'), v3(1, 2, 3));
    const emphasis = { tone: 'selected' as const, intensity: 1, offset: v3() };
    const view = new ShipModuleView(first, modelFactory);
    view.sync(first, v3(), emphasis);
    const oldShell = view.object.getObjectByName('ship-module-emphasis:module-1');
    const oldMesh = oldShell!.getObjectByProperty('isMesh', true) as THREE.Mesh;
    const oldGeometry = oldMesh.geometry;
    view.replaceModule(second, v3(), emphasis);
    const shell = view.object.getObjectByName('ship-module-emphasis:module-1') as THREE.Object3D;
    assert.ok(shell !== undefined && shell.visible);
    assert.notEqual(shell, oldShell, 'モデル差し替え後も古い殻が残っている');
    const mesh = shell.getObjectByProperty('isMesh', true) as THREE.Mesh;
    assert.notEqual(mesh.geometry, oldGeometry);
    const bodyMesh = view.object.children[0]!.getObjectByProperty('isMesh', true) as THREE.Mesh;
    assert.equal(mesh.geometry, bodyMesh.geometry, '殻が新しいモデルの形状を共有していない');
    view.dispose();
  });

  test('modular ship view: dispose は保持した scene から root を外し二重呼び出しできる', () => {
    const scene = new THREE.Scene();
    const cockpit = moduleInput('cockpit-standard', 'cockpit', 'cockpit');
    const view = new ModularShipView(modelFactory, scene);
    view.sync([cockpit]);
    assert.equal(scene.children.includes(view.object), true);
    view.dispose();
    view.dispose();
    assert.equal(scene.children.includes(view.object), false);
  });
}
