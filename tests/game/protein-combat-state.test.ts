import * as assert from 'node:assert/strict';
import { test } from '../harness';
import rawAsset from '../../src/assets/models/pdb5i4rProtein.json';
import rawMyoglobinAsset from '../../src/assets/models/myoglobin1mbnProtein.json';
import rawMyoglobinStructure from '../../src/assets/models/myoglobin1mbnStructure.json';
import rawMotion from '../../src/assets/models/pdb5i4rMotion.json';
import { ProteinCombatState } from '../../src/game/protein/protein-combat-state';
import type { ProteinAssetDefinition, ProteinSiteDefinition } from '../../src/game/protein/protein-schema';
import type { ProteinMotionAsset } from '../../src/game/protein/protein-schema';
import { collisionDamageFraction } from '../../src/game/dynamic/dynamic-entity/contact-damage';
import * as THREE from 'three/webgpu';
import { ProteinRuntime } from '../../src/render/protein/protein-runtime';
import { ProteinMotionController } from '../../src/render/protein/protein-motion-controller';
import { PROTEIN_ASSET_IDS, proteinAssetFor } from '../../src/game/protein/protein-asset-loader';
import { createProteinEnemyDefinition } from '../../src/game/protein/protein-enemy-registry';
import { testProteinAssetBundleFor } from '../protein-test-assets';
import { v3 } from '../../src/math/vec3';
import { proteinLocalImpactPoint } from '../../src/physics/protein-site-geometry';

const asset = rawAsset as unknown as ProteinAssetDefinition;
const motion = rawMotion as unknown as ProteinMotionAsset;
const myoglobinAsset = rawMyoglobinAsset as unknown as ProteinAssetDefinition;

/** 攻撃に使える(無効化されていない)機能部位の定義を、戦闘状態の読み取り値経由で得る。 */
function attackSitesOf(state: ProteinCombatState, definition: ProteinAssetDefinition): ProteinSiteDefinition[] {
  return state.combatReadout().sites
    .filter((site) => site.attackable && !site.disabled)
    .map((site) => definition.sites.find((entry) => entry.id === site.id)!);
}

