// 建造の表示導出の純粋な部分: 画面ピック・接続ノードの宣言・差し込みの動き。
// ピックは「半径内で最も近い候補、無ければ指したモジュールに属する最寄りの候補」、
// 差し込みは「2 m から 0.25 秒で 0 へ単調に収まる」という仕様由来の不変条件を固定する。
import * as assert from 'node:assert/strict';
import type { ProjectFn } from '../../src/math/projection';
import { v3 } from '../../src/math/vec3';
import {
  CONSTRUCTION_TARGET_PICK_RADIUS_SQ, pickConstructionTarget, pickConstructionTargetAtScreenPoint,
  type ConstructionTargetGuide, type ConstructionTargetScreenPoint,
} from '../../src/game/ship/ship-construction-candidates';
import type { ConstructionTrial } from '../../src/game/ship/ship-construction-preview';
import { constructionTargetId } from '../../src/game/ship/ship-construction-rules';
import type { ConstructionTarget } from '../../src/game/ship/ship-construction-types';
import {
  INSERTION_OFFSET_DISTANCE_M, INSERTION_OFFSET_DURATION_MS,
  constructionNodeDeclarations, constructionNodesVisible, insertionOffsetAt,
} from '../../src/game/ship/ship-construction-view';
import { test } from '../harness';

function point(
  id: string, x: number, y: number, front = true, moduleIds: readonly string[] = [],
): ConstructionTargetScreenPoint {
  return { id, moduleIds, x, y, front };
}

// テスト用の投影。投影先の座標値は読まないので ECI の x/y をそのまま画面座標へ返す。
const NODE_PROJECT: ProjectFn = (position) => ({ x: position.x, y: position.y, front: true });

function nodeGuide(target: ConstructionTarget, valid: boolean, reason: string | null = null): ConstructionTargetGuide {
  return {
    target, label: '', guideEci: v3(), normalEci: v3(0, 0, 1), guideRadius: 1,
    placement: { valid, reason, attachments: [], reattachment: null },
  };
}

function trial(valid: boolean, reason: string | null): ConstructionTrial {
  return {
    valid, reason, placed: [], totals: null,
    healthyCockpitRemains: true, overlapModuleIds: [],
  };
}

