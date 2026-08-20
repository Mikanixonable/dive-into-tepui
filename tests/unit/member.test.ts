import * as assert from 'node:assert/strict';
import type { VesselAssembly } from '../../src/game/vessel/assembly';
import {
  memberAdditionAt, memberGhostTree, quantizeMemberLength, type MemberSpec,
} from '../../src/game/vessel/member';
import { nearestMountCandidate } from '../../src/game/vessel/mount-candidates';
import type { PortRef, TreeNode } from '../../src/game/vessel/tree';
import { DIMENSION_UNIT, MIN_EDGE_LENGTH, portFrame, validateTree } from '../../src/game/vessel/tree';
import type { CrossSection } from '../../src/physics/section-moments';
import { len, sub, v3 } from '../../src/physics/vec3';
import { test } from '../physics/harness';

const AXIAL_FORE: PortRef = { kind: 'axial', sign: 1 };

function squareSection(radius = 1): CrossSection {
  return { primitives: [{ id: 'p0', shape: { kind: 'polygon', sides: 4, radius }, phaseAngle: 0, attachment: null }] };
}

function singleNodeAssembly(): VesselAssembly {
  const node: TreeNode = { id: 'a', pos: v3(0, 0, 0), axis: v3(0, 0, 1), phaseAngle: 0, section: squareSection() };
  return { tree: { nodes: [node], edges: [] }, placements: [] };
}

function hullMember(length: number): MemberSpec {
  return { kind: 'hull', length, radius: 0.6, separationImpulse: 0 };
}

