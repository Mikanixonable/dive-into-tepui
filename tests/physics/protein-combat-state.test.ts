import * as assert from 'node:assert/strict';
import { test } from './harness';
import rawAsset from '../../src/assets/models/pdb5i4rProtein.json';
import { ProteinCombatState } from '../../src/game/protein/protein-combat-state';
import type { ProteinAssetDefinition } from '../../src/game/protein/protein-schema';
import { proteinMotionAt, proteinMotionSeedFor } from '../../src/game/protein/protein-motion';
import { collisionDamageFraction } from '../../src/game/game-entity/contact-damage';
import * as THREE from 'three/webgpu';
import { ProteinRuntime } from '../../src/game/protein/protein-runtime';
import { PROTEIN_ASSET_IDS, proteinAssetFor } from '../../src/game/protein/protein-asset-loader';
import { v3 } from '../../src/physics/vec3';
import {
  DEFAULT_PROTEIN_DISPLAY, defaultProteinDisplayFor, isProteinDisplaySettings, proteinColorModesFor,
} from '../../src/game/protein/protein-display';

const asset = rawAsset as unknown as ProteinAssetDefinition;

export function register(): void {
  test('protein combat: each attack site has independent HP and disabling one preserves the others', () => {
    const state = new ProteinCombatState(asset);
    const site = asset.sites.find((entry) => entry.id === 'primary-active-site')!;
    assert.ok(state.attackSites.length >= 3);
    const snapshot = state.hudSnapshot();
    assert.equal(snapshot.sites.length, asset.sites.length);
    assert.equal(snapshot.sites.filter((entry) => entry.attackable).length, state.attackSites.length);
    const result = state.applyDamage(site.maxHp, {
      x: site.position[0] * asset.coordinateScale,
      y: site.position[1] * asset.coordinateScale,
      z: site.position[2] * asset.coordinateScale,
    });
    assert.equal(result.siteId, site.id);
    assert.equal(result.siteDisabled, true);
    assert.equal(state.isActionEnabled('plasma-burst'), true);
    assert.ok(!state.attackSites.some((entry) => entry.id === site.id));
    for (const attackSite of [...state.attackSites]) {
      state.applyDamage(attackSite.maxHp, {
        x: attackSite.position[0] * asset.coordinateScale,
        y: attackSite.position[1] * asset.coordinateScale,
        z: attackSite.position[2] * asset.coordinateScale,
      });
    }
    assert.equal(state.isActionEnabled('plasma-burst'), false);
  });

  test('protein combat: attack sites follow the asset action definition', () => {
    const genericActionAsset: ProteinAssetDefinition = {
      ...asset,
      actions: [{ id: 'ion-pulse', kind: 'projectile' }],
      sites: asset.sites.map((site) => ({
        ...site,
        actions: site.actions.map(() => 'ion-pulse'),
      })),
    };
    const state = new ProteinCombatState(genericActionAsset);
    assert.equal(state.attackSites.length, 3);
    assert.equal(state.isActionEnabled('ion-pulse'), true);
    assert.equal(state.isActionEnabled('plasma-burst'), false);
  });

  test('protein assets: registered assets resolve by ID', () => {
    assert.ok(PROTEIN_ASSET_IDS.includes('pdb-5i4r'));
    assert.equal(proteinAssetFor('pdb-5i4r')?.id, asset.id);
    assert.equal(proteinAssetFor('missing-protein'), null);
  });

  test('protein combat: interface and core damage move through phases', () => {
    const state = new ProteinCombatState(asset);
    const iface = asset.sites.find((entry) => entry.id === 'complex-interface')!;
    const core = asset.sites.find((entry) => entry.id === 'structural-core')!;
    const hit = (site: typeof iface): void => {
      state.applyDamage(site.maxHp, {
        x: site.position[0] * asset.coordinateScale,
        y: site.position[1] * asset.coordinateScale,
        z: site.position[2] * asset.coordinateScale,
      });
    };
    hit(iface);
    assert.equal(state.phase, 'exposed');
    // The core is a separate target, so the second functional hit reaches critical.
    hit(core);
    assert.equal(state.phase, 'critical');
  });

  test('protein combat: disabling the active site after the interface dissociates the complex', () => {
    const state = new ProteinCombatState(asset);
    const hit = (id: string): void => {
      const site = asset.sites.find((entry) => entry.id === id)!;
      state.applyDamage(site.maxHp, {
        x: site.position[0] * asset.coordinateScale,
        y: site.position[1] * asset.coordinateScale,
        z: site.position[2] * asset.coordinateScale,
      });
    };
    hit('complex-interface');
    for (const site of asset.sites.filter((entry) => entry.actions.includes('plasma-burst'))) hit(site.id);
    assert.equal(state.phase, 'dissociated');
  });

  test('protein combat: save round-trip preserves sites and modification', () => {
    const state = new ProteinCombatState(asset);
    const serialized = state.serialize();
    const restored = new ProteinCombatState(asset, serialized);
    assert.deepEqual(restored.serialize(), serialized);
    assert.equal(restored.modificationState('phosphate-1'), 'phosphorylated');
  });

  test('protein combat: structural damage removes the visible modification state', () => {
    const state = new ProteinCombatState(asset);
    state.applyDamage(asset.integrity.maxHp * 0.4, { x: 1000, y: 1000, z: 1000 });
    assert.equal(state.modificationState('phosphate-1'), 'empty');
  });

  test('protein combat: new and legacy-restored integrity starts at the authoritative 320 HP', () => {
    assert.equal(new ProteinCombatState(asset).integrityHp, asset.integrity.maxHp);
    assert.equal(new ProteinCombatState(asset, undefined, 6).integrityHp, asset.integrity.maxHp);
    assert.equal(new ProteinCombatState(asset, undefined, 3).integrityHp, asset.integrity.maxHp / 2);
  });

  test('protein combat: active modification scales protein projectile damage and clears cleanly', () => {
    const state = new ProteinCombatState(asset);
    assert.equal(state.projectileDamage(10), 11);
    state.setModification('phosphate-1', 'empty');
    assert.equal(state.projectileDamage(10), 10);
  });

  test('protein combat: contact damage uses the shared 50-to-500 m/s ramp', () => {
    assert.equal(collisionDamageFraction(49), 0);
    assert.equal(collisionDamageFraction(50), 0);
    assert.equal(collisionDamageFraction(275), 0.5);
    assert.equal(collisionDamageFraction(500), 1);
    const state = new ProteinCombatState(asset);
    state.applyContactDamage(asset.integrity.maxHp * collisionDamageFraction(275));
    assert.equal(state.integrityHp, asset.integrity.maxHp / 2);
    assert.equal(state.modificationState('phosphate-1'), 'empty');
  });

  test('protein motion: seed is stable for the same enemy id and differs for another id', () => {
    assert.equal(proteinMotionSeedFor('enemy-42'), proteinMotionSeedFor('enemy-42'));
    assert.notEqual(proteinMotionSeedFor('enemy-42'), proteinMotionSeedFor('enemy-43'));
    assert.deepEqual(
      proteinMotionAt(12, asset.motion, proteinMotionSeedFor('enemy-42')),
      proteinMotionAt(12, asset.motion, proteinMotionSeedFor('enemy-42')),
    );
  });

  test('protein asset: component chains follow the RCSB entity mapping', () => {
    const byEntity = new Map(asset.components.flatMap((component) => component.entities.map((entity) => [entity, component] as const)));
    assert.deepEqual(byEntity.get(1)?.chains, ['A', 'E']);
    assert.deepEqual(byEntity.get(2)?.chains, ['C', 'G']);
    assert.deepEqual(byEntity.get(3)?.chains, ['D', 'H']);
    assert.deepEqual(byEntity.get(4)?.chains, ['B', 'F']);
    assert.equal(byEntity.get(1)?.source, 'author');
    assert.equal(byEntity.get(2)?.source, 'author');
    assert.equal(byEntity.get(3)?.source, 'author');
    assert.equal(byEntity.get(4)?.source, 'author');
  });

  test('protein runtime: visual motion preserves the physics root pose and cycles attack origins', () => {
    const root = new THREE.Group();
    root.rotation.z = 0.47;
    root.scale.setScalar(3);
    const runtime = new ProteinRuntime(root, asset, undefined, undefined, 'enemy-42');
    const active = asset.sites.find((entry) => entry.id === 'primary-active-site')!;
    const origin = v3(100, 200, 300);
    const activeWorld = runtime.activeSiteWorldPosition(origin, { x: 0, y: 0, z: 0, w: 1 });
    assert.deepEqual(activeWorld, v3(
      origin.x + active.position[0] * asset.coordinateScale * root.scale.x,
      origin.y + active.position[1] * asset.coordinateScale * root.scale.x,
      origin.z + active.position[2] * asset.coordinateScale * root.scale.x,
    ));
    const localImpact = runtime.localImpactPoint(activeWorld, origin, { x: 0, y: 0, z: 0, w: 1 });
    assert.ok(Math.abs(localImpact.x - active.position[0] * asset.coordinateScale) < 1e-12);
    assert.ok(Math.abs(localImpact.y - active.position[1] * asset.coordinateScale) < 1e-12);
    assert.ok(Math.abs(localImpact.z - active.position[2] * asset.coordinateScale) < 1e-12);
    const firstAttackWorld = runtime.nextAttackSiteWorldPosition(origin, { x: 0, y: 0, z: 0, w: 1 });
    const nextWorld = runtime.nextAttackSiteWorldPosition(origin, { x: 0, y: 0, z: 0, w: 1 });
    assert.deepEqual(firstAttackWorld, activeWorld);
    assert.notDeepEqual(nextWorld, activeWorld);
    runtime.combat.applyDamage(active.maxHp, {
      x: active.position[0] * asset.coordinateScale,
      y: active.position[1] * asset.coordinateScale,
      z: active.position[2] * asset.coordinateScale,
    });
    runtime.updateVisual(1);
    assert.equal(root.rotation.z, 0.47);
    runtime.dispose();
  });

  test('protein display: each representation exposes only compatible color modes', () => {
    assert.deepEqual(proteinColorModesFor('molecular'), ['element']);
    assert.deepEqual(proteinColorModesFor('silhouette'), ['surface-charge', 'hydrophobicity']);
    assert.ok(proteinColorModesFor('ribbon').includes('rainbow'));
    assert.ok(isProteinDisplaySettings(DEFAULT_PROTEIN_DISPLAY));
    assert.ok(isProteinDisplaySettings(defaultProteinDisplayFor('molecular')));
    assert.ok(!isProteinDisplaySettings({ representation: 'molecular', colorMode: 'chain' }));
  });
}
