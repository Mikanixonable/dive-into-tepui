import * as assert from 'node:assert/strict';
import { test } from './harness';
import rawAsset from '../../src/assets/models/pdb5i4rProtein.json';
import rawBackbone from '../../src/assets/models/pdb5i4rBackbone.json';
import rawStructure from '../../src/assets/models/pdb5i4rStructure.json';
import rawMyoglobinAsset from '../../src/assets/models/myoglobin1mbnProtein.json';
import rawMyoglobinBackbone from '../../src/assets/models/myoglobin1mbnBackbone.json';
import rawMyoglobinStructure from '../../src/assets/models/myoglobin1mbnStructure.json';
import { ProteinCombatState } from '../../src/game/protein/protein-combat-state';
import type { ProteinAssetDefinition } from '../../src/game/protein/protein-schema';
import { collisionDamageFraction } from '../../src/game/game-entity/contact-damage';
import * as THREE from 'three/webgpu';
import { ProteinRuntime } from '../../src/game/protein/protein-runtime';
import { PROTEIN_ASSET_IDS, proteinAssetFor } from '../../src/game/protein/protein-asset-loader';
import { proteinEnemyDefinitionFor } from '../../src/game/protein/protein-enemy-registry';
import type { ProteinDisplayAsset } from '../../src/game/protein/protein-display-asset';
import {
  buildProteinEnemyShip, buildProteinRibbonShip, type ProteinBackboneAsset, type ProteinRenderSource,
} from '../../src/render/protein-enemy-ship';
import {
  LIT_OPAQUE_LAYER, PROTEIN_SHADOW_OCCLUDER_LAYER, PROTEIN_SHADOW_RECEIVER_LAYER,
} from '../../src/render/pipeline/lit-layer';
import { v3 } from '../../src/physics/vec3';
import {
  DEFAULT_PROTEIN_DISPLAY, defaultProteinDisplayFor, isProteinDisplaySettings, proteinColorModesFor,
} from '../../src/game/protein/protein-display';

const asset = rawAsset as unknown as ProteinAssetDefinition;
const myoglobinAsset = rawMyoglobinAsset as unknown as ProteinAssetDefinition;
const sourceFor = (
  semantic: ProteinAssetDefinition,
  backbone: unknown,
  structure: unknown,
): ProteinRenderSource => ({
  semantic,
  backbone: backbone as ProteinBackboneAsset,
  structure: structure as ProteinDisplayAsset,
});

