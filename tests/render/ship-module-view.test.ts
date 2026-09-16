import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Q_IDENTITY, qFromAxisAngle } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { ModularShipView } from '../../src/render/dynamic/ship/modular-ship-view';
import { ShipModuleView } from '../../src/render/dynamic/ship/ship-module-view';
import { test } from '../harness';

function modelFactory(modelId: string): THREE.Group {
  const root = new THREE.Group();
  root.name = `module:${modelId}`;
  const anchor = new THREE.Object3D();
  anchor.name = modelId === 'tank-3-main' ? 'anchor:tank-only' : 'anchor:connection:forward';
  anchor.userData.semanticAnchor = modelId === 'tank-3-main' ? 'tank-only' : 'connection:forward';
  anchor.position.set(0, 0, 1);
  root.add(anchor);
  const mesh = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial());
  mesh.userData.ownsGeometry = true;
  mesh.userData.ownsMaterial = true;
  root.add(mesh);
  return root;
}

function instance(definitionId: string, id: string, hp?: number) {
  const definition = SHIP_MODULE_CATALOG.require(definitionId);
  return createShipModuleInstance(definition, id, hp === undefined ? {} : { hp });
}

export function register(): void {
  test('ship module view: transform, semantic anchor, and state are synchronized', () => {
    const definition = SHIP_MODULE_CATALOG.require('cockpit-standard');
    const module = instance(definition.id, 'cockpit-1', 40);
    const view = new ShipModuleView(module, definition, {
      position: v3(2, 3, 4), rotation: qFromAxisAngle(v3(0, 1, 0), Math.PI / 2),
    }, modelFactory);

    assert.deepEqual(view.object.position.toArray(), [2, 3, 4]);
    assert.ok(view.semanticAnchor('connection:forward') !== null);
    assert.equal(view.visualState.damage, 0.6);
    assert.equal(view.object.userData.shipModuleId, 'cockpit-1');
    view.dispose();
  });

  test('ship module view: COM offset keeps model and transform in the same meter frame', () => {
    const definition = SHIP_MODULE_CATALOG.require('cockpit-standard');
    const module = instance(definition.id, 'cockpit-1');
    const view = new ShipModuleView(module, definition, { position: v3(), rotation: Q_IDENTITY }, modelFactory);
    view.sync(module, { position: v3(10, 20, 30), rotation: Q_IDENTITY }, v3(1, 2, 3));
    assert.deepEqual(view.object.position.toArray(), [9, 18, 27]);
    view.dispose();
  });

  test('modular ship view: append/remove rebuilds only the changed module views', () => {
    const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    assembly.addRoot(instance('cockpit-standard', 'cockpit'));
    assembly.append(instance('tank-3-main', 'tank'));
    const view = new ModularShipView(modelFactory);
    view.sync(assembly);
    const tankView = view.module('tank');
    const cockpitView = view.module('cockpit');
    assert.equal(view.moduleCount, 2);
    assert.equal(view.object.children.length, 2);
    assembly.removeTail();
    view.sync(assembly);
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
    const cockpit = SHIP_MODULE_CATALOG.require('cockpit-standard');
    const tank = SHIP_MODULE_CATALOG.require('tank-3-main');
    const first = instance(cockpit.id, 'module-1');
    const second = instance(tank.id, 'module-1');
    const view = new ShipModuleView(first, cockpit, { position: v3(), rotation: Q_IDENTITY }, modelFactory);
    assert.ok(view.semanticAnchor('connection:forward') !== null);
    view.replaceDefinition(second, tank, { position: v3(1, 2, 3), rotation: Q_IDENTITY });
    assert.equal(view.semanticAnchor('connection:forward'), null);
    assert.ok(view.semanticAnchor('tank-only') !== null);
    assert.equal(view.object.userData.shipModuleModelId, tank.modelId);
    view.dispose();
  });

  test('modular ship view: deployment is exposed without mutating shared materials', () => {
    const assembly = new ShipAssembly(SHIP_MODULE_CATALOG);
    const radiator = createShipModuleInstance(
      SHIP_MODULE_CATALOG.require('radiator-standard'), 'radiator', { deployed: 1 },
    );
    assembly.addRoot(radiator);
    const view = new ModularShipView(modelFactory);
    view.sync(assembly);
    assert.equal(view.module('radiator')?.visualState.deployed, 1);
    view.dispose();
  });

  test('ship module view: panel-hinge は module state の展開度と全損状態へ同期する', () => {
    const definition = SHIP_MODULE_CATALOG.require('radiator-standard');
    const radiator = createShipModuleInstance(definition, 'radiator', { deployed: 0 });
    const panelFactory = () => {
      const root = new THREE.Group();
      const hinge = new THREE.Object3D();
      hinge.name = 'anchor:panel-hinge';
      hinge.userData.semanticAnchor = 'panel-hinge';
      root.add(hinge);
      return root;
    };
    const view = new ShipModuleView(
      radiator, definition, { position: v3(), rotation: Q_IDENTITY }, panelFactory,
    );
    const hinge = view.semanticAnchor('panel-hinge')!;
    assert.ok(Math.abs(hinge.rotation.y - Math.PI / 2) < 1e-12);
    const deployed = createShipModuleInstance(definition, 'radiator', { deployed: 1 });
    view.sync(deployed, { position: v3(), rotation: Q_IDENTITY });
    assert.ok(Math.abs(hinge.rotation.y) < 1e-12);
    const destroyed = createShipModuleInstance(definition, 'radiator', { hp: 0, deployed: 1 });
    view.sync(destroyed, { position: v3(), rotation: Q_IDENTITY });
    assert.equal(hinge.visible, false);
    view.dispose();
  });

  test('modular ship view: dispose は保持した scene から root を外し二重呼び出しできる', () => {
    const scene = new THREE.Scene();
    const assembly = new ShipAssembly(SHIP_MODULE_CATALOG);
    assembly.addRoot(instance('cockpit-standard', 'cockpit'));
    const view = new ModularShipView(modelFactory, scene);
    view.sync(assembly);
    assert.equal(scene.children.includes(view.object), true);
    view.dispose();
    view.dispose();
    assert.equal(scene.children.includes(view.object), false);
  });
}
