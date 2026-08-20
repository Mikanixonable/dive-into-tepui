import * as assert from 'node:assert/strict';
import type { PartPlacement, VesselAssembly } from '../../src/game/vessel/assembly';
import { nearestMountCandidate } from '../../src/game/vessel/mount-candidates';
import type { PortRef, TreeNode } from '../../src/game/vessel/tree';
import { circumradius } from '../../src/game/vessel/tree';
import type { CrossSection } from '../../src/physics/section-moments';
import { v3 } from '../../src/physics/vec3';
import { test } from '../physics/harness';

const AXIAL_FORE: PortRef = { kind: 'axial', sign: 1 };
const AXIAL_AFT: PortRef = { kind: 'axial', sign: -1 };

function circleSection(radius: number): CrossSection {
  return { primitives: [{ id: 'p0', shape: { kind: 'circle', radius, branchCount: 2 }, phaseAngle: 0, attachment: null }] };
}

function node(id: string, z: number, radius = 1): TreeNode {
  return { id, pos: v3(0, 0, z), axis: v3(0, 0, 1), phaseAngle: 0, section: circleSection(radius) };
}

// z 軸に沿った一本のエッジ(a → b)を持つだけの機体。
function straightAssembly(placements: readonly PartPlacement[] = []): VesselAssembly {
  return {
    tree: {
      nodes: [node('a', 0), node('b', 4)],
      edges: [{ id: 'ab', a: 'a', b: 'b', portA: AXIAL_FORE, portB: AXIAL_AFT, length: 4, kind: { kind: 'hull' } }],
    },
    placements,
  };
}

export function register(): void {
  test('mount candidates find a free axial port near a node', () => {
    const assembly = straightAssembly();
    const candidate = nearestMountCandidate(assembly, v3(0, 0, -0.5), 1);
    assert.ok(candidate);
    assert.deepEqual(candidate.mount, { kind: 'port', nodeId: 'a', port: AXIAL_AFT });
    assert.ok(Math.abs(candidate.distance - 0.5) < 1e-9);
  });

  test('mount candidates exclude an axial port already used by an edge', () => {
    const assembly = straightAssembly();
    // ノード a の +Z 側はエッジ ab が占有しているので、-Z 側の空きポートだけが候補に残る。
    const candidate = nearestMountCandidate(assembly, v3(0, 0, -0.5), 1, (m) => m.kind === 'port');
    assert.ok(candidate);
    assert.equal(candidate.mount.kind, 'port');
    if (candidate.mount.kind === 'port' && candidate.mount.port.kind === 'axial') {
      assert.equal(candidate.mount.port.sign, -1);
    }

    const farFromEitherNode = nearestMountCandidate(assembly, v3(0, 0, -100), 1, (m) => m.kind === 'port');
    assert.equal(farFromEitherNode, null);
  });

  test('mount candidates solve along/around on a straight hull edge', () => {
    const assembly = straightAssembly();
    const radius = circumradius(assembly.tree.nodes[0]!.section);
    // 半径1の断面の+X側、エッジの始点から1.5m進んだ位置を狙う。
    const candidate = nearestMountCandidate(assembly, v3(radius + 0.3, 0, 1.5), 1, (m) => m.kind === 'surface');
    assert.ok(candidate);
    assert.equal(candidate.mount.kind, 'surface');
    if (candidate.mount.kind === 'surface') {
      assert.ok(Math.abs(candidate.mount.along - 1.5) < 1e-9);
      assert.ok(Math.abs(candidate.mount.around - 0) < 1e-9);
    }
    assert.ok(Math.abs(candidate.distance - 0.3) < 1e-9);
  });

  test('mount candidates clamp along to the edge span and beyond maxDistance find nothing', () => {
    const assembly = straightAssembly();
    const radius = circumradius(assembly.tree.nodes[0]!.section);
    const beyondEnd = nearestMountCandidate(assembly, v3(radius, 0, 10), 100, (m) => m.kind === 'surface');
    assert.ok(beyondEnd);
    assert.equal(beyondEnd.mount.kind, 'surface');
    if (beyondEnd.mount.kind === 'surface') assert.ok(Math.abs(beyondEnd.mount.along - 4) < 1e-9);

    const tooFar = nearestMountCandidate(assembly, v3(0, 0, 2), 0.01);
    assert.equal(tooFar, null);
  });
}
