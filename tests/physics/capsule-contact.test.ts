import * as assert from 'node:assert/strict';
import {
  capsuleCapsuleContact, capsuleSphereContact, sweptCapsuleCapsuleContact,
  sweptSphereCapsuleContact, type Capsule,
} from '../../src/physics/capsule-contact';
import { len, v3 } from '../../src/math/vec3';
import { test } from '../harness';

const CAPSULE: Capsule = {
  center: v3(), axis: v3(0, 1, 0), halfLength: 0.7, radius: 0.23,
};

export function register(): void {
  test('capsule-contact: 側面の球接触は半径方向の法線を返す', () => {
    const hit = capsuleSphereContact(CAPSULE, v3(0.4, 0, 0), 0.2);
    assert.ok(hit);
    assert.ok(Math.abs(hit.depth - 0.03) < 1e-12);
    assert.ok(Math.abs(hit.normal.x - 1) < 1e-12);
    assert.ok(Math.abs(hit.normal.y) < 1e-12);
  });

  test('capsule-contact: 軸端（半球部）の球接触は丸まった法線を返す', () => {
    const hit = capsuleSphereContact(CAPSULE, v3(0, 0.85, 0), 0.2);
    assert.ok(hit);
    // 線分端 (0, 0.7, 0) からの距離は 0.15。半径和 0.43 より depth = 0.43 - 0.15 = 0.28
    assert.ok(Math.abs(hit.depth - 0.28) < 1e-12);
    assert.ok(Math.abs(hit.normal.y - 1) < 1e-12);
  });

  test('capsule-contact: 軸線分どうしの接触を検出する', () => {
    const other: Capsule = { ...CAPSULE, center: v3(0.4, 0, 0) };
    const hit = capsuleCapsuleContact(CAPSULE, other);
    assert.ok(hit);
    assert.ok(Math.abs(hit.depth - 0.06) < 1e-12);
    assert.ok(Math.abs(hit.normal.x - 1) < 1e-12);
  });

  test('capsule-contact: 離れたカプセルは接触しない', () => {
    const other: Capsule = { ...CAPSULE, center: v3(0, 2, 0) };
    assert.equal(capsuleCapsuleContact(CAPSULE, other), null);
  });

  test('capsule-contact: 移動するカプセルどうしの最初の接触を返す', () => {
    const other: Capsule = { ...CAPSULE, center: v3(0.4, 0, 0) };
    const swept = sweptCapsuleCapsuleContact(
      CAPSULE, other, v3(-1, 0, 0), v3(1.4, 0, 0),
    );
    assert.ok(swept);
    assert.ok(Math.abs(swept.toi - 0.97) < 1e-2);
  });

  test('capsule-contact: 移動する球がカプセルを通過するときの最初の接触を返す', () => {
    const swept = sweptSphereCapsuleContact(CAPSULE, v3(-1, 0, 0), v3(1, 0, 0), 0.1);
    assert.ok(swept);
    assert.ok(Math.abs(swept.toi - 0.335) < 1e-12);
    assert.ok(Math.abs(len(swept.hit.normal) - 1) < 1e-12);
  });
}
