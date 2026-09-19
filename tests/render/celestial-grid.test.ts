// 天球グリッド(src/render/celestial-grid.ts)の回帰テスト。黄道・赤道の行見出しが、面・極・網の
// 表示可否の最終的なゲートとして働くこと(UI-DESIGN.md「まとめトグルの規約」)を、シーンに置かれた
// 表示物の可視で見る。線の本数・色・ラベルの配置は固定しない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { CelestialGrid, type CelestialGridVisibility } from '../../src/render/celestial-grid';
import type { Viewport } from '../../src/render/viewport';

const VIEWPORT: Viewport = { width: 1280, height: 720, pixelRatio: 1 };

// 全ての表示を OFF にした可視状態。既定値に依らず、見たい行だけを ON にする土台。
const ALL_OFF: CelestialGridVisibility = {
  stars: false,
  ecliptic: false, eclipticPlane: false, eclipticPole: false, eclipticGrid: false,
  equator: false, equatorPlane: false, equatorPole: false, equatorGrid: false,
  eclipticScaleGrid: false, equatorScaleGrid: false, moonOrbitScaleGrid: false, moonEquatorScaleGrid: false,
};

// 行見出しと、その束(面・極・網)の鍵。
const ROWS = [
  { gate: 'ecliptic', plane: 'eclipticPlane', pole: 'eclipticPole', grid: 'eclipticGrid' },
  { gate: 'equator', plane: 'equatorPlane', pole: 'equatorPole', grid: 'equatorGrid' },
] as const;

// 座標ラベルは DOM 要素として作られる。node には DOM が無いので、その生成と配置が読み書きする面を
// 立てる。他のテストが立てた代役を壊さないよう、呼んだ側が戻せるように元の値を返す。
function installLabelStub(): unknown {
  const globals = globalThis as unknown as Record<string, unknown>;
  const previous = globals.document;
  const element = () => ({ style: {}, appendChild: () => {}, remove: () => {} });
  globals.document = { createElement: element, body: element() };
  return previous;
}

// visibility で同期したあと、scene の子のうち見えているものの添字。
function visibleAfterSync(
  grid: CelestialGrid, scene: THREE.Scene, visibility: CelestialGridVisibility,
): number[] {
  grid.sync('realistic', visibility, new THREE.PerspectiveCamera(), 1, VIEWPORT);
  return scene.children.flatMap((child, i) => (child.visible ? [i] : []));
}

export function register(): void {
  test('celestial-grid: 行見出しは束の最終的なゲートで、開き直すと束の状態どおりに描く', () => {
    const previousDocument = installLabelStub();
    try {
      for (const row of ROWS) {
        const scene = new THREE.Scene();
        const grid = new CelestialGrid(scene);
        // 見出しを開いたまま、束のうち面と網を ON にする。
        const opened: CelestialGridVisibility = { ...ALL_OFF, [row.gate]: true, [row.plane]: true, [row.grid]: true };
        const shown = visibleAfterSync(grid, scene, opened);
        assert.ok(shown.length > 0, `${row.gate}: 見出しと束が ON なのに何も描かれない`);
        // 見出しを閉じると、束が ON のままでも描かれず、閉じている間に束を ON にしても再開しない。
        const closed: CelestialGridVisibility = { ...opened, [row.gate]: false };
        assert.deepEqual(visibleAfterSync(grid, scene, closed), [], `${row.gate}: 閉じた見出しの束が描かれる`);
        assert.deepEqual(
          visibleAfterSync(grid, scene, { ...closed, [row.pole]: true }), [],
          `${row.gate}: 見出しを閉じている間に ON にした束が描かれる`);
        // 見出しを開き直すと、閉じる前の束の状態どおりに描かれる。
        assert.deepEqual(visibleAfterSync(grid, scene, opened), shown, `${row.gate}: 開き直した描画が閉じる前と違う`);
      }
    } finally {
      (globalThis as unknown as Record<string, unknown>).document = previousDocument;
    }
  });
}
