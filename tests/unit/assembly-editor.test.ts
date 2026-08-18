import * as assert from 'node:assert/strict';
import { createPart } from '../../src/game/game-entity/parts';
import type { PartPlacement, VesselAssembly } from '../../src/game/vessel/assembly';
import {
  addEdge, addNode, editSection, moveNode, movePlacement, reconnectEdge, removeEdge, removeNode,
  validateAssembly,
} from '../../src/game/vessel/assembly-editor';
import type { CrossSection } from '../../src/physics/section-moments';
import { v3 } from '../../src/physics/vec3';
import type { PortRef, TreeNode } from '../../src/game/vessel/tree';
import { test } from '../physics/harness';

const EDITOR_OPTIONS = { validateBlueprint: false } as const;
const AXIAL_FORE: PortRef = { kind: 'axial', sign: 1 };
const AXIAL_AFT: PortRef = { kind: 'axial', sign: -1 };

function squareSection(radius = 1): CrossSection {
  return {
    primitives: [{
      id: 'p0', shape: { kind: 'polygon', sides: 4, radius }, phaseAngle: 0, attachment: null,
    }],
  };
}

function node(id: string, z: number): TreeNode {
  return { id, pos: v3(0, 0, z), axis: v3(0, 0, 1), phaseAngle: 0, section: squareSection() };
}

function assemblyWithTwoNodes(): VesselAssembly {
  return {
    tree: {
      nodes: [node('a', 0), node('b', 2)],
      edges: [{ id: 'ab', a: 'a', b: 'b', portA: AXIAL_FORE, portB: AXIAL_AFT, length: 2, kind: { kind: 'hull' } }],
    },
    placements: [],
  };
}

function edgeOf(assembly: VesselAssembly, id: string): number {
  return assembly.tree.edges.find((edge) => edge.id === id)!.length;
}

export function register(): void {
  test('assembly editor adds nodes and derives edge length from ports', () => {
    const original = assemblyWithTwoNodes();
    const result = addNode(original, {
      node: node('c', 4),
      edge: { id: 'bc', a: 'b', b: 'c', portA: AXIAL_FORE, portB: AXIAL_AFT, kind: { kind: 'hull' } },
    }, EDITOR_OPTIONS);

    assert.equal(result.accepted, true);
    assert.equal(result.assembly.tree.nodes.length, 3);
    assert.equal(edgeOf(result.assembly, 'bc'), 2);
    assert.equal(original.tree.nodes.length, 2);
    assert.equal(original.tree.edges.length, 1);
  });

  test('assembly editor recomputes edge length on node move and rejects non-quantized lengths', () => {
    const original = assemblyWithTwoNodes();
    const moved = moveNode(original, { nodeId: 'b', pos: v3(0, 0, 3) }, EDITOR_OPTIONS);
    assert.equal(moved.accepted, true);
    assert.equal(edgeOf(moved.assembly, 'ab'), 3);
    assert.equal(original.tree.nodes[1]!.pos.z, 2);
    assert.equal(edgeOf(original, 'ab'), 2);

    const invalid = moveNode(original, { nodeId: 'b', pos: v3(0, 0, 2.1) }, EDITOR_OPTIONS);
    assert.equal(invalid.accepted, false);
    assert.strictEqual(invalid.assembly, original);
    assert.equal(edgeOf(invalid.assembly, 'ab'), 2);
  });

  test('assembly editor reconnects and removes edges without dangling references', () => {
    const original = assemblyWithTwoNodes();
    const reconnected = reconnectEdge(original, { edgeId: 'ab', kind: { kind: 'truss', sectionSize: 0.5 } }, EDITOR_OPTIONS);
    assert.equal(reconnected.accepted, true);
    assert.equal(reconnected.assembly.tree.edges[0]!.kind.kind, 'truss');
    assert.equal(edgeOf(reconnected.assembly, 'ab'), 2);

    const removedNode = removeNode(original, 'a', EDITOR_OPTIONS);
    assert.equal(removedNode.accepted, false);
    assert.strictEqual(removedNode.assembly, original);
    assert.match(removedNode.errors[0]!.message, /参照されています/);

    const removedEdge = removeEdge(original, 'ab', EDITOR_OPTIONS);
    assert.equal(removedEdge.accepted, false);
    assert.strictEqual(removedEdge.assembly, original);
    assert.match(removedEdge.validationIssues[0]?.message ?? removedEdge.errors[0]!.message, /繋がっていません|参照/);
  });

  test('assembly editor edits composite section primitives and protects references', () => {
    const original = assemblyWithTwoNodes();
    const added = editSection(original, {
      kind: 'add-primitive',
      nodeId: 'a',
      primitive: {
        id: 'p1', shape: { kind: 'polygon', sides: 4, radius: 1 }, phaseAngle: 0,
        attachment: { parentId: 'p0', parentFaceIndex: 0, childFaceIndex: 2 },
      },
    }, EDITOR_OPTIONS);
    assert.equal(added.accepted, true);
    assert.equal(added.assembly.tree.nodes[0]!.section.primitives.length, 2);

    const removed = editSection(added.assembly, { kind: 'remove-primitive', nodeId: 'a', primitiveId: 'p1' }, EDITOR_OPTIONS);
    assert.equal(removed.accepted, true);
    assert.equal(removed.assembly.tree.nodes[0]!.section.primitives.length, 1);

    const rootRemoval = editSection(original, { kind: 'remove-primitive', nodeId: 'a', primitiveId: 'p0' }, EDITOR_OPTIONS);
    assert.equal(rootRemoval.accepted, false);
    assert.strictEqual(rootRemoval.assembly, original);
  });

  test('assembly editor moves external MountPoint and rejects out-of-range mounts', () => {
    const antenna = createPart('communication', { id: 'antenna', name: 'Antenna', range: 1000 });
    const placement: PartPlacement = {
      kind: 'external',
      part: antenna,
      mount: { kind: 'surface', edgeId: 'ab', along: 1, around: 0 },
    };
    const original: VesselAssembly = { ...assemblyWithTwoNodes(), placements: [placement] };
    const moved = movePlacement(original, {
      placementId: 'antenna', mount: { kind: 'surface', edgeId: 'ab', along: 1.5, around: Math.PI / 2 },
    }, EDITOR_OPTIONS);
    assert.equal(moved.accepted, true);
    assert.equal(moved.assembly.placements[0]!.kind, 'external');
    if (moved.assembly.placements[0]!.kind === 'external') assert.equal(moved.assembly.placements[0]!.mount.kind, 'surface');

    const invalid = movePlacement(original, {
      placementId: 'antenna', mount: { kind: 'surface', edgeId: 'ab', along: 3, around: 0 },
    }, EDITOR_OPTIONS);
    assert.equal(invalid.accepted, false);
    assert.strictEqual(invalid.assembly, original);
  });

  test('assembly editor validates existing tree references before blueprint checks', () => {
    const assembly = assemblyWithTwoNodes();
    assert.deepEqual(validateAssembly(assembly, EDITOR_OPTIONS), []);
    const malformed = {
      ...assembly,
      tree: { ...assembly.tree, edges: [{ ...assembly.tree.edges[0]!, length: 99 }] },
    };
    const issues = validateAssembly(malformed, EDITOR_OPTIONS);
    assert.ok(issues.some((issue) => issue.message.includes('declares length')));
  });
}