export function register(): void {
  test('protein combat: each attack site has independent HP and disabling one preserves the others', () => {
    const state = new ProteinCombatState(asset);
    const site = asset.sites.find((entry) => entry.id === 'primary-active-site')!;
    const actionId = state.attackAction?.id;
    assert.equal(actionId, 'plasma-burst');
    assert.ok(actionId);
    assert.ok(attackSitesOf(state, asset).length >= 3);
    assert.equal(state.isActionEnabled(actionId), state.activeSite !== null);
    const readout = state.combatReadout();
    assert.equal(readout.sites.length, asset.sites.length);
    assert.equal(readout.sites.filter((entry) => entry.attackable).length, attackSitesOf(state, asset).length);
    const result = state.applyDamage(site.maxHp, {
      x: site.position[0] * asset.coordinateScale,
      y: site.position[1] * asset.coordinateScale,
      z: site.position[2] * asset.coordinateScale,
    });
    assert.equal(result.siteId, site.id);
    assert.equal(result.siteDisabled, true);
    assert.equal(state.isActionEnabled(actionId), true);
    assert.ok(!attackSitesOf(state, asset).some((entry) => entry.id === site.id));
    for (const attackSite of attackSitesOf(state, asset)) {
      state.applyDamage(attackSite.maxHp, {
        x: attackSite.position[0] * asset.coordinateScale,
        y: attackSite.position[1] * asset.coordinateScale,
        z: attackSite.position[2] * asset.coordinateScale,
      });
    }
    assert.equal(state.isActionEnabled(actionId), false);
    assert.equal(state.isActionEnabled(actionId), state.activeSite !== null);
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
    assert.equal(attackSitesOf(state, genericActionAsset).length, 3);
    assert.equal(state.isActionEnabled('ion-pulse'), true);
    assert.equal(state.isActionEnabled('plasma-burst'), false);
  });

  test('protein combat: myoglobin uses its own projectile action ID', () => {
    const state = new ProteinCombatState(myoglobinAsset);
    const actionId = state.attackAction?.id;
    assert.equal(actionId, 'heme-iron-pulse');
    assert.ok(actionId);
    assert.equal(state.isActionEnabled(actionId), true);
    assert.equal(state.isActionEnabled('plasma-burst'), false);
  });

  test('protein combat: an action-less protein cannot fire', () => {
    const state = new ProteinCombatState({ ...asset, actions: [], sites: [] });
    assert.equal(state.attackAction, null);
    assert.equal(state.activeSite, null);
    assert.equal(state.isActionEnabled('plasma-burst'), false);
  });

  test('protein assets: registered assets resolve by ID', () => {
    assert.ok(PROTEIN_ASSET_IDS.includes('pdb-5i4r'));
    assert.ok(PROTEIN_ASSET_IDS.includes('pdb-1mbn-myoglobin'));
    assert.equal(proteinAssetFor('pdb-5i4r')?.id, asset.id);
    assert.equal(proteinAssetFor('pdb-1mbn-myoglobin')?.id, myoglobinAsset.id);
    assert.equal(proteinAssetFor('missing-protein'), null);
  });

  test('protein assets: every registered enemy uses residue-bound ANM modes', () => {
    for (const id of PROTEIN_ASSET_IDS) {
      const candidate = proteinAssetFor(id)!;
      const motionAsset = testProteinAssetBundleFor(id).semantic.motion;
      assert.ok(motionAsset);
      assert.equal(motionAsset.model, 'c-alpha-anm-overdamped');
      assert.equal(motionAsset.modes.length, 24);
      assert.equal(motionAsset.bindings.siteResidues.length, candidate.sites.length);
      assert.ok(motionAsset.bindings.backboneResidues.length > 0);
      assert.ok(motionAsset.modes.some((mode) => mode.band === 'collective'));
      assert.ok(motionAsset.modes.some((mode) => mode.band === 'local'));
    }
  });

  test('protein assets: every generated catalog entry has an enemy definition', () => {
    for (const id of PROTEIN_ASSET_IDS) {
      const definition = createProteinEnemyDefinition(id, testProteinAssetBundleFor(id).semantic);
      assert.ok(definition, `missing enemy definition for ${id}`);
      assert.equal(definition.assetId, id);
      assert.equal(definition.asset, proteinAssetFor(id));
    }
  });

  test('myoglobin: heme ligand uses its iron ion as the sole attack center', () => {
    const state = new ProteinCombatState(myoglobinAsset);
    assert.equal(myoglobinAsset.ligands.length, 1);
    assert.equal(myoglobinAsset.ligands[0]?.residue, 'HEM');
    assert.equal(myoglobinAsset.ligands[0]?.metalElement, 'FE');
    assert.equal(myoglobinAsset.ligands[0]?.centerSite, 'heme-iron');
    assert.deepEqual(attackSitesOf(state, myoglobinAsset).map((site) => site.id), ['heme-iron']);
    assert.equal(state.nextAttackSite()?.id, 'heme-iron');

    const structure = rawMyoglobinStructure as unknown as {
      atoms: {
        count: number; elementTable: string[]; elements: number[]; residueTable: string[]; residues: number[]; coordinates: number[];
      };
    };
    const iron = Array.from({ length: structure.atoms.count }, (_, index) => index).find((index) => (
      structure.atoms.elementTable[structure.atoms.elements[index]!] === 'FE'
      && structure.atoms.residueTable[structure.atoms.residues[index]!] === 'HEM'
    ));
    assert.notEqual(iron, undefined);
    const site = myoglobinAsset.sites.find((entry) => entry.id === 'heme-iron')!;
    assert.deepEqual(site.position, structure.atoms.coordinates.slice(iron! * 3, iron! * 3 + 3));
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
    assert.equal(restored.serialize().modifications['phosphate-1'], 'phosphorylated');
  });

  test('protein combat: structural damage removes the visible modification state', () => {
    const state = new ProteinCombatState(asset);
    state.applyDamage(asset.integrity.maxHp * 0.4, { x: 1000, y: 1000, z: 1000 });
    assert.equal(state.serialize().modifications['phosphate-1'], 'empty');
  });

  test('protein combat: active modification raises projectile damage above base and losing it restores base', () => {
    const state = new ProteinCombatState(asset);
    const baseDamage = 10;
    assert.ok(state.projectileDamage(baseDamage) > baseDamage);
    state.setModification('phosphate-1', 'empty');
    assert.equal(state.projectileDamage(baseDamage), baseDamage);
  });

  test('protein combat: contact damage uses the shared 50-to-500 m/s ramp', () => {
    assert.equal(collisionDamageFraction(49), 0);
    assert.equal(collisionDamageFraction(50), 0);
    assert.equal(collisionDamageFraction(275), 0.5);
    assert.equal(collisionDamageFraction(500), 1);
    const state = new ProteinCombatState(asset);
    state.applyContactDamage(asset.integrity.maxHp * collisionDamageFraction(275));
    assert.equal(state.integrityHp, asset.integrity.maxHp / 2);
    assert.equal(state.serialize().modifications['phosphate-1'], 'empty');
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

  const IDENTITY_ATTITUDE = { x: 0, y: 0, z: 0, w: 1 };

  test('protein runtime: visual motion preserves the root pose and maps externally selected sites', () => {
    const root = new THREE.Group();
    root.position.set(11, -7, 3);
    const rootRollBeforeRebuild = 0.47;
    root.rotation.z = rootRollBeforeRebuild;
    root.rotation.x = -0.21;
    root.scale.setScalar(3);
    const tagged = new THREE.Group();
    tagged.userData.proteinComponent = 'A';
    tagged.position.set(1.25, -2.5, 0.75);
    tagged.rotation.set(0.12, -0.18, 0.24);
    root.add(tagged);
    const baseChildPosition = tagged.position.clone();
    const baseChildQuaternion = tagged.quaternion.clone();
    const baseRootPosition = root.position.clone();
    const baseRootQuaternion = root.quaternion.clone();
    const baseRootScale = root.scale.clone();
    const combat = new ProteinCombatState(asset);
    const runtime = new ProteinRuntime(root, asset, motion);
    const controller = new ProteinMotionController(motion, 'enemy-42');
    const syncVisual = (): void => {
      controller.sampleAt(12.5, 'near', combat.phase);
      runtime.syncVisual({
        active: true,
        lod: 'near',
        sampleTime: controller.sampleTime,
        phase: combat.phase,
        coefficients: controller.effectiveModeCoefficients,
      });
    };
    const active = asset.sites.find((entry) => entry.id === 'primary-active-site')!;
    const origin = v3(100, 200, 300);
    const activeWorld = runtime.siteWorldPositionById(
      active.id, origin, { x: 0, y: 0, z: 0, w: 1 },
    );
    assert.deepEqual(activeWorld, v3(
      origin.x + active.position[0] * asset.coordinateScale * root.scale.x,
      origin.y + active.position[1] * asset.coordinateScale * root.scale.x,
      origin.z + active.position[2] * asset.coordinateScale * root.scale.x,
    ));
    const localImpact = proteinLocalImpactPoint(
      activeWorld, origin, { x: 0, y: 0, z: 0, w: 1 }, root.scale.x,
    );
    assert.ok(Math.abs(localImpact.x - active.position[0] * asset.coordinateScale) < 1e-12);
    assert.ok(Math.abs(localImpact.y - active.position[1] * asset.coordinateScale) < 1e-12);
    assert.ok(Math.abs(localImpact.z - active.position[2] * asset.coordinateScale) < 1e-12);
    const firstAttackWorld = runtime.siteWorldPositionById(
      combat.nextAttackSite()!.id, origin, IDENTITY_ATTITUDE,
    );
    const nextWorld = runtime.siteWorldPositionById(
      combat.nextAttackSite()!.id, origin, IDENTITY_ATTITUDE,
    );
    assert.deepEqual(firstAttackWorld, activeWorld);
    assert.notDeepEqual(nextWorld, activeWorld);
    combat.applyDamage(active.maxHp, {
      x: active.position[0] * asset.coordinateScale,
      y: active.position[1] * asset.coordinateScale,
      z: active.position[2] * asset.coordinateScale,
    });
    syncVisual();
    // 変形が生きていれば、サイトのアンカーは変形前の位置から動く。
    assert.notDeepEqual(runtime.siteWorldPositionById(active.id, origin, IDENTITY_ATTITUDE), activeWorld);
    assert.deepEqual(root.position, baseRootPosition);
    assert.ok(root.quaternion.equals(baseRootQuaternion));
    assert.deepEqual(root.scale, baseRootScale);
    assert.deepEqual(tagged.position, baseChildPosition);
    assert.ok(tagged.quaternion.equals(baseChildQuaternion));

    runtime.clearVisuals();
    assert.deepEqual(tagged.position, baseChildPosition);
    assert.ok(tagged.quaternion.equals(baseChildQuaternion));
    assert.deepEqual(root.position, baseRootPosition);
    assert.ok(root.quaternion.equals(baseRootQuaternion));
    assert.deepEqual(root.scale, baseRootScale);
    runtime.rebuildVisuals();
    syncVisual();
    assert.notDeepEqual(runtime.siteWorldPositionById(active.id, origin, IDENTITY_ATTITUDE), activeWorld);
    assert.equal(root.rotation.z, rootRollBeforeRebuild);
    runtime.dispose();
  });

}