function ribbonKinds(object: THREE.Object3D): Set<string> {
  const kinds = new Set<string>();
  object.traverse((child) => {
    if (child.userData.proteinRibbon && typeof child.userData.proteinSecondary === 'string') {
      kinds.add(child.userData.proteinSecondary);
    }
  });
  return kinds;
}

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
    assert.ok(PROTEIN_ASSET_IDS.includes('pdb-1mbn-myoglobin'));
    assert.equal(proteinAssetFor('pdb-5i4r')?.id, asset.id);
    assert.equal(proteinAssetFor('pdb-1mbn-myoglobin')?.id, myoglobinAsset.id);
    assert.equal(proteinAssetFor('missing-protein'), null);
  });

  test('protein assets: every registered enemy uses component-bound Brownian modes', () => {
    for (const id of PROTEIN_ASSET_IDS) {
      const candidate = proteinAssetFor(id)!;
      const componentIds = new Set(candidate.components.map((component) => component.id));
      assert.equal(candidate.motion.model, 'overdamped-normal-modes');
      assert.ok(candidate.motion.modes.length > 0);
      for (const site of candidate.sites) assert.ok(componentIds.has(site.componentId));
      for (const mode of candidate.motion.modes) {
        assert.deepEqual(new Set(mode.components.map((component) => component.componentId)), componentIds);
      }
    }
  });

  test('protein assets: every generated catalog entry has an enemy definition', () => {
    for (const id of PROTEIN_ASSET_IDS) {
      const definition = proteinEnemyDefinitionFor(id);
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
    assert.deepEqual(state.attackSites.map((site) => site.id), ['heme-iron']);
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

  test('myoglobin: ribbon render includes the heme ligand and visible iron', () => {
    const object = buildProteinEnemyShip(sourceFor(
      myoglobinAsset, rawMyoglobinBackbone, rawMyoglobinStructure,
    ), { representation: 'ribbon', colorMode: 'chain' });
    let ligandFound = false;
    let ironFound = false;
    object.traverse((child) => {
      ligandFound ||= child.userData.proteinLigand === true;
      ironFound ||= child.userData.proteinLigand === true && child.userData.proteinElement === 'FE';
    });
    assert.equal(ligandFound, true);
    assert.equal(ironFound, true);
  });

  test('protein ribbon: shared renderer preserves each asset secondary structures', () => {
    const myoglobin = buildProteinRibbonShip(sourceFor(
      myoglobinAsset, rawMyoglobinBackbone, rawMyoglobinStructure,
    ), 'secondary-structure');
    assert.deepEqual(ribbonKinds(myoglobin), new Set(['coil', 'helix']));

    const complex = buildProteinRibbonShip(sourceFor(asset, rawBackbone, rawStructure), 'secondary-structure');
    assert.ok(ribbonKinds(complex).has('helix'));
    assert.ok(ribbonKinds(complex).has('sheet'));
    assert.ok(ribbonKinds(complex).has('coil'));
  });

  test('protein silhouette: internal ribbon is white while the ligand remains visible', () => {
    const object = buildProteinEnemyShip(sourceFor(
      myoglobinAsset, rawMyoglobinBackbone, rawMyoglobinStructure,
    ), { representation: 'silhouette', colorMode: 'surface-charge' });
    let ribbons = 0;
    let ligandFound = false;
    let shellFound = false;
    object.traverse((child) => {
      ligandFound ||= child.userData.proteinLigand === true;
      if (child.userData.proteinShadowOccluder === true) {
        shellFound = true;
        assert.equal(child.layers.isEnabled(0), true);
        assert.equal(child.layers.isEnabled(LIT_OPAQUE_LAYER), false);
        assert.equal(child.layers.isEnabled(PROTEIN_SHADOW_OCCLUDER_LAYER), true);
      }
      if (!child.userData.proteinRibbon) return;
      ribbons += 1;
      assert.equal(child.layers.isEnabled(LIT_OPAQUE_LAYER), true);
      assert.equal(child.layers.isEnabled(PROTEIN_SHADOW_RECEIVER_LAYER), true);
      const mesh = child as THREE.Mesh;
      const colors = mesh.geometry.getAttribute('color');
      assert.ok(colors, 'silhouette ribbon should expose vertex colors');
      for (let index = 0; index < colors.count; index++) {
        assert.equal(colors.getX(index), 1);
        assert.equal(colors.getY(index), 1);
        assert.equal(colors.getZ(index), 1);
      }
    });
    assert.ok(ribbons > 0);
    assert.equal(shellFound, true);
    assert.equal(ligandFound, true);
  });

  test('protein silhouette: multi-component shell follows the same component motion as its ribbon', () => {
    const object = buildProteinEnemyShip(
      sourceFor(asset, rawBackbone, rawStructure),
      { representation: 'silhouette', colorMode: 'hydrophobicity' },
    );
    const shellComponents = new Set<string>();
    object.traverse((child) => {
      if (child.userData.proteinShadowOccluder === true) {
        shellComponents.add(String(child.userData.proteinComponent));
      }
    });
    assert.deepEqual(shellComponents, new Set(asset.components.flatMap((component) => component.chains)));
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
    root.position.set(11, -7, 3);
    root.rotation.z = 0.47;
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
    runtime.updateVisual(12.5);
    const firstDisplacement = tagged.position.clone().sub(baseChildPosition);
    assert.ok(firstDisplacement.length() > 1e-9);
    assert.deepEqual(root.position, baseRootPosition);
    assert.ok(root.quaternion.equals(baseRootQuaternion));
    assert.deepEqual(root.scale, baseRootScale);
    assert.ok(tagged.quaternion.equals(baseChildQuaternion));
    const marker = root.children.find((child) => child.userData.proteinSiteId === 'complex-interface');
    assert.ok(marker);
    const firstMarkerPosition = marker.position.clone();
    runtime.updateVisual(100);
    assert.ok(marker.position.distanceTo(firstMarkerPosition) > 1e-9);

    runtime.clearVisuals();
    assert.deepEqual(tagged.position, baseChildPosition);
    assert.ok(tagged.quaternion.equals(baseChildQuaternion));
    assert.deepEqual(root.position, baseRootPosition);
    assert.ok(root.quaternion.equals(baseRootQuaternion));
    assert.deepEqual(root.scale, baseRootScale);
    runtime.rebuildVisuals();
    runtime.updateVisual(12.5);
    assert.ok(tagged.position.clone().sub(baseChildPosition).distanceTo(firstDisplacement) < 1e-12);
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
