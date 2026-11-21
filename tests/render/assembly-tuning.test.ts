import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { generateAssemblyShape } from '../../src/physics/assembly-shape';
import {
  ASSEMBLY_TUNING_DEFAULTS, resolveAssemblyTuning, type AssemblyTuningId,
} from '../../src/physics/assembly-tuning';
import { test } from '../harness';

// 形状パラメータの調整(SPEC/ASSEMBLY.md の個体のばらつき)。調整値が生成器へ効く契約と、
// 実験環境(tools/enemy-lab)が既定値の表を書き換えられる形を固定する。

export function register(): void {
  test('assembly tuning: 部分的な値を既定値へ重ね、整数を丸め、上限が下限を下回る対を揃える', () => {
    const tuned = resolveAssemblyTuning({
      spineStepsMin: 6.6, outerRadiusMin: 90, outerRadiusMax: 50, wholeKnotProbability: 0.1,
    });
    assert.equal(tuned.spineStepsMin, 7);
    assert.equal(tuned.outerRadiusMax, 90);
    assert.equal(tuned.wholeKnotProbability, 0.1);
    assert.equal(tuned.branchCountMax, ASSEMBLY_TUNING_DEFAULTS.branchCountMax);
  });

  test('assembly tuning: 知らない項目と有限でない値は捨てる', () => {
    const tuned = resolveAssemblyTuning({ nope: 5, walkTurnMax: Number.NaN, localKnotScale: '2' });
    assert.deepEqual(tuned, resolveAssemblyTuning({}));
  });

  test('assembly tuning: 外接半径の範囲を狭めれば、個体の大きさがその中に収まる', () => {
    const tuning = resolveAssemblyTuning({ outerRadiusMin: 20, outerRadiusMax: 25 });
    for (let seed = 0; seed < 60; seed += 1) {
      const { outerRadius } = generateAssemblyShape(seed, tuning);
      assert.ok(outerRadius >= 20 && outerRadius <= 25, `seed ${seed}: ${outerRadius}`);
    }
  });

  test('assembly tuning: 全体が結び目の確率を 1 / 0 にすると、結び目型だけ / 枝分かれ型だけになる', () => {
    const always = resolveAssemblyTuning({ wholeKnotProbability: 1 });
    const never = resolveAssemblyTuning({ wholeKnotProbability: 0, localKnotProbability: 0 });
    for (let seed = 0; seed < 60; seed += 1) {
      assert.ok(generateAssemblyShape(seed, always).parts.some((part) => part.kind === 'knot' && !part.closed));
      assert.ok(generateAssemblyShape(seed, never).parts.every((part) => part.kind === 'tube'));
    }
  });

  test('assembly tuning: 枝の本数の上限を 0 にすると、主鎖の分割数以上の部品は出ない', () => {
    const tuning = resolveAssemblyTuning({
      wholeKnotProbability: 0, localKnotProbability: 0, branchCountMax: 0, spinePartsMin: 2, spinePartsMax: 3,
    });
    for (let seed = 0; seed < 60; seed += 1) {
      const count = generateAssemblyShape(seed, tuning).parts.length;
      assert.ok(count >= 2 && count <= 3, `seed ${seed}: ${count}`);
    }
  });

  test('assembly tuning: 既定値の表は 1 行 1 項目の数値で、実験環境が行単位で書き換えられる', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/physics/assembly-tuning.ts'), 'utf8');
    for (const id of Object.keys(ASSEMBLY_TUNING_DEFAULTS) as AssemblyTuningId[]) {
      const line = new RegExp(`^  ${id}:\\s*-?[0-9.]+,`, 'm');
      assert.ok(line.test(source), `${id} が 1 行の数値として書かれていない`);
    }
  });
}
