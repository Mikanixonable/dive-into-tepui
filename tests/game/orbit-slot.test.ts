// 軌道標識の台帳・直列化・「この軌道から」記述の組み立ての回帰テスト。
import assert from 'node:assert/strict';
import { test } from '../harness';
import { solarSystemParts } from '../physics/test-helpers';
import { OrbitSlotRegistry } from '../../src/game/navigation/orbit-slot-registry';
import {
  orbitSlotFromCatalogMember, orbitSlotFromContactElements, orbitSlotFromHalo,
  orbitSlotFromLissajous,
} from '../../src/game/navigation/orbit-slot-source';
import {
  orbitalElementsOf, stateFromOrbitalElements, trueAnomalyFromMean,
} from '../../src/physics/elements';
import { addPrimaryRelative, kinematicState } from '../../src/physics/kinematic-state';
import { sub, len } from '../../src/math/vec3';
import { R_EARTH } from '../../src/game/celestial/solar-system/earth-system';

const SYSTEM = solarSystemParts().system;

// 登録した軌道標識の素の記述。
const LEO_ORBIT = {
  kind: 'elements' as const,
  bodyId: 'earth',
  epoch: 0,
  a: R_EARTH + 400e3,
  e: 0.001,
  i: 0.9,
  raan: 0.3,
  argPeriapsis: 0.7,
  meanAnomaly0: 1.2,
};

export function register(): void {
  test('orbit-slot registry: 追加した標識を id で引け、列挙は追加順になる', () => {
    const registry = OrbitSlotRegistry.create();
    const a = registry.add(LEO_ORBIT);
    const b = registry.add(LEO_ORBIT, 'テスト標識');
    assert.deepEqual(registry.all(), [a, b]);
    assert.equal(registry.find(a.id), a);
    assert.equal(registry.find('missing'), null);
  });

  test('orbit-slot registry: 名前の空欄は既定名「軌道標識 N」を連番で付ける', () => {
    const registry = OrbitSlotRegistry.create();
    assert.equal(registry.add(LEO_ORBIT).name, '軌道標識 1');
    assert.equal(registry.add(LEO_ORBIT, '  ').name, '軌道標識 2');
    assert.equal(registry.add(LEO_ORBIT, '標識A').name, '標識A');
  });

  test('orbit-slot registry: 削除と改名。空欄への改名は変えない', () => {
    const registry = OrbitSlotRegistry.create();
    const slot = registry.add(LEO_ORBIT);
    registry.rename(slot.id, 'LEO 400');
    assert.equal(slot.name, 'LEO 400');
    registry.rename(slot.id, '');
    assert.equal(slot.name, 'LEO 400');
    registry.rename('missing', 'x');
    assert.equal(registry.remove(slot.id), true);
    assert.equal(registry.remove(slot.id), false);
    assert.equal(registry.all().length, 0);
  });

  test('orbit-slot registry: 直列化して復元しても標識・採番・既定名の連番が続く', () => {
    const registry = OrbitSlotRegistry.create();
    registry.add(LEO_ORBIT);
    registry.add(LEO_ORBIT, '標識B');
    const restored = OrbitSlotRegistry.deserialize(registry.serialize());
    assert.deepEqual(
      restored.all().map((slot) => slot.serialize()),
      registry.all().map((slot) => slot.serialize()),
    );
    // 復元後の発番・既定名は既存と衝突せず続きから進む。
    const added = restored.add(LEO_ORBIT);
    assert.equal(added.name, '軌道標識 3');
    assert.equal(restored.find(added.id), added);
    assert.notEqual(added.id, registry.all()[0]!.id);
  });

  test('orbit-slot registry: 記録が無い(null)なら空の台帳として復元する', () => {
    const restored = OrbitSlotRegistry.deserialize(null);
    assert.equal(restored.all().length, 0);
  });

  test('orbit-slot source: 接触軌道要素から組んだ標識の位相点は、元の状態を元期に再現する', () => {
    const earth = SYSTEM.motionOf('earth');
    const t = 12345;
    const a = R_EARTH + 400e3;
    const e = 0.1;
    const inc = 0.5;
    const raan = 0.3;
    const argp = 0.7;
    const nu = 1.2;
    const rel = stateFromOrbitalElements(t, a, e, inc, raan, argp, nu, earth.def.mu);
    const state = addPrimaryRelative(earth.stateAt(t), kinematicState<'primaryRel'>(rel.t, rel.r, rel.v));
    const elements = orbitalElementsOf(state, earth, t);
    assert.ok(elements !== null);
    const orbit = orbitSlotFromContactElements(elements);
    assert.ok(orbit !== null && orbit.kind === 'elements');
    assert.equal(orbit.bodyId, 'earth');
    assert.equal(orbit.epoch, t);
    // 記述から位相点の元期の相対状態を組み直すと、写した対象の相対状態と一致する。
    const back = stateFromOrbitalElements(
      orbit.epoch, orbit.a, orbit.e, orbit.i, orbit.raan, orbit.argPeriapsis,
      trueAnomalyFromMean(orbit.meanAnomaly0, orbit.e), earth.def.mu,
    );
    assert.ok(len(sub(back.r, rel.r)) < 1e-3 * a);
    assert.ok(len(sub(back.v, rel.v)) < 1e-3 * len(rel.v));
  });

  test('orbit-slot source: 位相の基準を持たない要素では標識を組まない', () => {
    const earth = SYSTEM.motionOf('earth');
    const el = orbitalElementsOf(
      addPrimaryRelative(
        earth.stateAt(0),
        kinematicState<'primaryRel'>(
          0,
          stateFromOrbitalElements(0, R_EARTH + 400e3, 0, 0, 0, 0, 0, earth.def.mu).r,
          stateFromOrbitalElements(0, R_EARTH + 400e3, 0, 0, 0, 0, 0, earth.def.mu).v,
        ),
      ),
      earth, 0,
    );
    assert.ok(el !== null);
    assert.ok(orbitSlotFromContactElements(el) !== null);
  });

  test('orbit-slot source: 族メンバーとハロー/リサジューの記述を組む', () => {
    const catalog = orbitSlotFromCatalogMember('earth', 'moon', 'halo-L2-S', 0.4, 0.25);
    assert.deepEqual(catalog, {
      kind: 'family', primaryId: 'earth', secondaryId: 'moon',
      familyDescriptor: { kind: 'catalog', familyId: 'halo-L2-S', s: 0.4 }, phase0: 0.25,
    });
    const halo = orbitSlotFromHalo('earth', 'moon', 'L1', 5000e3);
    assert.deepEqual(halo.familyDescriptor, { kind: 'halo', point: 'L1', az: 5000e3 });
    const lissajous = orbitSlotFromLissajous('earth', 'moon', 'L2', 8000e3, 5000e3, 0.6);
    assert.deepEqual(lissajous.familyDescriptor, {
      kind: 'lissajous', point: 'L2', ax: 8000e3, az: 5000e3, psi: 0.6,
    });
  });
}