export function register(): void {
  test('construction target pick: 半径内で最も近い候補を選ぶ', () => {
    const targets = [
      point('far', 100, 0),
      point('near', 30, 0),
      point('nearest', 10, 0),
    ];
    assert.equal(
      pickConstructionTargetAtScreenPoint(targets, { x: 0, y: 0 }, 2500),
      'nearest',
    );
  });

  test('construction target pick: 半径の外なら null', () => {
    const targets = [point('out', 60, 0)];
    // 半径の2乗 2500(=50px)を 60px 離れた候補は超える。
    assert.equal(pickConstructionTargetAtScreenPoint(targets, { x: 0, y: 0 }, 2500), null);
    // 半径の内側なら選ぶ。
    assert.equal(
      pickConstructionTargetAtScreenPoint(targets, { x: 20, y: 0 }, 2500),
      'out',
    );
  });

  test('construction target pick: カメラの手前に無い候補は選ばない', () => {
    const targets = [point('behind', 5, 0, false), point('front', 40, 0, true)];
    assert.equal(
      pickConstructionTargetAtScreenPoint(targets, { x: 0, y: 0 }, 2500),
      'front',
    );
    assert.equal(
      pickConstructionTargetAtScreenPoint([point('behind', 5, 0, false)], { x: 0, y: 0 }, 2500),
      null,
    );
  });

  test('construction target pick: 半径内にノードがあればモジュールの候補よりノードを優先する', () => {
    const targets = [
      point('node', 10, 0, true, ['other-module']),
      point('module-candidate', 100, 0, true, ['hit-module']),
    ];
    let hitModuleCalled = false;
    const picked = pickConstructionTarget(targets, { x: 0, y: 0 }, 2500, () => {
      hitModuleCalled = true;
      return 'hit-module';
    });
    assert.equal(picked, 'node');
    // 半径内に候補がある間はポインタの下のモジュールを読まない。
    assert.equal(hitModuleCalled, false);
  });

  test('construction target pick: 半径内に無ければモジュールに属する最寄りの候補を選ぶ', () => {
    const targets = [
      point('far-side', 500, 0, true, ['hit-module']),
      point('near-side', 100, 0, true, ['hit-module']),
      point('other-module', 80, 0, true, ['other-module']),
      point('behind', 60, 0, false, ['hit-module']),
    ];
    assert.equal(
      pickConstructionTarget(targets, { x: 0, y: 0 }, 2500, () => 'hit-module'),
      'near-side',
    );
  });

  test('construction target pick: 当たったモジュールに候補が無ければ null', () => {
    const targets = [point('other', 100, 0, true, ['other-module'])];
    assert.equal(
      pickConstructionTarget(targets, { x: 0, y: 0 }, 2500, () => 'hit-module'),
      null,
    );
    assert.equal(
      pickConstructionTarget(targets, { x: 0, y: 0 }, 2500, () => null),
      null,
    );
  });

  test('construction target pick: 同じ入力には同じ結果を返す', () => {
    const targets = [point('a', 10, 0), point('b', -10, 0)];
    const radius = CONSTRUCTION_TARGET_PICK_RADIUS_SQ;
    assert.equal(
      pickConstructionTargetAtScreenPoint(targets, { x: 0, y: 0 }, radius),
      pickConstructionTargetAtScreenPoint(targets, { x: 0, y: 0 }, radius),
    );
  });

  test('construction nodes: 手に持たず選んでいるだけでも宣言が出る', () => {
    const target: ConstructionTarget = { kind: 'axial-face', parentId: 'm1', face: 'front' };
    // 手持ち無し・選択あり(編集可)で出る。
    assert.equal(constructionNodesVisible(null, 'm1', () => true), true);
    const declarations = constructionNodeDeclarations(
      [nodeGuide(target, true)], null, null, NODE_PROJECT, () => false, v3(),
    );
    assert.equal(declarations.length, 1);
    assert.equal(declarations[0]!.id, `construction-node:${constructionTargetId(target)}`);
  });

  test('construction nodes: 編集不可の選択では宣言が出ない', () => {
    assert.equal(constructionNodesVisible(null, 'm1', () => false), false);
    assert.equal(constructionNodesVisible(null, null, () => true), false);
    // 手持ちがあれば選択の可否に関わらず出る。
    assert.equal(
      constructionNodesVisible({ kind: 'catalog', definitionId: 'tank-3-main' }, null, () => false),
      true,
    );
  });

  test('construction nodes: 指している不適合ノードに理由が付き、有効なノードには付かない', () => {
    const invalidTarget: ConstructionTarget = { kind: 'axial-face', parentId: 'm1', face: 'front' };
    const validTarget: ConstructionTarget = { kind: 'axial-face', parentId: 'm2', face: 'back' };
    const guides = [
      nodeGuide(invalidTarget, false, 'その取り付け面はふさがっています'),
      nodeGuide(validTarget, true),
    ];
    const declarations = constructionNodeDeclarations(
      guides, constructionTargetId(invalidTarget), null, NODE_PROJECT, () => false, v3(),
    );
    // 規則の判定が不適合なら規則の理由を出す。指していないノードには付けない。
    assert.equal(declarations[0]!.label, 'その取り付け面はふさがっています');
    assert.equal(declarations[1]!.label, undefined);
    // 規則は通るが試し置きが不適合(重なり)なら試し置きの理由を出す。
    const overlapped = constructionNodeDeclarations(
      [guides[1]!], constructionTargetId(validTarget), trial(false, '他の部品と重なります'),
      NODE_PROJECT, () => false, v3(),
    );
    assert.equal(overlapped[0]!.label, '他の部品と重なります');
    // 指しているが有効なノードには付けない。
    const fine = constructionNodeDeclarations(
      [guides[1]!], constructionTargetId(validTarget), trial(true, null),
      NODE_PROJECT, () => false, v3(),
    );
    assert.equal(fine[0]!.label, undefined);
  });

  test('insertion offset: 0 で最大、時間を過ぎると 0', () => {
    assert.equal(insertionOffsetAt(0), INSERTION_OFFSET_DISTANCE_M);
    assert.equal(insertionOffsetAt(-10), INSERTION_OFFSET_DISTANCE_M);
    assert.equal(insertionOffsetAt(INSERTION_OFFSET_DURATION_MS), 0);
    assert.equal(insertionOffsetAt(INSERTION_OFFSET_DURATION_MS + 1), 0);
  });

  test('insertion offset: 2 m から 0 へ単調に減る', () => {
    let previous = INSERTION_OFFSET_DISTANCE_M;
    for (let ms = 0; ms < INSERTION_OFFSET_DURATION_MS; ms += 10) {
      const offset = insertionOffsetAt(ms);
      assert.ok(offset <= previous, `offset grew at ${ms}ms: ${offset} > ${previous}`);
      assert.ok(offset >= 0);
      previous = offset;
    }
    // 途中では 0 より大きい(差し込み途中のモジュールが見える)。
    assert.ok(insertionOffsetAt(INSERTION_OFFSET_DURATION_MS / 2) > 0);
    assert.ok(insertionOffsetAt(INSERTION_OFFSET_DURATION_MS / 2) < INSERTION_OFFSET_DISTANCE_M);
  });
}
