import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { runAll, test } from './harness';
import type { ProteinAssetDefinition, ProteinMotionAsset } from '../../src/game/protein/protein-schema';
import type { ProteinRenderSource } from '../../src/render/protein-enemy-ship';
import { buildProteinEnemyShip } from '../../src/render/protein-enemy-ship';
import { PROTEIN_ASSET_BUNDLES } from '../../src/game/protein/protein-asset-catalog.generated';
import { proteinMotionModeDisplacements } from '../../src/game/protein/protein-motion-modes';
import {
  PROTEIN_RESIDUE_A_ATTRIBUTE,
  PROTEIN_RESIDUE_B_ATTRIBUTE,
  PROTEIN_RESIDUE_T_ATTRIBUTE,
  createProteinMotionBinding,
  disposeProteinMotionBinding,
  installProteinMotionOverridePropagation,
  registerProteinMotionRenderer,
  updateProteinMotionCoefficients,
} from '../../src/render/protein-motion-material';

const TEST_MODE_COUNT = 2;

/** A throwaway ANM basis sized for a given residue count, used only to satisfy binding construction. */
function testModeDisplacements(residueCount: number, modeCount = TEST_MODE_COUNT): Float32Array {
  return new Float32Array(modeCount * residueCount * 4).map((_, index) => index + 1);
}

const semantic = {
  schemaVersion: 1,
  id: 'render-test',
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
    generator: { name: 'test' },
  },
};

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
    const bad = createProteinMotionBinding(2, testModeDisplacements(2), TEST_MODE_COUNT);
    assert.throws(() => buildProteinEnemyShip(source, { representation: 'molecular', colorMode: 'element' }, bad), /residueCount/);
    disposeProteinMotionBinding(bad);
    for (const bundle of Object.values(PROTEIN_ASSET_BUNDLES)) {
      const modeDisplacements = proteinMotionModeDisplacements(bundle.motion);
      const binding = createProteinMotionBinding(bundle.motion.residueCount, modeDisplacements, bundle.motion.modes.length);
      const root = buildProteinEnemyShip(bundle, { representation: 'ribbon', colorMode: 'chain' }, binding);
      assert.equal(root.children[0]?.scale.x, bundle.semantic.coordinateScale);
      disposeObject(root);
      disposeProteinMotionBinding(binding);
    }
  });
  test('protein render: all representations expose residue bindings and shared position nodes', () => {
    const binding = createProteinMotionBinding(3, testModeDisplacements(3), TEST_MODE_COUNT);
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

  test('protein render: coefficient updates reuse one shared storage array', () => {
    const binding = createProteinMotionBinding(3, testModeDisplacements(3), TEST_MODE_COUNT);
    const root = buildProteinEnemyShip(source, { representation: 'molecular', colorMode: 'element' }, binding);
    const atom = root.getObjectByProperty('isInstancedMesh', true) as THREE.InstancedMesh;
    const before = binding.coefficients.array;
    updateProteinMotionCoefficients(binding, [1, 2]);
    assert.strictEqual(binding.coefficients.array, before);
    assert.equal((before as Float32Array)[0], 1);
    assert.equal((before as Float32Array)[1], 2);
    assert.equal(atom.geometry.userData.proteinResidueBinding, true);
    disposeObject(root);
  });

  test('protein render: binding disposal releases each registered renderer storage buffer once', () => {
    const binding = createProteinMotionBinding(3, testModeDisplacements(3), TEST_MODE_COUNT);
    const ownedAttributes = new Set<THREE.StorageBufferAttribute>([binding.residueOffsets, binding.modeDisplacements]);
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
    assert.equal(deleteCount, 2);
    assert.equal(binding.residueOffsets.array.length, 0);
    unregister();
  });

  test('protein render: shadow override receives the source position node per draw', () => {
    const binding = createProteinMotionBinding(3, testModeDisplacements(3), TEST_MODE_COUNT);
    const root = buildProteinEnemyShip(source, { representation: 'silhouette', colorMode: 'surface-charge' }, binding);
    let shell: THREE.Mesh | undefined;
    root.traverse((object) => {
      if (object.userData.proteinShadowOccluder === true) shell = object as THREE.Mesh;
    });
    if (!shell) throw new Error('silhouette must expose a shadow occluder');
    const sourceMaterial = shell.material as THREE.MeshStandardNodeMaterial;
    const override = new THREE.MeshBasicNodeMaterial();
    const scene = new THREE.Scene();
    scene.add(root);
    scene.overrideMaterial = override;
    const restore = installProteinMotionOverridePropagation(scene, [override]);
    shell.onBeforeRender(
      null as never,
      scene,
      new THREE.PerspectiveCamera(),
      shell.geometry,
      sourceMaterial,
      new THREE.Group(),
    );
    assert.strictEqual(override.positionNode, sourceMaterial.positionNode);
    restore();
    override.dispose();
    disposeObject(root);
  });
}

export function runRegisteredProteinRenderTests(): Promise<void> {
  return runAll();
}
