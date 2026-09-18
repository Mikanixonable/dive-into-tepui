// 実体ごとの表示設定が保存された実体の記録から戻り、切り替えが往復することを固定する(R4)。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import { EntityDisplaySelection } from '../../src/game/viewer/entity-display-selection';
import { DEFAULT_PROTEIN_DISPLAY, type ProteinDisplaySettings } from '../../src/render/protein/protein-display';
import type { SerializedAmmoPickup } from '../../src/game/dynamic/dynamic-entity/pickup';
import type { SerializedBase } from '../../src/game/dynamic/dynamic-entity/base';
import type { SerializedMetalEnemy } from '../../src/game/dynamic/dynamic-entity/metal-enemy';
import type { SerializedProteinEnemy } from '../../src/game/dynamic/dynamic-entity/protein-enemy';

const ZERO = { x: 0, y: 0, z: 0 };
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

// id の金属の敵の記録。showTrajectoryLine を省くと項目ごと持たない。
function metalEnemy(id: string, showTrajectoryLine?: boolean): SerializedMetalEnemy {
  return {
    id, kind: 'metal-enemy', r: ZERO, v: ZERO, q: IDENTITY, w: ZERO,
    alive: true, health: 1, accent: 0, orbitLineColor: 0, typeIndex: null,
    ...(showTrajectoryLine === undefined ? {} : { showTrajectoryLine }),
  };
}

// id のタンパク質の敵の記録。display は検証前の保存値として受ける。
function proteinEnemy(id: string, display: unknown): SerializedProteinEnemy {
  return {
    id, kind: 'protein-enemy', r: ZERO, v: ZERO, q: IDENTITY, w: ZERO,
    alive: true, health: 1, accent: 0, orbitLineColor: 0,
    assetId: 'pdb-5i4r',
    display: display as ProteinDisplaySettings,
    protein: { schemaVersion: 1, integrityHp: 1, sites: [], modifications: {} },
  };
}

// 実体ごとの表示設定の規則を登録する。
export function register(): void {
  test('entity-display-selection: 保存で showTrajectoryLine が true の id だけ線を出す', () => {
    const ammo: SerializedAmmoPickup = { id: 'ammo-0', kind: 'ammo', r: ZERO, v: ZERO, q: IDENTITY, w: ZERO };
    const base: SerializedBase = {
      id: 'base-0', kind: 'base', r: ZERO, v: ZERO, q: IDENTITY, w: ZERO, money: 0, showTrajectoryLine: true,
    };
    const selection = new EntityDisplaySelection([
      metalEnemy('entity-0', true), metalEnemy('entity-1', false), metalEnemy('entity-2'), ammo, base,
    ]);

    assert.equal(selection.showsTrajectoryLine('entity-0'), true);
    assert.equal(selection.showsTrajectoryLine('base-0'), true);
    assert.equal(selection.showsTrajectoryLine('entity-1'), false);
    assert.equal(selection.showsTrajectoryLine('entity-2'), false);
    assert.equal(selection.showsTrajectoryLine('ammo-0'), false);
    assert.equal(selection.showsTrajectoryLine('entity-9'), false);
    assert.equal(new EntityDisplaySelection(undefined).showsTrajectoryLine('entity-0'), false);
  });

  test('entity-display-selection: タンパク質の表示は最初のタンパク質の敵の記録から戻す', () => {
    const silhouette: ProteinDisplaySettings = { representation: 'silhouette', colorMode: 'hydrophobicity' };
    const molecular: ProteinDisplaySettings = { representation: 'molecular', colorMode: 'element' };
    const selection = new EntityDisplaySelection([
      metalEnemy('entity-0'), proteinEnemy('entity-1', silhouette), proteinEnemy('entity-2', molecular),
    ]);

    assert.deepEqual(selection.proteinDisplay, silhouette);
  });

  test('entity-display-selection: 不正な表示や保存が無いときは既定の表示から始める', () => {
    const invalid = { representation: 'molecular', colorMode: 'chain' };

    assert.deepEqual(
      new EntityDisplaySelection([proteinEnemy('entity-0', invalid)]).proteinDisplay, DEFAULT_PROTEIN_DISPLAY,
    );
    assert.deepEqual(new EntityDisplaySelection([metalEnemy('entity-0')]).proteinDisplay, DEFAULT_PROTEIN_DISPLAY);
    assert.deepEqual(new EntityDisplaySelection(undefined).proteinDisplay, DEFAULT_PROTEIN_DISPLAY);
  });

  test('entity-display-selection: toggleTrajectoryLine は出す・消すを往復する', () => {
    const selection = new EntityDisplaySelection([metalEnemy('entity-0', true)]);

    selection.toggleTrajectoryLine('entity-1');
    assert.equal(selection.showsTrajectoryLine('entity-1'), true);
    selection.toggleTrajectoryLine('entity-1');
    assert.equal(selection.showsTrajectoryLine('entity-1'), false);
    selection.toggleTrajectoryLine('entity-0');
    assert.equal(selection.showsTrajectoryLine('entity-0'), false);
    selection.toggleTrajectoryLine('entity-0');
    assert.equal(selection.showsTrajectoryLine('entity-0'), true);
  });
}
