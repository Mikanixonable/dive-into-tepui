import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { ENEMY_MODEL_SCALE } from '../../src/game/dynamic/dynamic-entity/enemy';
import { metalEnemyCollisionRadius } from '../../src/game/dynamic/dynamic-entity/metal-enemy';
import { buildEnemyShip, buildStage0EnemyShip } from '../../src/render/dynamic/ships';

// 組み立てが View へ渡すのと同じ倍率でモデルを作り、その外接球半径を測る。
function renderedRadius(typeIndex: number | null): number {
  const model = typeIndex === null ? buildEnemyShip() : buildStage0EnemyShip(0xffffff, typeIndex);
  model.scale.setScalar(ENEMY_MODEL_SCALE);
  return new THREE.Box3().setFromObject(model).getBoundingSphere(new THREE.Sphere()).radius;
}

export function register(): void {
  test('enemy model bounds: 金属敵機の物理半径は組み立てが渡す倍率の描画アセットと一致する', () => {
    for (const typeIndex of [null, 0, 1, 2] as const) {
      assert.ok(Math.abs(renderedRadius(typeIndex) - metalEnemyCollisionRadius(typeIndex)) < 1e-9);
    }
  });
}
