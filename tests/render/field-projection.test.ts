// 方位等距離図法の往復を固定する。uv から戻した単位方向が同じ uv へ写らないと、焼いた texel と
// 読み出しの texel がずれる。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { vec2, vec3 } from 'three/tsl';
import { EquidistantCap } from '../../src/render/field-projection';
import { evaluateShaderNode } from './tsl-node-evaluator';
import { test } from '../harness';

// 円板の内側の uv。中心・中間・縁の近くを取る(四隅は円板の外なので図法の定義域にない)。
const INSIDE_UVS: readonly (readonly [number, number])[] = [
  [0.5, 0.5], [0.65, 0.5], [0.5, 0.8], [0.3, 0.35], [0.5, 0.02], [0.98, 0.5],
];

export function register(): void {
  test('equidistant cap: uv と単位方向は互いの逆写像', () => {
    const cap = new EquidistantCap(256, 0.3);
    cap.aimAt(new THREE.Vector3(0.3, 0.5, -0.8).normalize(), 0.7);
    for (const [u, v] of INSIDE_UVS) {
      const direction = evaluateShaderNode(cap.directionAt(vec2(u, v))) as number[];
      assert.ok(Math.abs(Math.hypot(...direction) - 1) < 1e-12, `|direction| ${Math.hypot(...direction)}`);
      const uv = evaluateShaderNode(
        cap.uvAt(vec3(direction[0]!, direction[1]!, direction[2]!)),
      ) as number[];
      assert.ok(Math.abs(uv[0]! - u) < 1e-9, `u ${uv[0]} != ${u}`);
      assert.ok(Math.abs(uv[1]! - v) < 1e-9, `v ${uv[1]} != ${v}`);
    }
  });
}
