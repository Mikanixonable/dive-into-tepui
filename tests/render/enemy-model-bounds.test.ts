import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { ENEMY_MODEL_SCALE } from '../../src/game/dynamic/dynamic-entity/enemy';
import { metalEnemyCollisionRadius } from '../../src/game/dynamic/dynamic-entity/metal-enemy';
import { MetalEnemyView, Stage0MetalEnemyView } from '../../src/render/dynamic/dynamic-entity/metal-enemy-view';

// 組み立てが渡すのと同じ倍率で View を作り、そのモデルの外接球半径を測る。
function renderedRadius(typeIndex: number | null): number {
  const view = typeIndex === null
    ? new MetalEnemyView(0xffffff, ENEMY_MODEL_SCALE)
    : new Stage0MetalEnemyView(0xffffff, typeIndex, ENEMY_MODEL_SCALE);
  return new THREE.Box3().setFromObject(view.object).getBoundingSphere(new THREE.Sphere()).radius;
}

export function register(): void {
  test('enemy model bounds: 金属敵機の物理半径は組み立てが渡す倍率の描画アセットと一致する', () => {
    for (const typeIndex of [null, 0, 1, 2] as const) {
      assert.ok(Math.abs(renderedRadius(typeIndex) - metalEnemyCollisionRadius(typeIndex)) < 1e-9);
    }
  });
}
