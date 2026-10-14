import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { float, vec2, vec3 } from 'three/tsl';
import { DiffuseCorrection, signedDiffuseCorrection } from '../../src/render/pipeline/screen-space/diffuse-correction';
import { bandLayoutOf, levelTextureFormats, packedBands, scanBandsOf, unpackedBands } from '../../src/render/pipeline/screen-space/band-pyramid';
import { diffuseIrradianceAt } from '../../src/render/pipeline/material-pass';
import { test } from '../harness';
import { containsShaderNode, evaluateShaderNode } from './tsl-node-evaluator';

export function register(): void {
  test('screen space correction: 差分は負・零・正を保つ', () => {
    const signed = signedDiffuseCorrection(vec3(0, 1, 3), vec3(1, 1, 2));
    assert.deepStrictEqual(evaluateShaderNode(signed), [-1, 0, 1]);
  });

  test('screen space correction: 遠方照度と補正の和を 0 以上にする', () => {
    const irradiance = diffuseIrradianceAt(vec3(3, 2, 1), vec3(-4, -1, 2));
    assert.ok(containsShaderNode(irradiance, (node) => node.method === 'max'));
    assert.ok(containsShaderNode(irradiance, (node) => node.op === '+'));
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

  test('screen space correction: layout ごとの描画先は段の型と形式を保つ', () => {
    const correction = new DiffuseCorrection();
    for (let count = 4; count <= 8; count++) {
      const layout = bandLayoutOf(count, 32);
      for (let level = 0; level < layout.length; level++) {
        const target = correction.bandTarget(layout, level);
        assert.strictEqual(correction.bandTarget(layout, level), target);
        const formats = levelTextureFormats(count, level, layout[level]!);
        assert.strictEqual(target.textures.length, formats.length);
        for (const [textureIndex, texture] of target.textures.entries()) {
          assert.strictEqual(texture.type, formats[textureIndex]!.type);
          assert.strictEqual(texture.format, formats[textureIndex]!.format);
        }
      }
    }
    correction.dispose();
  });

  test('screen space correction: 拡大と合流の出力は段 0..L − 2 に 1 枚ずつで、最も粗い段の C はその段の帯', () => {
    const correction = new DiffuseCorrection();
    for (let count = 1; count <= 5; count++) {
      const layout = bandLayoutOf(count, 128);
      for (let level = 0; level < count - 1; level++) {
        const target = correction.mergedTarget(layout, level);
        assert.strictEqual(target.textures.length, 1);
        assert.strictEqual(target.texture.type, THREE.HalfFloatType);
        assert.strictEqual(correction.mergedTexture(layout, level), target.texture);
      }
      assert.strictEqual(correction.mergedTexture(layout, count - 1), correction.bandTarget(layout, count - 1).texture);
    }
    correction.dispose();
  });

  test('screen space correction: 詰めた帯を取り出すと詰める前の帯に戻り、余りのチャンネルは 0', () => {
    for (let count = 1; count <= 5; count++) {
      const values = Array.from({ length: count }, (_, band) => [band + 0.25, -band - 0.5, 3 * band + 1]);
      const packed = packedBands(values.map(([r, g, b]) => vec3(r!, g!, b!)), 'packed-half', float(1));
      const channels = packed.flatMap((value) => evaluateShaderNode(value) as number[]);
      assert.deepStrictEqual(channels.slice(3 * count), Array(channels.length - 3 * count).fill(0), `${count} 帯`);
      assert.deepStrictEqual(unpackedBands(packed, count).map((band) => evaluateShaderNode(band)), values);
    }
  });

  test('screen space correction: 走査の packed-word は 4 語ずつ詰めて符号付き帯へ戻す', () => {
    const values = Array.from({ length: 8 }, (_, band) => [80 + band, -120 - band, band === 0 ? 0 : 200 + band]);
    const packed = packedBands(values.map(([r, g, b]) => vec3(r!, g!, b!)), 'packed-word', float(1));
    assert.strictEqual(packed.length, 2);
    const decoded = scanBandsOf(packed, values.length, 'packed-word', float(1));
    for (const [band, value] of decoded.entries()) {
      const actual = evaluateShaderNode(value) as number[];
      for (const [channel, component] of actual.entries()) {
        const expected = values[band]![channel]!;
        if (expected === 0) assert.strictEqual(component, 0);
        else assert.ok(Math.abs((component - expected) / expected) < 0.012);
      }
    }
  });

}
