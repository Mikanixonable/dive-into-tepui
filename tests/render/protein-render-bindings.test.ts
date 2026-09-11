import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import rawAsset from '../../src/assets/models/pdb5i4rProtein.json';
import rawBackbone from '../../src/assets/models/pdb5i4rBackbone.json';
import rawStructure from '../../src/assets/models/pdb5i4rStructure.json';
import rawMyoglobinAsset from '../../src/assets/models/myoglobin1mbnProtein.json';
import rawMyoglobinBackbone from '../../src/assets/models/myoglobin1mbnBackbone.json';
import rawMyoglobinStructure from '../../src/assets/models/myoglobin1mbnStructure.json';
import rawMotion from '../../src/assets/models/pdb5i4rMotion.json';
import type { ProteinAssetDefinition, ProteinMotionAsset } from '../../src/game/protein/protein-schema';
import type { ProteinBackboneAsset, ProteinRenderSource } from '../../src/render/protein/protein-render-definition';
import type { ProteinDisplayAsset } from '../../src/render/protein/protein-display-asset';
import { buildProteinEnemyShip, buildProteinRibbonShip } from '../../src/render/protein/protein-enemy-ship';
import { proteinMotionModeDisplacements } from '../../src/render/protein/protein-motion-modes';
import { proteinSecondaryKind } from '../../src/render/protein/protein-ribbon-color';
import { LIT_OPAQUE_LAYER, SHADOW_CASTER_LAYER } from '../../src/render/pipeline/lit-layer';
import {
  DEFAULT_PROTEIN_DISPLAY, defaultProteinDisplayFor, isProteinDisplaySettings, PROTEIN_COLOR_LABELS,
  proteinColorModesFor,
} from '../../src/render/protein/protein-display';
import { testProteinAssetBundles } from '../protein-test-assets';
import {
  PROTEIN_RESIDUE_A_ATTRIBUTE,
  PROTEIN_RESIDUE_B_ATTRIBUTE,
  PROTEIN_RESIDUE_T_ATTRIBUTE,
  createProteinMotionBinding,
  disposeProteinMotionBinding,
  registerProteinMotionRenderer,
  type ProteinMotionBinding,
} from '../../src/render/protein/protein-motion-material';

const TEST_MODE_COUNT = 2;

/** 借りられることを前提にした binding。スロットの枯渇そのものを見るテストでは使わない。 */
function acquireBinding(residueCount: number, modeCount = TEST_MODE_COUNT): ProteinMotionBinding {
  const binding = createProteinMotionBinding(residueCount, testModeDisplacements(residueCount, modeCount), modeCount);
  assert.ok(binding, 'protein motion slots must be available');
  return binding;
}

/** A throwaway ANM basis sized for a given residue count, used only to satisfy binding construction. */
function testModeDisplacements(residueCount: number, modeCount = TEST_MODE_COUNT): Float32Array {
  return new Float32Array(modeCount * residueCount * 4).map((_, index) => index + 1);
}

const semantic = {
  schemaVersion: 1,
  id: 'render-test',
  displayName: 'レンダーテスト',
  source: { pdbId: 'TEST', structureFile: 'test' },
  coordinateScale: 1,
  integrity: { maxHp: 1 },
  actions: [],
  bonds: [],
  ligands: [],
  components: [{ id: 'component-a', chains: ['A'], entities: [1], role: 'core', source: 'computed' }],
  sites: [],
  modificationSlots: [],
} as ProteinAssetDefinition;

const motion = {
  residueCount: 3,
  bindings: {
    atomResidues: [0, 0, 1, 1, 2, 2],
    backboneResidues: [0, 1, 2],
    surfaceResidues: [0, 1, 2],
    ribbonResidues: [0, 1, 2],
    siteResidues: [],
    modificationResidues: [],
  },
} as unknown as ProteinMotionAsset;

