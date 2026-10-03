import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { bool, vec2, vec3 } from 'three/tsl';
import { DiffuseCorrection, signedDiffuseCorrection } from '../../src/render/pipeline/screen-space/diffuse-correction';
import { packedBands, unpackedBands } from '../../src/render/pipeline/screen-space/band-pyramid';
import { DiffuseCorrectionSource } from '../../src/render/pipeline/lighting/diffuse-correction-source';
import { SCREEN_SPACE_DIFFUSE } from '../../src/render/pipeline/screen-space/screen-space-pass';
import { test } from '../harness';
import { evaluateShaderNode } from './tsl-node-evaluator';
import type { ShadingSample } from '../../src/render/pipeline/lighting/shading-sample';

export function register(): void {
  test('screen space correction: 差分は負・零・正を保つ', () => {
    const signed = signedDiffuseCorrection(vec3(0, 1, 3), vec3(1, 1, 2));
    assert.deepStrictEqual(evaluateShaderNode(signed), [-1, 0, 1]);
  });

  test('screen space correction: 保存先は負値を保持できる half float', () => {
    const correction = new DiffuseCorrection();
    assert.strictEqual(correction.texture.type, THREE.HalfFloatType);
    assert.strictEqual(correction.texture.format, THREE.RGBAFormat);
    assert.strictEqual(correction.target.textures.length, 1);
    const readNode = correction.atUv(vec2(0, 0)) as unknown as { node: { value: THREE.Texture } };
    assert.strictEqual(readNode.node.value, correction.texture);
    correction.dispose();
  });

  test('screen space correction: 帯の描画先は帯の数ごとに 1 つで、半精度の RGBA を 1 標本 32 バイト以内に並べる', () => {
    const correction = new DiffuseCorrection();
    for (let count = 1; count <= 5; count++) {
      const target = correction.bandTarget(count);
      assert.strictEqual(correction.bandTarget(count), target);
      assert.strictEqual(target.textures.length, Math.ceil((3 * count) / 4));
      for (const texture of target.textures) {
        assert.strictEqual(texture.type, THREE.HalfFloatType);
        assert.strictEqual(texture.format, THREE.RGBAFormat);
      }
      // WebGPU が既定で保証する色の出力は、1 標本あたり 32 バイト(maxColorAttachmentBytesPerSample)。
      assert.ok(target.textures.length * 8 <= 32, `${count} 帯`);
    }
    correction.dispose();
  });

  test('screen space correction: 詰めた帯を取り出すと詰める前の帯に戻り、余りのチャンネルは 0', () => {
    for (let count = 1; count <= 5; count++) {
      const values = Array.from({ length: count }, (_, band) => [band + 0.25, -band - 0.5, 3 * band + 1]);
      const packed = packedBands(values.map(([r, g, b]) => vec3(r!, g!, b!)));
      const channels = packed.flatMap((value) => evaluateShaderNode(value) as number[]);
      assert.deepStrictEqual(channels.slice(3 * count), Array(channels.length - 3 * count).fill(0), `${count} 帯`);
      assert.deepStrictEqual(unpackedBands(packed, count).map((band) => evaluateShaderNode(band)), values);
    }
  });

  test('screen space correction: off だけ寄与を描かず、遮蔽と照り返しは同じ source を使う', () => {
    assert.deepStrictEqual(Object.values(SCREEN_SPACE_DIFFUSE), [0, 1, 2]);
    const correction = new DiffuseCorrection();
    const source = new DiffuseCorrectionSource(correction);
    for (const [mode, enabled] of [[SCREEN_SPACE_DIFFUSE.off, false],
      [SCREEN_SPACE_DIFFUSE.occlusion, true], [SCREEN_SPACE_DIFFUSE.indirect, true]] as const) {
      source.setEnabled(mode !== SCREEN_SPACE_DIFFUSE.off);
      assert.strictEqual(source.hasContribution(), enabled);
    }
    source.dispose();
    correction.dispose();
  });

  test('screen space correction: source は鏡面へ 0 だけを積む', () => {
    const correction = new DiffuseCorrection();
    const source = new DiffuseCorrectionSource(correction);
    const sample = { uv: vec2(0, 0), lit: bool(true) } as unknown as ShadingSample;
    const output = source.material(sample).mrtNode!.outputNodes as { specular: unknown };
    assert.deepStrictEqual(evaluateShaderNode(output.specular), [0, 0, 0, 1]);
    source.dispose();
    correction.dispose();
  });
}
