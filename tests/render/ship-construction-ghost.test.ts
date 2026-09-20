import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { Q_IDENTITY, qFromAxisAngle } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { DockSnapGuideView } from '../../src/render/dynamic/ship/dock-snap-guide-view';
import { ShipGhostView } from '../../src/render/dynamic/ship/ship-ghost-view';
import { test } from '../harness';

function modelFactory(modelId: string): THREE.Group {
  const model = new THREE.Group();
  model.name = modelId;
  const mesh = new THREE.Mesh(
    new THREE.BufferGeometry(),
    new THREE.MeshBasicMaterial({ color: 0x456789 }),
  );
  mesh.userData.ownsGeometry = true;
  model.add(mesh);
  return model;
}

function materialOf(root: THREE.Object3D): THREE.Material & { color?: THREE.Color } {
  const mesh = root.getObjectByProperty('isMesh', true) as THREE.Mesh;
  if (!mesh?.isMesh || Array.isArray(mesh.material)) throw new Error('ghost mesh is missing');
  return mesh.material as THREE.Material & { color?: THREE.Color };
}

export function register(): void {
  test('ship construction ghost: hidden, valid, invalid, and module switch keep private translucent materials', () => {
    const scene = new THREE.Scene();
    const shared = new THREE.MeshBasicMaterial({ color: 0x456789 });
    const factory = (modelId: string) => {
      const model = modelFactory(modelId);
      const mesh = model.getObjectByProperty('isMesh', true) as THREE.Mesh;
      mesh.material = shared;
      return model;
    };
    const ghost = new ShipGhostView(scene, factory);
    assert.equal(ghost.object.visible, false);
    ghost.sync({ modelId: 'tank-3-main', position: v3(1, 2, 3), rotation: Q_IDENTITY, valid: true });
    const validMaterial = materialOf(ghost.object);
    assert.notEqual(validMaterial, shared);
    assert.equal(validMaterial.transparent, true);
    assert.equal(validMaterial.opacity, 0.35);
    assert.equal(validMaterial.depthTest, true);
    assert.equal(validMaterial.depthWrite, false);
    assert.equal((validMaterial as THREE.MeshBasicMaterial).isMeshBasicMaterial, true);
    assert.equal(validMaterial.toneMapped, false);
    assert.equal(validMaterial.color?.getHex(), 0x53f089);
    assert.equal(shared.color.getHex(), 0x456789);
    const ghostMesh = ghost.object.getObjectByProperty('isMesh', true) as THREE.Mesh;
    assert.equal(ghost.object.layers.isEnabled(3), true);
    assert.equal(ghostMesh.layers.isEnabled(3), true);

    ghost.sync({ modelId: 'tank-3-main', position: v3(1, 2, 3), rotation: Q_IDENTITY, valid: false });
    assert.equal(materialOf(ghost.object), validMaterial);
    assert.equal(validMaterial.color?.getHex(), 0xff5b63);

    ghost.sync({ modelId: 'tank-6-main', position: v3(), rotation: Q_IDENTITY, valid: true });
    assert.notEqual(materialOf(ghost.object), validMaterial);
    ghost.sync(null);
    assert.equal(ghost.object.visible, false);
    ghost.dispose();
    ghost.dispose();
    assert.equal(scene.children.includes(ghost.object), false);
  });

  test('ship construction ghost: snap transform and world-space guide share the candidate connection plane', () => {
    const ghost = new ShipGhostView(undefined, modelFactory, false);
    const guide = new DockSnapGuideView(undefined, false);
    const position = v3(10, 20, 30);
    const rotation = qFromAxisAngle(v3(0, 1, 0), Math.PI / 2);
    ghost.sync({ modelId: 'dock-standard', position, rotation, valid: true });
    guide.sync({ position, rotation, radius: 3, valid: false });
    assert.deepEqual(ghost.object.position.toArray(), [10, 20, 30]);
    assert.deepEqual(guide.object.position.toArray(), [10, 20, 30]);
    assert.ok(ghost.object.quaternion.angleTo(guide.object.quaternion) < 1e-12);
    assert.deepEqual(guide.object.scale.toArray(), [3, 3, 3]);
    const guideLine = guide.object.children[0] as THREE.Line;
    assert.equal((guideLine.material as THREE.LineBasicMaterial).color.getHex(), 0xff5b63);
    assert.equal(guide.object.layers.isEnabled(3), true);
    assert.equal(guideLine.layers.isEnabled(3), true);
    guide.dispose();
    guide.dispose();
    ghost.dispose();
  });

  test('ship construction ghost: multiple guides keep independent transforms and validity', () => {
    const guide = new DockSnapGuideView(undefined, false);
    guide.syncAll([
      { id: 'cockpit:side+x', position: v3(1, 0, 0), rotation: Q_IDENTITY, radius: 2, valid: true },
      { id: 'tank:side-y', position: v3(0, 2, 0), rotation: Q_IDENTITY, radius: 3, valid: false },
    ]);
    assert.equal(guide.object.visible, true);
    assert.equal(guide.object.parent?.children.length, 2);
    const second = guide.object.parent?.children[1];
    assert.ok(second);
    assert.equal(second.userData.dockSnapGuideValid, false);
    assert.deepEqual(second.scale.toArray(), [3, 3, 3]);
    guide.syncAll([{ id: 'cockpit:side+x', position: v3(), rotation: Q_IDENTITY, radius: 2, valid: true }]);
    assert.equal(guide.object.parent?.children.length, 1);
    guide.dispose();
  });
}