const source: ProteinRenderSource = {
  semantic,
  motion,
  backbone: {
    backboneCount: 3,
    backboneCoordinates: [0, 0, 0, 3, 0, 0, 6, 0, 0],
    backboneSecondary: ['coil', 'coil', 'coil'],
    backboneChains: ['A', 'A', 'A'],
    backboneEntities: [1, 1, 1],
    backboneBFactors: [10, 11, 12],
  },
  structure: {
    schemaVersion: 1,
    pdbId: 'TEST',
    atoms: {
      count: 6,
      elementTable: ['C'],
      elements: [0, 0, 0, 0, 0, 0],
      coordinates: [0, 0, 0, 0.5, 0, 0, 3, 0, 0, 3.5, 0, 0, 6, 0, 0, 6.5, 0, 0],
      radiusTable: [1.7],
      radiusCodes: [0, 0, 0, 0, 0, 0],
      chainTable: ['A'],
      chains: [0, 0, 0, 0, 0, 0],
      entities: [1, 1, 1, 1, 1, 1],
      bFactors: [10, 10, 11, 11, 12, 12],
      residueTable: ['ALA'],
      residues: [0, 0, 0, 0, 0, 0],
      residueNumbers: [1, 1, 2, 2, 3, 3],
    },
    coordinateFrame: { centeredAt: [0, 0, 0] },
    bonds: { pairs: [0, 1, 1, 2, 2, 3, 3, 4, 4, 5] },
    surface: {
      mesh: {
        position: [0, 0, 0, 3, 0, 0, 6, 0, 0],
        index: [0, 1, 2],
        charge: [0, 0, 0],
        hydrophobicity: [0, 0, 0],
        component: ['A', 'A', 'A'],
      },
    },
    ribbon: {
      mesh: {
        position: [0, 0, 0, 3, 0, 0, 6, 0, 0],
        index: [0, 1, 2],
        chain: ['A', 'A', 'A'],
      },
    },
    generator: { name: 'test' },
  },
};

const asset = rawAsset as unknown as ProteinAssetDefinition;
const myoglobinAsset = rawMyoglobinAsset as unknown as ProteinAssetDefinition;

/** 焼き込み済みの JSON をそのまま束ねて、1体ぶんの描画 source にする。 */
const sourceFor = (
  definition: ProteinAssetDefinition,
  backbone: unknown,
  structure: unknown,
  motionAsset: ProteinMotionAsset = rawMotion as unknown as ProteinMotionAsset,
): ProteinRenderSource => ({
  semantic: definition,
  motion: motionAsset,
  backbone: backbone as ProteinBackboneAsset,
  structure: structure as ProteinDisplayAsset,
});

/** 主鎖に含まれる二次構造の種類を返す。 */
function ribbonKinds(renderSource: ProteinRenderSource): Set<string> {
  return new Set(renderSource.backbone.backboneSecondary.map(proteinSecondaryKind));
}

function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const renderable = object as THREE.Mesh;
    if (renderable.geometry) renderable.geometry.dispose();
    const material = renderable.material;
    if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
    else if (material) material.dispose();
  });
}

function assertBindingGeometry(geometry: THREE.BufferGeometry, expectedCount?: number): void {
  const position = geometry.getAttribute('position');
  assert.ok(position, 'render geometry must have a position attribute');
  const count = expectedCount ?? position.count;
  for (const name of [PROTEIN_RESIDUE_A_ATTRIBUTE, PROTEIN_RESIDUE_B_ATTRIBUTE, PROTEIN_RESIDUE_T_ATTRIBUTE]) {
    assert.equal(geometry.getAttribute(name)?.count, count, `${name} count`);
  }
}

