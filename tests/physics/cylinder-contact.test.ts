import * as assert from 'node:assert/strict';
import {
  cylinderCylinderContact, cylinderSphereContact, sweptCylinderCylinderContact,
  sweptSphereCylinderContact, type Cylinder,
} from '../../src/physics/cylinder-contact';
import { len, v3 } from '../../src/math/vec3';
import { test } from '../harness';

const CYLINDER: Cylinder = {
  center: v3(), axis: v3(0, 1, 0), halfLength: 0.7, radius: 0.23,
};

export function register(): void {
  test('cylinder-contact: 側面の球接触は半径方向の法線を返す', () => {
    const hit = cylinderSphereContact(CYLINDER, v3(0.4, 0, 0), 0.2);
    assert.ok(hit);
    assert.ok(Math.abs(hit.depth - 0.03) < 1e-12);
    assert.ok(Math.abs(hit.normal.x - 1) < 1e-12);
    assert.ok(Math.abs(hit.normal.y) < 1e-12);
  });

  test('cylinder-contact: 軸端の球接触は軸方向の法線を返す', () => {
    const hit = cylinderSphereContact(CYLINDER, v3(0, 0.85, 0), 0.2);
    assert.ok(hit);
    assert.ok(Math.abs(hit.depth - 0.05) < 1e-12);
    assert.ok(Math.abs(hit.normal.y - 1) < 1e-12);
  });

  test('cylinder-contact: 軸線分どうしの接触を検出する', () => {
    const other: Cylinder = { ...CYLINDER, center: v3(0.4, 0, 0) };
    const hit = cylinderCylinderContact(CYLINDER, other);
    assert.ok(hit);
    assert.ok(Math.abs(hit.depth - 0.06) < 1e-12);
    assert.ok(Math.abs(hit.normal.x - 1) < 1e-12);
  });

  test('cylinder-contact: 離れた円柱は接触しない', () => {
    const other: Cylinder = { ...CYLINDER, center: v3(0, 2, 0) };
    assert.equal(cylinderCylinderContact(CYLINDER, other), null);
  });

  test('cylinder-contact: 移動する円柱どうしの最初の接触を返す', () => {
    const other: Cylinder = { ...CYLINDER, center: v3(0.4, 0, 0) };
    const swept = sweptCylinderCylinderContact(
      CYLINDER, other, v3(-1, 0, 0), v3(1.4, 0, 0),
    );
    assert.ok(swept);
    assert.ok(Math.abs(swept.toi - 0.97) < 1e-3);
  });

  test('cylinder-contact: 移動する球が円柱を通過するときの最初の接触を返す', () => {
    const swept = sweptSphereCylinderContact(CYLINDER, v3(-1, 0, 0), v3(1, 0, 0), 0.1);
    assert.ok(swept);
    assert.ok(Math.abs(swept.toi - 0.335) < 1e-12);
    assert.ok(Math.abs(len(swept.hit.normal) - 1) < 1e-12);
  });
}