export function register(): void {
  test('nearestMountCandidate only enumerates side ports when asked for lateral kinds', () => {
    const assembly = singleNodeAssembly();
    const node = assembly.tree.nodes[0]!;
    const lateralOrigin = portFrame(node, { kind: 'lateral', primitiveId: 'p0', faceIndex: 0 }).origin;

    // 既定(axial のみ)では、正方形の1面の中心は候補にならず、原点にある軸ポートが answer になる。
    const axialOnly = nearestMountCandidate(assembly, lateralOrigin, 10, (m) => m.kind === 'port');
    assert.ok(axialOnly);
    assert.equal(axialOnly.mount.kind, 'port');
    if (axialOnly.mount.kind === 'port') assert.equal(axialOnly.mount.port.kind, 'axial');
    assert.ok(axialOnly.distance > 0.5);

    // portKinds に 'lateral' を足すと、同じ点そのものが候補として見つかる。
    const withLateral = nearestMountCandidate(assembly, lateralOrigin, 10, (m) => m.kind === 'port', ['axial', 'lateral']);
    assert.ok(withLateral);
    assert.equal(withLateral.mount.kind, 'port');
    if (withLateral.mount.kind === 'port') {
      assert.equal(withLateral.mount.port.kind, 'lateral');
      if (withLateral.mount.port.kind === 'lateral') {
        assert.equal(withLateral.mount.port.primitiveId, 'p0');
        assert.equal(withLateral.mount.port.faceIndex, 0);
      }
    }
    assert.ok(withLateral.distance < 1e-9);
  });

  test('every face of a 4-sided section resolves to its own lateral port', () => {
    const assembly = singleNodeAssembly();
    const node = assembly.tree.nodes[0]!;
    for (let faceIndex = 0; faceIndex < 4; faceIndex++) {
      const origin = portFrame(node, { kind: 'lateral', primitiveId: 'p0', faceIndex }).origin;
      const found = nearestMountCandidate(assembly, origin, 0.01, (m) => m.kind === 'port', ['axial', 'lateral']);
      assert.ok(found, `face ${faceIndex} should resolve`);
      assert.equal(found.mount.kind, 'port');
      if (found.mount.kind === 'port' && found.mount.port.kind === 'lateral') {
        assert.equal(found.mount.port.faceIndex, faceIndex);
      }
    }
  });

  test('quantizeMemberLength snaps to DIMENSION_UNIT and never drops below MIN_EDGE_LENGTH', () => {
    assert.equal(quantizeMemberLength(2.3), 2.5);
    assert.equal(quantizeMemberLength(4), 4);
    assert.equal(quantizeMemberLength(0.1), MIN_EDGE_LENGTH);
    assert.equal(quantizeMemberLength(Number.NaN), MIN_EDGE_LENGTH);
  });

  test('memberAdditionAt places the far node exactly length away and the edge length is an exact multiple of DIMENSION_UNIT', () => {
    const assembly = singleNodeAssembly();
    const node = assembly.tree.nodes[0]!;
    const mountFrame = portFrame(node, AXIAL_FORE);
    const member = hullMember(quantizeMemberLength(2.7));
    assert.equal(member.length, 2.5);

    const result = memberAdditionAt(assembly, node.id, AXIAL_FORE, mountFrame, member);
    assert.ok(result.accepted, result.errors.map((e) => e.message).join('; '));
    assert.deepEqual(validateTree(result.assembly.tree), []);

    const farNode = result.assembly.tree.nodes.find((n) => n.id !== node.id)!;
    assert.ok(farNode);
    const expectedFar = v3(mountFrame.origin.x + mountFrame.z.x * member.length,
      mountFrame.origin.y + mountFrame.z.y * member.length, mountFrame.origin.z + mountFrame.z.z * member.length);
    assert.ok(len(sub(farNode.pos, expectedFar)) < 1e-9);

    const edge = result.assembly.tree.edges.find((e) => e.a === node.id || e.b === node.id)!;
    assert.ok(edge);
    assert.ok(Math.abs(edge.length - member.length) < 1e-9);
    const ratio = edge.length / DIMENSION_UNIT;
    assert.ok(Math.abs(ratio - Math.round(ratio)) < 1e-9);
    assert.equal(edge.kind.kind, 'hull');
  });

  test('an un-quantized member length is rejected by the same edge-length check the UI avoids', () => {
    const assembly = singleNodeAssembly();
    const node = assembly.tree.nodes[0]!;
    const mountFrame = portFrame(node, AXIAL_FORE);
    const result = memberAdditionAt(assembly, node.id, AXIAL_FORE, mountFrame, hullMember(2.3));
    assert.equal(result.accepted, false);
  });

  test('memberAdditionAt derives truss sectionSize and decoupler separationImpulse from the spec', () => {
    const assembly = singleNodeAssembly();
    const node = assembly.tree.nodes[0]!;
    const mountFrame = portFrame(node, AXIAL_FORE);

    const truss: MemberSpec = { kind: 'truss', length: 1.5, radius: 0.4, separationImpulse: 0 };
    const trussResult = memberAdditionAt(assembly, node.id, AXIAL_FORE, mountFrame, truss);
    assert.ok(trussResult.accepted, trussResult.errors.map((e) => e.message).join('; '));
    const trussEdge = trussResult.assembly.tree.edges.find((e) => e.a === node.id)!;
    assert.equal(trussEdge.kind.kind, 'truss');
    if (trussEdge.kind.kind === 'truss') assert.ok(Math.abs(trussEdge.kind.sectionSize - truss.radius * 2) < 1e-9);

    const decoupler: MemberSpec = { kind: 'decoupler', length: 1, radius: 0.4, separationImpulse: 750 };
    const decouplerResult = memberAdditionAt(assembly, node.id, AXIAL_FORE, mountFrame, decoupler);
    assert.ok(decouplerResult.accepted, decouplerResult.errors.map((e) => e.message).join('; '));
    const decouplerEdge = decouplerResult.assembly.tree.edges.find((e) => e.a === node.id)!;
    assert.equal(decouplerEdge.kind.kind, 'decoupler');
    if (decouplerEdge.kind.kind === 'decoupler') assert.equal(decouplerEdge.kind.separationImpulse, 750);
  });

  test('memberGhostTree builds a valid two-node tree of exactly the member length', () => {
    for (const kind of ['hull', 'truss', 'decoupler'] as const) {
      const member: MemberSpec = { kind, length: 3, radius: 0.5, separationImpulse: 200 };
      const tree = memberGhostTree(member);
      assert.equal(tree.nodes.length, 2);
      assert.equal(tree.edges.length, 1);
      assert.deepEqual(validateTree(tree), []);
      assert.ok(Math.abs(tree.edges[0]!.length - 3) < 1e-9);
    }
  });
}