export function register(): void {
  test('protein render: coordinateScale is isolated below the game-owned root', () => {
    const scaledSource = { ...source, semantic: { ...semantic, coordinateScale: 0.25 } };
    const root = buildProteinEnemyShip(scaledSource, { representation: 'molecular', colorMode: 'element' });
    assert.equal(root.scale.x, 1);
    assert.equal(root.children[0]?.scale.x, 0.25);
    root.scale.setScalar(20);
    root.updateMatrixWorld(true);
    const structure = root.children[0]!;
    const local = new THREE.Vector3(6, 0, 0).applyMatrix4(structure.matrixWorld);
    assert.equal(local.x, 30, 'Å coordinate must receive coordinateScale and enemy scale exactly once');
    disposeObject(root);
  });

  test('protein render: rejects mismatched bindings and accepts both catalog assets', () => {
    const bad = acquireBinding(2);
    assert.throws(() => buildProteinEnemyShip(source, { representation: 'molecular', colorMode: 'element' }, bad), /residueCount/);
    disposeProteinMotionBinding(bad);
    for (const bundle of testProteinAssetBundles()) {
      const renderSource = bundle.render;
      const modeDisplacements = proteinMotionModeDisplacements(renderSource.motion);
      const binding = createProteinMotionBinding(
        renderSource.motion.residueCount, modeDisplacements, renderSource.motion.modes.length,
      );
      assert.ok(binding);
      const root = buildProteinEnemyShip(renderSource, { representation: 'ribbon', colorMode: 'chain' }, binding);
      assert.equal(root.children[0]?.scale.x, renderSource.semantic.coordinateScale);
      disposeObject(root);
      disposeProteinMotionBinding(binding);
    }
  });
  test('protein render: all representations expose residue bindings and shared position nodes', () => {
    const binding = acquireBinding(3);
    const displays = [
      { representation: 'molecular', colorMode: 'element' },
      { representation: 'ribbon', colorMode: 'chain' },
      { representation: 'silhouette', colorMode: 'surface-charge' },
    ] as const;

    for (const display of displays) {
      const root = buildProteinEnemyShip(source, display, binding);
      let renderableCount = 0;
      root.traverse((object) => {
        const renderable = object as THREE.Mesh & { isInstancedMesh?: boolean; count?: number };
        if (!renderable.geometry || !renderable.material) return;
        renderableCount += 1;
        assertBindingGeometry(
          renderable.geometry,
          renderable.isInstancedMesh === true ? renderable.count : undefined,
        );
        const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
        for (const material of materials) {
          if ('positionNode' in material) {
            assert.ok(material.positionNode, 'motion-enabled material must define positionNode');
            assert.strictEqual(material.userData.proteinMotionBinding, binding);
          }
        }
      });
      assert.ok(renderableCount > 0, `${display.representation} should build renderables`);
      disposeObject(root);
    }
  });

  test('protein motion slots: bodies take disjoint spans and give them back', () => {
    const first = acquireBinding(3);
    const second = acquireBinding(5);
    const overlaps = (a: ProteinMotionBinding, b: ProteinMotionBinding): boolean =>
      a.residueBase.value < b.residueBase.value + b.residueCount
      && b.residueBase.value < a.residueBase.value + a.residueCount;
    assert.equal(overlaps(first, second), false, 'two bodies must not share residue slots');
    assert.notEqual(first.modeBase.value, second.modeBase.value);
    const firstBase = first.residueBase.value;
    disposeProteinMotionBinding(first);
    const reused = acquireBinding(3);
    assert.equal(reused.residueBase.value, firstBase, 'a returned span must be handed out again');
    disposeProteinMotionBinding(reused);
    disposeProteinMotionBinding(second);
  });

  test('protein motion slots: a body that does not fit gets no binding, and leaks nothing', () => {
    const probe = acquireBinding(3);
    const base = probe.residueBase.value;
    disposeProteinMotionBinding(probe);
    // 空きが尽きるまで借り続ける。尽きた時点で null が返り、そこまでの確保は生きている。
    const taken: ProteinMotionBinding[] = [];
    for (;;) {
      const binding = createProteinMotionBinding(1, testModeDisplacements(1, 1), 1);
      if (binding === null) break;
      taken.push(binding);
    }
    assert.ok(taken.length > 0);
    for (const binding of taken) disposeProteinMotionBinding(binding);
    // 全部返したあとは、最初と同じ区間からまた借りられる。
    const again = acquireBinding(3);
    assert.equal(again.residueBase.value, base);
    disposeProteinMotionBinding(again);
  });

  test('protein render: binding disposal releases the shared mode basis once', () => {
    const binding = acquireBinding(3);
    const ownedAttributes = new Set<THREE.StorageBufferAttribute>([binding.modeDisplacements.attribute]);
    let deleteCount = 0;
    const renderer = {
      _attributes: {
        has: (attribute: THREE.StorageBufferAttribute) => ownedAttributes.has(attribute),
        delete: (attribute: THREE.StorageBufferAttribute) => {
          deleteCount += 1;
          ownedAttributes.delete(attribute);
        },
      },
    } as unknown as THREE.WebGPURenderer;
    const unregister = registerProteinMotionRenderer(renderer);

    disposeProteinMotionBinding(binding);
    disposeProteinMotionBinding(binding);
    assert.equal(deleteCount, 1);
    assert.equal(binding.modeDisplacements.attribute.array.length, 0);
    unregister();
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
    const myoglobinSource = sourceFor(myoglobinAsset, rawMyoglobinBackbone, rawMyoglobinStructure);
    buildProteinRibbonShip(myoglobinSource, 'secondary-structure');
    assert.deepEqual(ribbonKinds(myoglobinSource), new Set(['coil', 'helix']));

    const complexSource = sourceFor(asset, rawBackbone, rawStructure);
    buildProteinRibbonShip(complexSource, 'secondary-structure');
    assert.ok(ribbonKinds(complexSource).has('helix'));
    assert.ok(ribbonKinds(complexSource).has('sheet'));
    assert.ok(ribbonKinds(complexSource).has('coil'));
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
      if (child.userData.proteinTranslucentShell === true) {
        shellFound = true;
        assert.equal(child.layers.isEnabled(0), true);
        assert.equal(child.layers.isEnabled(LIT_OPAQUE_LAYER), false);
        assert.equal(child.layers.isEnabled(SHADOW_CASTER_LAYER), false);
      }
      if (!child.userData.proteinRibbon) return;
      ribbons += 1;
      assert.equal(child.layers.isEnabled(LIT_OPAQUE_LAYER), true);
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
      if (child.userData.proteinTranslucentShell === true) {
        shellComponents.add(String(child.userData.proteinComponent));
      }
    });
    assert.deepEqual(shellComponents, new Set(asset.components.flatMap((component) => component.chains)));
  });

  test('protein display: each representation exposes only compatible color modes', () => {
    assert.deepEqual(proteinColorModesFor('molecular'), ['element']);
    assert.deepEqual(proteinColorModesFor('silhouette'), ['surface-charge', 'hydrophobicity']);
    assert.deepEqual(proteinColorModesFor('ribbon'), [
      'chain', 'b-factor', 'rainbow', 'secondary-structure', 'component',
    ]);
    assert.equal(PROTEIN_COLOR_LABELS.chain, 'Chain');
    assert.equal(PROTEIN_COLOR_LABELS.component, 'Component');
    assert.ok(isProteinDisplaySettings(DEFAULT_PROTEIN_DISPLAY));
    assert.deepEqual(DEFAULT_PROTEIN_DISPLAY, { representation: 'ribbon', colorMode: 'chain' });
    assert.ok(isProteinDisplaySettings(defaultProteinDisplayFor('molecular')));
    assert.deepEqual(defaultProteinDisplayFor('ribbon'), { representation: 'ribbon', colorMode: 'chain' });
    assert.ok(!isProteinDisplaySettings({ representation: 'molecular', colorMode: 'chain' }));
  });

}
