import * as assert from 'node:assert/strict';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { createBasePreset, createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import {
  enumerateConstructionTargets, jointEndsOf, placementFor,
  type ConstructionTargetInfo,
} from '../../src/game/ship/ship-construction-rules';
import { tryConstructionPlacement } from '../../src/game/ship/ship-construction-preview';
import type { ConstructionHeld } from '../../src/game/ship/ship-construction-types';
import type { SideSlot } from '../../src/game/ship/ship-assembly-types';
import type { AxialFace } from '../../src/game/ship/ship-assembly-transform';
import { test } from '../harness';

const ANCHOR = 'dock-left';

function catalogHeld(definitionId: string): ConstructionHeld {
  return { kind: 'catalog', definitionId };
}

function faceTarget(assembly: ShipAssembly, parentId: string, face: AxialFace): ConstructionTargetInfo {
  const info = enumerateConstructionTargets(assembly, ANCHOR).find(
    entry => entry.target.kind === 'axial-face'
      && entry.target.parentId === parentId && entry.target.face === face,
  );
  assert.ok(info !== undefined);
  return info;
}

function sideTarget(assembly: ShipAssembly, parentId: string, slot: SideSlot): ConstructionTargetInfo {
  const info = enumerateConstructionTargets(assembly, ANCHOR).find(
    entry => entry.target.kind === 'side-slot'
      && entry.target.parentId === parentId && entry.target.slot === slot,
  );
  assert.ok(info !== undefined);
  return info;
}

function jointTarget(assembly: ShipAssembly, nearId: string, farId: string): ConstructionTargetInfo {
  const edge = assembly.graph.find(
    connection => (connection.kind === 'axial' || connection.kind === 'construction')
      && ((connection.parentId === nearId && connection.childId === farId)
        || (connection.parentId === farId && connection.childId === nearId)),
  );
  assert.ok(edge !== undefined);
  const info = enumerateConstructionTargets(assembly, ANCHOR).find(
    entry => entry.target.kind === 'joint' && entry.target.connectionId === edge.id,
  );
  assert.ok(info !== undefined);
  return info;
}

export function register(): void {
  test('ship construction rules: 空いている面・側面・継ぎ目を全モジュールから列挙する', () => {
    const targets = enumerateConstructionTargets(createBasePreset(), ANCHOR);
    const faces = targets.filter(entry => entry.target.kind === 'axial-face');
    const sides = targets.filter(entry => entry.target.kind === 'side-slot');
    const joints = targets.filter(entry => entry.target.kind === 'joint');
    assert.equal(faces.length, 6); // cockpit 前端・rcs-tank 後端・両ドックの前後
    assert.equal(sides.length, 6); // cockpit ±x・main-tank ±y・rcs-tank ±y
    assert.equal(joints.length, 2); // cockpit—main-tank・main-tank—rcs-tank
    // 使用中の面・使用中の側面・none の面は出ない。
    assert.equal(targets.some(entry => entry.target.kind === 'axial-face'
      && entry.target.parentId === 'cockpit' && entry.target.face === 'back'), false);
    assert.equal(targets.some(entry => entry.target.kind === 'side-slot'
      && entry.target.parentId === 'cockpit' && entry.target.slot === 'side:+y'), false);
  });

  test('ship construction rules: ラベルは名前・通し番号・位置で内部識別子を含まない', () => {
    const targets = enumerateConstructionTargets(createBasePreset(), ANCHOR);
    assert.equal(faceTarget(createBasePreset(), 'dock-left', 'front').label, '建造ドック 1 の前端');
    assert.equal(faceTarget(createBasePreset(), 'dock-right', 'front').label, '建造ドック 2 の前端');
    assert.equal(sideTarget(createBasePreset(), 'cockpit', 'side:-x').label, 'コックピット 1 の左');
    for (const info of targets) {
      assert.ok(!/module-\d|connection-|dock-left|dock-right|main-tank|rcs-tank|solar-left/.test(info.label),
        `label contains an internal id: ${info.label}`);
    }
  });

  // (a) 側面専用部品と片端部品、結合面の扱い。
  test('ship construction rules: 太陽電池は側面専用・スラスターは両方向の空き面へ置ける', () => {
    const assembly = createBasePreset();
    const orientation = { roll: 0 as const, face: 'front' as const };
    assert.equal(placementFor(
      assembly, ANCHOR, catalogHeld('solar-panel-standard'),
      faceTarget(assembly, 'cockpit', 'front').target, orientation, 1,
    ).valid, false);
    assert.equal(placementFor(
      assembly, ANCHOR, catalogHeld('solar-panel-standard'),
      sideTarget(assembly, 'cockpit', 'side:+x').target, orientation, 1,
    ).valid, true);
    // 片端だけ面を持つスラスターは、親の前端・後端のどちらへも置ける。
    for (const target of [faceTarget(assembly, 'cockpit', 'front'), faceTarget(assembly, 'rcs-tank', 'back')]) {
      assert.equal(placementFor(
        assembly, ANCHOR, catalogHeld('thruster-standard'), target.target, orientation, 1,
      ).valid, true);
    }
    // ドッキングポートの結合面(none)は候補に出ない。
    const combat = createDefaultCombatPreset();
    const targets = enumerateConstructionTargets(combat, 'docking-port');
    assert.equal(targets.some(entry => entry.target.kind === 'axial-face'
      && entry.target.parentId === 'docking-port' && entry.target.face === 'front'), false);
  });

  // (b) 建造接続と軸接続、receive 面の向き。
  test('ship construction rules: ドックの結合面への配置は建造接続になる', () => {
    const assembly = createBasePreset();
    const orientation = { roll: 0 as const, face: 'back' as const };
    const atDock = placementFor(
      assembly, ANCHOR, catalogHeld('tank-3-main'),
      faceTarget(assembly, 'dock-left', 'front').target, orientation, 1,
    );
    assert.equal(atDock.valid, true);
    assert.equal(atDock.attachments[0]?.connectionKind, 'construction');
    const atTank = placementFor(
      assembly, ANCHOR, catalogHeld('tank-3-main'),
      faceTarget(assembly, 'cockpit', 'front').target, orientation, 1,
    );
    assert.equal(atTank.valid, true);
    assert.equal(atTank.attachments[0]?.connectionKind, 'axial');
    // 建造ドックの結合面は他が付くための面で、自分からは付けない。
    const dockHeld = catalogHeld('dock-standard');
    assert.equal(placementFor(
      assembly, ANCHOR, dockHeld, faceTarget(assembly, 'cockpit', 'front').target,
      { roll: 0, face: 'front' }, 1,
    ).valid, false);
    assert.equal(placementFor(
      assembly, ANCHOR, dockHeld, faceTarget(assembly, 'cockpit', 'front').target, orientation, 1,
    ).valid, true);
  });

  // (c) 前後反転は両端に面を持つ定義だけで有効。
  test('ship construction rules: 取り付け端の入れ替えは両端に面を持つ部品だけで効く', () => {
    const assembly = createBasePreset();
    const target = faceTarget(assembly, 'cockpit', 'front').target;
    for (const face of ['front', 'back'] as const) {
      assert.equal(placementFor(
        assembly, ANCHOR, catalogHeld('tank-3-main'), target, { roll: 0, face }, 1,
      ).valid, true);
    }
    // 片端だけのスラスターは、面を持たない端での反転が無効。
    assert.equal(placementFor(
      assembly, ANCHOR, catalogHeld('thruster-standard'), target, { roll: 0, face: 'back' }, 1,
    ).valid, false);
    assert.equal(placementFor(
      assembly, ANCHOR, catalogHeld('thruster-standard'), target, { roll: 0, face: 'front' }, 1,
    ).valid, true);
  });

  // (d) 対称配置。
  test('ship construction rules: 対称は側面の新しい配置で1か所でも置けなければ無効', () => {
    const assembly = createBasePreset();
    const orientation = { roll: 0 as const, face: 'back' as const };
    const held = catalogHeld('solar-panel-standard');
    // main-tank は ±x が埋まっているので4回対称は無効。
    assert.equal(placementFor(
      assembly, ANCHOR, held, sideTarget(assembly, 'main-tank', 'side:+y').target, orientation, 4,
    ).valid, false);
    // ±y の対向2位置は空いているので2回対称は有効で、2本の接ぎ木を返す。
    const symmetric = placementFor(
      assembly, ANCHOR, held, sideTarget(assembly, 'main-tank', 'side:+y').target, orientation, 2,
    );
    assert.equal(symmetric.valid, true);
    assert.equal(symmetric.attachments.length, 2);
    assert.deepEqual(
      new Set(symmetric.attachments.map(plan => plan.sideSlot)), new Set(['side:+y', 'side:-y']),
    );
    // 付け替えと軸方向の面では対称を使えない。
    assert.equal(placementFor(
      assembly, ANCHOR, { kind: 'piece', moduleId: 'solar-left' },
      sideTarget(assembly, 'cockpit', 'side:+x').target, orientation, 2,
    ).valid, false);
    assert.equal(placementFor(
      assembly, ANCHOR, held, faceTarget(assembly, 'cockpit', 'front').target, orientation, 2,
    ).valid, false);
  });

  // (e) 体積の重なり判定。
  test('ship construction rules: 側面設備と重なる配置は無効で重なる相手が分かる', () => {
    const assembly = createBasePreset();
    // ドッキングポートを根に 12 m タンクがぶら下がる写し。側面へ置くとタンクが船体へ潜り込む。
    const piece = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    piece.addRoot(createShipModuleInstance(SHIP_MODULE_CATALOG.require('docking-port-standard'), 'bp-port'));
    piece.append(createShipModuleInstance(SHIP_MODULE_CATALOG.require('tank-12-main'), 'bp-tank'));
    const held: ConstructionHeld = { kind: 'copy', piece };
    const target = sideTarget(assembly, 'cockpit', 'side:-x').target;
    assert.equal(placementFor(assembly, ANCHOR, held, target, { roll: 0, face: 'back' }, 1).valid, true);
    const trial = tryConstructionPlacement(assembly, ANCHOR, held, target, { roll: 0, face: 'back' }, 1);
    assert.equal(trial.valid, false);
    assert.ok(trial.overlapModuleIds.includes('solar-left'));
    assert.ok(trial.overlapModuleIds.includes('solar-right'));
    // 面どうしが接するだけの配置は有効で、直接接続する組は重なりとみなさない。
    const flush = tryConstructionPlacement(
      assembly, ANCHOR, catalogHeld('decoupler-standard'),
      faceTarget(assembly, 'rcs-tank', 'back').target, { roll: 0, face: 'back' }, 1,
    );
    assert.equal(flush.valid, true);
    assert.deepEqual(flush.overlapModuleIds, []);
  });

  // (f) 起点ドックは手持ちにできず、付け替えは先端部の内側へ付けられない。
  test('ship construction rules: 起点ドックと先端部の内側は掴めない・付けられない', () => {
    const assembly = createBasePreset();
    const target = faceTarget(assembly, 'cockpit', 'front').target;
    const orientation = { roll: 0 as const, face: 'back' as const };
    assert.equal(placementFor(
      assembly, ANCHOR, { kind: 'piece', moduleId: 'dock-left' }, target, orientation, 1,
    ).valid, false);
    // main-tank の先端部は cockpit・rcs-tank 側を含むので、その内側の面へは付けられない。
    assert.equal(placementFor(
      assembly, ANCHOR, { kind: 'piece', moduleId: 'main-tank' }, target, orientation, 1,
    ).valid, false);
    // 別の先端部(葉のモジュール)は掴んで動かせる。
    assert.equal(placementFor(
      assembly, ANCHOR, { kind: 'piece', moduleId: 'solar-left' },
      sideTarget(assembly, 'cockpit', 'side:+x').target, orientation, 1,
    ).valid, true);
    assert.equal(placementFor(
      assembly, ANCHOR, { kind: 'piece', moduleId: 'dock-right' },
      faceTarget(assembly, 'cockpit', 'front').target, orientation, 1,
    ).valid, true);
  });

  // (g) 継ぎ目への割り込みは両端に面を持つカタログ定義だけ。
  test('ship construction rules: 継ぎ目へは両端に面を持つカタログ定義だけを割り込ませる', () => {
    const assembly = createBasePreset();
    const target = jointTarget(assembly, 'main-tank', 'rcs-tank').target;
    const orientation = { roll: 0 as const, face: 'front' as const };
    const inserted = placementFor(assembly, ANCHOR, catalogHeld('decoupler-standard'), target, orientation, 1);
    assert.equal(inserted.valid, true);
    // 起点ドックに近い側(main-tank)へ付き、遠い側(rcs-tank)が反対側の端へ付き直す。
    assert.equal(inserted.attachments[0]?.parentId, 'main-tank');
    assert.equal(inserted.attachments[0]?.connectionKind, 'axial');
    assert.equal(inserted.reattachment?.farModuleId, 'rcs-tank');
    // 片端だけの定義・付け替え・写しは割り込めない。
    for (const held of [
      catalogHeld('thruster-standard'),
      { kind: 'piece', moduleId: 'solar-left' } as const,
      { kind: 'copy', piece: createBasePreset().detachPiece('solar-left', ANCHOR) } as const,
    ]) {
      assert.equal(placementFor(assembly, ANCHOR, held, target, orientation, 1).valid, false);
    }
    // 側面接続は継ぎ目にならない。
    const sideEdge = assembly.graph.find(connection => connection.kind === 'side');
    assert.ok(sideEdge !== undefined);
    assert.equal(jointEndsOf(assembly, ANCHOR, sideEdge.id), null);
  });

  test('ship construction rules: 継ぎ目の割り込みで後ろ側が置いたモジュールへ付き直る', () => {
    const assembly = createBasePreset();
    const before = assembly.worldTransformOf('rcs-tank');
    assert.ok(before !== null);
    const trial = tryConstructionPlacement(
      assembly, ANCHOR, catalogHeld('decoupler-standard'),
      jointTarget(assembly, 'main-tank', 'rcs-tank').target, { roll: 0, face: 'front' }, 1,
    );
    assert.equal(trial.valid, true);
    assert.equal(trial.placed.length, 1);
    // 置いたデカプラーは main-tank の後端へ長さ1 m 分だけ入る。
    const inserted = trial.placed[0]!;
    const mainTank = assembly.worldTransformOf('main-tank');
    assert.ok(mainTank !== null);
    assert.ok(Math.abs(inserted.transform.position.z - (mainTank.position.z - 3.5)) < 1e-9);
    // 元の船体は変わらない。
    assert.equal(assembly.moduleIds.length, 9);
    assert.deepEqual(assembly.worldTransformOf('rcs-tank'), before);
  });

  test('ship construction rules: 試し置きは配置後の総量とコックピットと位置を返す', () => {
    const assembly = createBasePreset();
    const massBefore = assembly.totals().mass;
    const target = faceTarget(assembly, 'dock-left', 'front').target;
    const trial = tryConstructionPlacement(
      assembly, ANCHOR, catalogHeld('decoupler-standard'), target, { roll: 0, face: 'back' }, 1,
    );
    assert.equal(trial.valid, true);
    assert.equal(trial.placed.length, 1);
    assert.equal(trial.healthyCockpitRemains, true);
    assert.ok(trial.totals !== null);
    const added = SHIP_MODULE_CATALOG.require('decoupler-standard');
    assert.ok(Math.abs(trial.totals.mass - (massBefore + added.dryMass)) < 1e-9);
    // 置いたモジュールはドックの結合面の先へ出る。dock-left は -x を向いている。
    const placed = trial.placed[0]!;
    const dock = assembly.worldTransformOf('dock-left');
    assert.ok(dock !== null);
    assert.ok(placed.transform.position.x < dock.position.x);
    // 付け替えは識別子を保つ。
    const move = tryConstructionPlacement(
      assembly, ANCHOR, { kind: 'piece', moduleId: 'solar-left' },
      sideTarget(assembly, 'cockpit', 'side:+x').target, { roll: 0, face: 'back' }, 1,
    );
    assert.equal(move.valid, true);
    assert.deepEqual(move.placed.map(entry => entry.moduleId), ['solar-left']);
  });
}
