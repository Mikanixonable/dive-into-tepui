// 展開部品のパネル鎖が剛体の蛇腹として閉じていること — 隣のパネルとヒンジを共有し、
// 展開しきると一枚の帯に、畳みきると厚みずつずれた積層になる。
import * as assert from 'node:assert/strict';
import { qRotate } from '../../src/math/quat';
import { add, len, scale, sub, v3, type Vec3 } from '../../src/math/vec3';
import {
  RADIATOR_PANEL_THICKNESS,
  RADIATOR_SEGMENT_LENGTH,
  SOLAR_PANEL_COUNT,
  SOLAR_PANEL_THICKNESS,
  SOLAR_PANEL_WIDTH,
} from '../../src/physics/player-shape';
import {
  deployablePanelPoses, type DeployablePanelKind, type PanelPose,
} from '../../src/physics/ship-panel-layout';
import { test } from '../harness';

const SHAPES: Readonly<Record<DeployablePanelKind, { length: number; thickness: number; normal: Vec3 }>> = {
  solar_panel: { length: SOLAR_PANEL_WIDTH, thickness: SOLAR_PANEL_THICKNESS, normal: v3(0, 1, 0) },
  radiator: { length: RADIATOR_SEGMENT_LENGTH, thickness: RADIATOR_PANEL_THICKNESS, normal: v3(1, 0, 0) },
};

// パネル局所の点 local をモジュール局所へ写す。
function toModule(pose: PanelPose, local: Vec3): Vec3 {
  return add(pose.origin, qRotate(pose.rotation, local));
}

// パネル i の根元側・先端側のヒンジ線(厚みの side 面上)。
function hinges(kind: DeployablePanelKind, pose: PanelPose, index: number): { root: Vec3; tip: Vec3 } {
  const { length, thickness, normal } = SHAPES[kind];
  const side = index % 2 === 0 ? 1 : -1;
  return {
    root: toModule(pose, scale(normal, -side * thickness / 2)),
    tip: add(toModule(pose, scale(normal, side * thickness / 2)), qRotate(pose.rotation, v3(0, 0, length))),
  };
}

export function register(): void {
  for (const kind of ['solar_panel', 'radiator'] as const) {
    test(`ship panel layout: ${kind} の隣り合うパネルは全展開度でヒンジを共有する`, () => {
      for (const deployed of [0, 0.1, 0.37, 0.5, 0.8, 1]) {
        const poses = deployablePanelPoses(kind, 0.5, deployed);
        assert.ok(len(sub(hinges(kind, poses[0]!, 0).root, v3(0, 0, 0.5))) < 1e-9);
        for (let i = 1; i < poses.length; i++) {
          const gap = len(sub(hinges(kind, poses[i - 1]!, i - 1).tip, hinges(kind, poses[i]!, i).root));
          assert.ok(gap < 1e-9, `${kind} deployed=${deployed} hinge ${i} gap ${gap}`);
        }
      }
    });

    test(`ship panel layout: ${kind} の中心と法線は姿勢と一致する`, () => {
      const { length, normal } = SHAPES[kind];
      for (const pose of deployablePanelPoses(kind, 0.5, 0.6)) {
        assert.ok(len(sub(pose.center, toModule(pose, v3(0, 0, length / 2)))) < 1e-9);
        assert.ok(len(sub(pose.normal, qRotate(pose.rotation, normal))) < 1e-9);
      }
    });

    test(`ship panel layout: ${kind} は畳みきると取付面の上へ厚みずつ積み重なる`, () => {
      const { thickness } = SHAPES[kind];
      const poses = deployablePanelPoses(kind, 0.5, 0);
      poses.forEach((pose, index) => {
        assert.ok(Math.abs(pose.center.z - (0.5 + (index + 0.5) * thickness)) < 1e-9, `${kind} layer ${index}`);
        assert.ok(Math.abs(Math.abs(pose.normal.z) - 1) < 1e-9);
      });
    });
  }

  test('ship panel layout: 太陽電池は展開しきると法線 +Y の一枚の帯になる', () => {
    const poses = deployablePanelPoses('solar_panel', 0.5, 1);
    assert.equal(poses.length, SOLAR_PANEL_COUNT);
    poses.forEach((pose, index) => {
      assert.ok(len(sub(pose.normal, v3(0, 1, 0))) < 1e-9);
      assert.ok(Math.abs(pose.center.z - (0.5 + (index + 0.5) * SOLAR_PANEL_WIDTH)) < 1e-9);
    });
  });
}
