import * as assert from 'node:assert/strict';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { createBasePreset } from '../../src/game/ship/ship-presets';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { enumerateConstructionTargets } from '../../src/game/ship/ship-construction-rules';
import { restoreDockedVessels, serializeShipAssembly } from '../../src/game/ship/ship-save';
import { CommandQueue } from '../../src/game/command-queue';
import { CommandCompletion } from '../../src/game/command-completion';
import {
  ShipConstruction, type ConstructionFocus, type ShipConstructionPanelPort,
} from '../../src/game/ship/ship-construction';
import { ShipConstructionEdits, type ConstructionShip } from '../../src/game/ship/ship-construction-edits';
import { ConstructionHistory } from '../../src/game/ship/ship-construction-history';
import { ShipCapabilities } from '../../src/game/ship/ship-capabilities';
import { ModularShipMotion } from '../../src/game/ship/modular-ship-motion';
import { kinematicState } from '../../src/physics/kinematic-state';
import { test } from '../harness';
import { Q_IDENTITY, qRotate } from '../../src/math/quat';
import { add, sub, v3 } from '../../src/math/vec3';
import type { Input } from '../../src/input/input';
import type { OverlayManager } from '../../src/hud/overlay-manager';
import type { Notifier } from '../../src/hud/notifier';
import type { DisplayWindowManager } from '../../src/game/display-window-manager';
import type { ModularShip } from '../../src/game/ship/modular-ship';
import type { RunEventSink } from '../../src/game/run-events';
import type { ModuleOrientation } from '../../src/game/ship/ship-assembly-transform';
import type { AxialFace } from '../../src/game/ship/ship-assembly-transform';
import type { TankInstance } from '../../src/game/ship/ship-module-instance';

const ORIENTATION: ModuleOrientation = { roll: 0, face: 'back' };

// 船体構成と運動を実部品で組み、構造編集後の物性を更新する。
class ConstructionTestShip implements ConstructionShip {
  public readonly assembly = createBasePreset();
  public readonly capabilities = new ShipCapabilities(this.assembly);
  public readonly motion = new ModularShipMotion(
    this.assembly, kinematicState<'eci'>(0, v3(100, 200, 300), v3()),
    { q: Q_IDENTITY, w: v3(), inertia: v3(1, 1, 1) },
  );

  // 質量特性と操作基準を編集済み船体へ合わせる。
  public synchronizeAssemblyState(): void {
    this.motion.synchronizeAssembly();
    this.capabilities.reconcileOperatingCockpit();
  }
}

// 起点ドックから見て前端側の空いている面の取り付け先を探す。
function axialFaceTarget(assembly: ShipAssembly, anchorId: string, parentId: string, face: AxialFace) {
  return enumerateConstructionTargets(assembly, anchorId).find(
    info => info.target.kind === 'axial-face' && info.target.parentId === parentId && info.target.face === face,
  );
}

