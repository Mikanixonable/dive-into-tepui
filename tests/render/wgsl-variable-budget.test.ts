// 一時変数の let 化が、意味を保つ変数だけを書き換えることを固定する。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { promoteSingleAssignmentVariables } from '../../src/render/pipeline/wgsl-variable-budget';

function shader(declarations: string[], body: string[]): string {
  return [...declarations, 'fn main() {', ...body.map((line) => `\t${line}`), '}'].join('\n');
}

export function register(): void {
  test('wgsl variable budget: 1 度だけ代入され後で読まれる変数は let になり、宣言は空行になる', () => {
    const code = shader(['var<private> nodeVar0 : f32;'], ['nodeVar0 = 1.0;', 'output = nodeVar0 + 2.0;']);
    const out = promoteSingleAssignmentVariables(code);
    assert.ok(out.includes('let nodeVar0 : f32 = 1.0;'));
    assert.ok(!out.includes('var<private> nodeVar0'));
    assert.equal(out.split('\n').length, code.split('\n').length);
  });

  test('wgsl variable budget: 複数回代入される変数は var のまま残る', () => {
    const code = shader(['var<private> nodeVar0 : f32;'], ['nodeVar0 = 1.0;', 'nodeVar0 = nodeVar0 + 1.0;']);
    assert.equal(promoteSingleAssignmentVariables(code), code);
  });

  test('wgsl variable budget: 部分代入や複合代入で更新される変数は var のまま残る', () => {
    for (const update of ['nodeVar0.x = 2.0;', 'nodeVar0 += vec3<f32>(1.0);', 'nodeVar0[1] = 2.0;']) {
      const code = shader(['var<private> nodeVar0 : vec3<f32>;'], ['nodeVar0 = vec3<f32>(0.0);', update]);
      assert.equal(promoteSingleAssignmentVariables(code), code, update);
    }
  });

  test('wgsl variable budget: 代入した block の外で読まれる変数は var のまま残る', () => {
    const code = shader(['var<private> nodeVar0 : f32;'], [
      'if ( cond ) {', '\tnodeVar0 = 1.0;', '}', 'output = nodeVar0;',
    ]);
    assert.equal(promoteSingleAssignmentVariables(code), code);
  });

  test('wgsl variable budget: 代入した block の内側で読まれる変数は let になる', () => {
    const code = shader(['var<private> nodeVar0 : f32;'], [
      'nodeVar0 = 1.0;', 'if ( cond ) {', '\toutput = nodeVar0;', '}',
    ]);
    assert.ok(promoteSingleAssignmentVariables(code).includes('let nodeVar0 : f32 = 1.0;'));
  });

  test('wgsl variable budget: 代入より前に読まれる変数(ループの持ち越し)は var のまま残る', () => {
    const code = shader(['var<private> nodeVar0 : f32;'], [
      'loop {', '\toutput = nodeVar0;', '\tnodeVar0 = 1.0;', '}',
    ]);
    assert.equal(promoteSingleAssignmentVariables(code), code);
  });

  test('wgsl variable budget: 一時変数が無いソースはそのまま返る', () => {
    const code = shader(['var<private> output : vec4<f32>;'], ['output = vec4<f32>(1.0);']);
    assert.equal(promoteSingleAssignmentVariables(code), code);
  });
}
