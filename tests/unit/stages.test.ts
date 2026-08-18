import * as assert from 'node:assert/strict';
import { test } from '../physics/harness';
import { splitStages, separationVelocity } from '../../src/game/vessel/stages';
import { createPart } from '../../src/game/game-entity/parts';
import { v3 } from '../../src/physics/vec3';

export function register(): void {
  test('stages split at decouplers and retain control capabilities', () => {
    const tree = { nodes: [
      { id: 'a', pos: v3(0, 0, 0), section: { primitives: [] } as never, axis: v3(0, 0, 1), phaseAngle: 0 },
      { id: 'b', pos: v3(1, 0, 0), section: { primitives: [] } as never, axis: v3(0, 0, 1), phaseAngle: 0 },
      { id: 'c', pos: v3(2, 0, 0), section: { primitives: [] } as never, axis: v3(0, 0, 1), phaseAngle: 0 },
    ], edges: [
      { id: 'ab', a: 'a', b: 'b', portA: { kind: 'axial', sign: 1 }, portB: { kind: 'axial', sign: -1 }, length: 1, kind: { kind: 'hull' } },
      { id: 'bc', a: 'b', b: 'c', portA: { kind: 'axial', sign: 1 }, portB: { kind: 'axial', sign: -1 }, length: 1, kind: { kind: 'decoupler', separationImpulse: 1 } },
    ] } as never;
    const cockpit = createPart('cockpit', { id: 'cockpit' });
    const stages = splitStages(tree, [{ kind: 'external', part: cockpit, mount: { kind: 'port', nodeId: 'a', port: { kind: 'axial', sign: 1 } } }]);
    assert.equal(stages.length, 2);
    assert.equal(stages[0]!.hasCockpit, true);
  });
  test('separation velocity conserves momentum', () => {
    const v = separationVelocity(2, 3, { x: 5, y: 0, z: 0 });
    assert.equal(2 * v.a.x + 3 * v.b.x, 0);
  });
}