export function register(): void {
  test('ship construction: catalog definitions expose presentation metadata', () => {
    assert.equal(SHIP_MODULE_CATALOG.require('cockpit-standard').name, 'コックピット');
    assert.equal(SHIP_MODULE_CATALOG.require('tank-6-main').category, 'fuel');
    assert.equal(SHIP_MODULE_CATALOG.require('weapon-gatling').category, 'combat');
  });

  test('ship construction: 保存された docking identity は全 edge と一対一である', () => {
    const host = createBasePreset();
    const guest = new ShipAssembly(SHIP_MODULE_CATALOG, true);
    guest.addRoot(createShipModuleInstance(
      SHIP_MODULE_CATALOG.require('docking-port-standard'), 'port',
    ));
    const merged = host.mergedAtDock(guest, 'dock-left', 'port', 'guest');
    assert.deepEqual(restoreDockedVessels([{
      connectionId: merged.connectionId, id: 'guest-ship', name: 'guest',
    }], merged.assembly), [{
      connectionId: merged.connectionId, id: 'guest-ship', name: 'guest',
    }]);
    assert.throws(() => restoreDockedVessels([], merged.assembly), /do not match docking connections/);
  });

  // (a) 撤去は先端部ごと消え、起点側は残る
  test('ship construction: 撤去は先端部ごと消え、起点側の船体は残る', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');

    edits.remove('rcs-tank');

    for (const id of ['rcs-tank', 'radiator-left', 'radiator-right']) {
      assert.equal(ship.assembly.module(id), null, `${id} が残っている`);
    }
    for (const id of ['dock-left', 'main-tank', 'cockpit', 'solar-left', 'solar-right', 'dock-right']) {
      assert.ok(ship.assembly.module(id) !== null, `${id} が消えた`);
    }
    assert.equal(ship.motion.mass, ship.assembly.totalMass);
    ship.assembly.assertValid();
  });

  // (b) 付け替えで識別子・HP・燃料が保たれる
  test('ship construction: 付け替えは識別子と HP と燃料を保つ', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    const tank = ship.assembly.module('rcs-tank') as TankInstance;
    ship.assembly.setHp('rcs-tank', tank.hp - 1);
    const fuelBefore = tank.fuel - ship.assembly.consumeFuel('rcs', 20);

    const target = axialFaceTarget(ship.assembly, 'dock-left', 'cockpit', 'front');
    assert.ok(target !== undefined);
    edits.move('rcs-tank', target.target, ORIENTATION);

    const moved = ship.assembly.module('rcs-tank') as TankInstance;
    assert.ok(moved !== null);
    assert.equal(moved.id, 'rcs-tank');
    assert.equal(moved.fuel, fuelBefore);
    assert.equal(moved.hp, ship.assembly.definition('rcs-tank')!.maxHp - 1);
    // 先端部の残りの識別子も保つ。
    assert.ok(ship.assembly.module('radiator-left') !== null);
    assert.ok(ship.assembly.module('radiator-right') !== null);
    assert.equal(
      ship.assembly.graph.find(edge => edge.childId === 'rcs-tank')?.parentId, 'cockpit',
    );
    ship.assembly.assertValid();
  });

  // (c) 割り込みで後ろ側が割り込んだモジュールの反対端へ付き、並びがその長さだけずれる
  test('ship construction: 継ぎ目への割り込みは後ろ側を割り込んだ部品の反対端へ付き直す', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    const joint = ship.assembly.graph.find(
      edge => edge.parentId === 'cockpit' && edge.childId === 'main-tank',
    );
    assert.ok(joint !== undefined);
    const jointTarget = enumerateConstructionTargets(ship.assembly, 'dock-left')
      .find(info => info.target.kind === 'joint' && info.target.connectionId === joint.id);
    assert.ok(jointTarget !== undefined);
    const before = ship.assembly.worldTransformOf('cockpit')!.position;
    const insertedLength = SHIP_MODULE_CATALOG.require('tank-3-main').length;

    edits.insert('tank-3-main', joint.id, ORIENTATION, 'inserted-tank');

    // 割り込んだモジュールは anchor 側(main-tank)へ付き、後ろ側(cockpit)は反対端へ付き直る。
    assert.equal(
      ship.assembly.graph.find(edge => edge.childId === 'inserted-tank')?.parentId, 'main-tank',
    );
    const reattached = ship.assembly.graph.find(
      edge => edge.parentId === 'inserted-tank' && edge.childId === 'cockpit',
    );
    assert.ok(reattached !== undefined);
    assert.equal(reattached.id, joint.id);
    const after = ship.assembly.worldTransformOf('cockpit')!.position;
    assert.ok(Math.abs(after.z - before.z - insertedLength) < 1e-9);
    ship.assembly.assertValid();
  });

  // (d) replaceAssembly で写しの時点へ戻る
  test('ship construction: replaceAssembly は船体を写しの時点へ戻す', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    const start = serializeShipAssembly(ship.assembly);
    const target = axialFaceTarget(ship.assembly, 'dock-left', 'dock-left', 'front');
    assert.ok(target !== undefined);
    edits.place(
      { kind: 'catalog', definitionId: 'tank-3-main' }, target.target, ORIENTATION, 1, ['placed-1'],
    );
    assert.ok(ship.assembly.module('placed-1') !== null);

    edits.replaceAssembly(start);

    assert.equal(ship.assembly.module('placed-1'), null);
    assert.ok(ship.assembly.module('dock-left') !== null);
    assert.equal(ship.motion.mass, ship.assembly.totalMass);
    ship.assembly.assertValid();
  });

  // (e) 起点ドックを動かす・消す命令は失敗する
  test('ship construction: 起点ドックの撤去・付け替え・回転は失敗する', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    const target = { kind: 'axial-face' as const, parentId: 'cockpit', face: 'front' as const };

    assert.throws(() => edits.remove('dock-left'), /起点のドック/);
    assert.throws(() => edits.move('dock-left', target, ORIENTATION), /起点のドック/);
    assert.throws(() => edits.reorient('dock-left', ORIENTATION), /起点のドック/);
    ship.assembly.assertValid();
  });

  test('ship construction: 命令を順に適用し、構成と物性を同時に更新する', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    const queue = new CommandQueue();
    const first = new CommandCompletion();
    const second = new CommandCompletion();
    const dockFront = axialFaceTarget(ship.assembly, 'dock-left', 'dock-left', 'front');
    assert.ok(dockFront !== undefined);
    queue.submitWithCompletion(
      () => edits.place(
        { kind: 'catalog', definitionId: 'tank-3-main' }, dockFront.target, ORIENTATION, 1, ['branch-tank'],
      ), first,
    );
    assert.equal(ship.assembly.module('branch-tank'), null);

    queue.applyAll();
    assert.equal(first.state.kind, 'succeeded');
    // ドックの前端への配置は建造接続になる。
    assert.equal(
      ship.assembly.graph.find(edge => edge.childId === 'branch-tank')?.kind, 'construction',
    );
    assert.equal(ship.motion.mass, ship.assembly.totalMass);

    const branchFront = axialFaceTarget(ship.assembly, 'dock-left', 'branch-tank', 'front');
    assert.ok(branchFront !== undefined);
    queue.submitWithCompletion(
      () => edits.place(
        { kind: 'catalog', definitionId: 'tank-3-main' }, branchFront.target, ORIENTATION, 1, ['branch-tank-2'],
      ), second,
    );
    queue.applyAll();
    assert.equal(second.state.kind, 'succeeded');
    assert.equal(
      ship.assembly.graph.find(edge => edge.childId === 'branch-tank-2')?.parentId, 'branch-tank',
    );
    ship.assembly.assertValid();
  });

  test('ship construction: 適用前に取り付け先が消えた配置命令は構成を変更しない', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    const target = axialFaceTarget(ship.assembly, 'dock-left', 'rcs-tank', 'back');
    assert.ok(target !== undefined);
    const queue = new CommandQueue();
    const completion = new CommandCompletion();
    queue.submitWithCompletion(
      () => edits.place(
        { kind: 'catalog', definitionId: 'tank-3-main' }, target.target, ORIENTATION, 1, ['extra-tank'],
      ), completion,
    );
    // 適用前に取り付け先の親ごと撤去する。
    edits.remove('rcs-tank');
    const originalIds = ship.assembly.moduleIds;
    queue.applyAll();
    assert.equal(completion.state.kind, 'failed');
    assert.deepEqual(ship.assembly.moduleIds, originalIds);
    ship.assembly.assertValid();
  });

  test('ship construction: 破壊済みドックへの編集を適用時に拒否する', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    const target = axialFaceTarget(ship.assembly, 'dock-left', 'dock-left', 'front');
    assert.ok(target !== undefined);
    const queue = new CommandQueue();
    const completion = new CommandCompletion();
    queue.submitWithCompletion(
      () => edits.place(
        { kind: 'catalog', definitionId: 'tank-3-main' }, target.target, ORIENTATION, 1, ['branch-tank'],
      ), completion,
    );
    ship.assembly.setHp('dock-left', 0);
    queue.applyAll();
    assert.equal(completion.state.kind, 'failed');
    assert.equal(ship.assembly.module('branch-tank'), null);
    ship.assembly.assertValid();
  });

  test('ship construction: 配置済みモジュールを接続軸まわりへ回しても接続は保つ', () => {
    const ship = new ConstructionTestShip();
    const edits = new ShipConstructionEdits(ship, 'dock-left');
    // solar-left は cockpit の側面接続。回すとロールだけが変わる。
    edits.reorient('solar-left', { roll: 1, face: 'back' });
    ship.assembly.assertValid();
    const edge = ship.assembly.graph.find(candidate => candidate.childId === 'solar-left');
    assert.equal(edge?.kind, 'side');
    const rotated = ship.assembly.worldTransformOf('solar-left');
    assert.ok(rotated !== null);
  });

  test('ship construction history: 上限を超えたら開始時を残して古い順に捨てる', () => {
    const start = serializeShipAssembly(createBasePreset());
    const history = new ConstructionHistory(start);
    for (let index = 0; index < ConstructionHistory.LIMIT + 10; index++) {
      history.record(`操作${index}`, start);
    }
    assert.equal(history.entriesView.length, ConstructionHistory.LIMIT);
    assert.equal(history.entriesView[0]?.name, '建造を開始');
    assert.equal(history.entriesView[0]?.assembly, start);
    assert.equal(history.position, ConstructionHistory.LIMIT - 1);
    // 開始時の次から古い順に捨てるので、残る最古の操作は 11 件捨てたあとのもの。
    assert.equal(history.entriesView[1]?.name, `操作${11}`);
  });

  test('ship construction history: 取り消しのあと新しい操作を積むとやり直し分は消える', () => {
    const start = serializeShipAssembly(createBasePreset());
    const history = new ConstructionHistory(start);
    const after = serializeShipAssembly(createBasePreset());
    history.record('a', after);
    history.record('b', after);
    assert.equal(history.position, 2);

    history.moveTo(1);
    assert.equal(history.target(0), start);
    assert.equal(history.canRedo, true);

    history.record('c', after);
    assert.equal(history.canRedo, false);
    assert.equal(history.canUndo, true);
    assert.deepEqual(history.names, ['建造を開始', 'a', 'c']);
  });

  test('ship construction: 視点寄せは選択中のモジュールへ、無ければ船体全体へ寄せる', () => {
    const ship = new ConstructionTestShip();
    const focuses: { ship: ModularShip; target: ConstructionFocus | null }[] = [];
    const construction = new ShipConstruction(
      {} as unknown as Input,
      new CommandQueue(),
      {
        element: { contains: () => false },
        selectCatalogCategory: () => {},
        sync: () => {},
      } as unknown as ShipConstructionPanelPort,
      { openMode: () => {}, close: () => {}, isInputGated: () => false } as unknown as OverlayManager,
      { current: { forceCurrent: false }, setForceCurrent: () => {} } as unknown as DisplayWindowManager,
      { hint: () => {} } as unknown as Notifier,
      { request: () => {}, close: () => {} },
      { blueprints: [], canRecord: false },
      { record: () => {} } as unknown as RunEventSink,
      (s, target) => { focuses.push({ ship: s, target }); },
    );
    construction.start(ship as unknown as ModularShip, 'dock-left');

    // 建造開始時と選択なしの視点寄せは、船体全体へ寄せる(target は null)。
    assert.equal(focuses.length, 1);
    assert.equal(focuses[0]!.ship as unknown, ship);
    assert.equal(focuses[0]!.target, null);
    construction.focus();
    assert.equal(focuses.length, 2);
    assert.equal(focuses[1]!.target, null);

    // 選択中はそのモジュールの ECI 位置と外接半径が渡る。
    construction.select('cockpit');
    construction.focus();
    const target = focuses[2]?.target;
    assert.ok(target !== null && target !== undefined);
    const { motion } = ship;
    const root = sub(motion.state.r, qRotate(motion.att.q, motion.centerOffset));
    const expected = add(
      root, qRotate(motion.att.q, ship.assembly.worldTransformOf('cockpit')!.position),
    );
    assert.ok(Math.abs(target.position.x - expected.x) < 1e-9);
    assert.ok(Math.abs(target.position.y - expected.y) < 1e-9);
    assert.ok(Math.abs(target.position.z - expected.z) < 1e-9);
    const definition = ship.assembly.definition('cockpit')!;
    assert.ok(Math.abs(target.radius - Math.hypot(definition.length, definition.diameter) / 2) < 1e-9);
  });

  test('ship construction history: 戻す先の写しを返すだけで位置は確定を待つ', () => {
    const start = serializeShipAssembly(createBasePreset());
    const history = new ConstructionHistory(start);
    const after = serializeShipAssembly(createBasePreset());
    history.record('a', after);
    assert.equal(history.target(0), start);
    assert.equal(history.target(9), null);
    // target は位置を動かさない。
    assert.equal(history.position, 1);
    history.moveTo(0);
    assert.equal(history.position, 0);
    history.moveTo(99);
    assert.equal(history.position, 0);
  });
}
