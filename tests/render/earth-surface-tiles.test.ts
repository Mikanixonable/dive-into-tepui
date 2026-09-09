// 四分木の位相、画面誤差、取得待機と親子遷移の不変条件を検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import {
  EARTH_BASE_LAYER, EarthSurfaceTiles, EarthSurfaceView, balanceEarthFrontier, earthPageAt,
  earthTileChildren, earthTileId, earthTileKey, earthTileNeighbors, earthTilesAdjacent, earthTileSampleUv,
} from '../../src/render/earth-surface-tiles';
import type { EarthTileKey, EarthTileMetric, EarthTileProjection, EarthTileResident } from '../../src/render/earth-surface-tiles';

const ROOTS = [earthTileKey(0, 0, 0), earthTileKey(0, 1, 0)];

class SyntheticProjection implements EarthTileProjection {
  // 指定した1段の親を分割した後は、その子を安定して表示する。
  public constructor(public rootError: number) {}

  // 全球を可視として、根の分割/統合の境界を独立に踏む。
  public evaluate(key: EarthTileKey): EarthTileMetric {
    return { visible: true, errorPx: key.z === 0 ? this.rootError : 1.5, priority: 1 };
  }
}

// 葉の被覆面積と全隣接辺の2:1制約を検査する。
function assertBalanced(frontier: readonly EarthTileKey[]): void {
  assert.equal(frontier.reduce((area, key) => area + 1 / 4 ** key.z, 0), 2);
  for (const a of frontier) {
    for (const b of frontier) {
      if (earthTilesAdjacent(a, b)) assert.ok(Math.abs(a.z - b.z) <= 1, `${earthTileId(a)} / ${earthTileId(b)}`);
    }
  }
}

// 同じカメラの実画素数だけを指定して地表の投影を作る。
function view(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, pixels = 1024): EarthSurfaceView {
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  return new EarthSurfaceView(camera, new THREE.Matrix4(), new THREE.Vector3(1, 1, 1), pixels, pixels);
}

// この層の回帰テストを登録する。
export function register(): void {
  test('earth tiles: 経度周期と両極の隣接は相反する', () => {
    for (const z of [0, 1, 3, 7]) {
      const height = 2 ** z;
      assert.deepEqual(earthTileKey(z, -1, -1), earthTileKey(z, 2 * height - 1, 0));
      assert.deepEqual(earthTileKey(z, 2 * height, height), earthTileKey(z, 0, height - 1));
      for (const key of [earthTileKey(z, 0, 0), earthTileKey(z, 2 * height - 1, height - 1)]) {
        for (const neighbor of earthTileNeighbors(key)) {
          assert.ok(earthTileNeighbors(neighbor).some((opposite) => earthTileId(opposite) === earthTileId(key)));
        }
      }
    }
    assert.equal(earthTileChildren(earthTileKey(7, 0, 0)).length, 0);
  });

  test('earth tiles: 日付変更線と極で粗い側を分割し、不可なら細かい側を戻す', () => {
    let frontier = [...ROOTS];
    let refine = ROOTS[0]!;
    for (let z = 0; z < 4; z++) {
      const children = earthTileChildren(refine);
      frontier = frontier.filter((key) => earthTileId(key) !== earthTileId(refine)).concat(children);
      refine = children[0]!;
    }
    assert.ok(earthTilesAdjacent(refine, ROOTS[1]!));
    const refined = balanceEarthFrontier(frontier, () => true);
    const coarsened = balanceEarthFrontier(frontier, () => false);
    assertBalanced(refined);
    assertBalanced(coarsened);
    assert.ok(refined.some((key) => key.z === 4));
    assert.ok(coarsened.every((key) => key.z <= 1));
  });

  test('earth tiles: errorPxは実画素数に比例し直交投影では距離に依存しない', () => {
    const key = earthTileKey(5, 31, 15);
    const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
    camera.position.z = 3;
    const small = view(camera).evaluate(key);
    const large = view(camera, 2048).evaluate(key);
    assert.ok(small.visible && small.errorPx > 0);
    assert.ok(Math.abs(large.errorPx / small.errorPx - 2) < 1e-12);
    camera.position.z = 6;
    assert.ok(view(camera).evaluate(key).errorPx < small.errorPx);

    const ortho = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.01, 100);
    ortho.position.z = 3;
    const close = view(ortho).evaluate(key);
    ortho.position.z = 6;
    assert.ok(Math.abs(view(ortho).evaluate(key).errorPx - close.errorPx) < 1e-12);
  });

  test('earth tiles: 視錐台外と地平線外を除外し、地平線を跨ぐ親を残す', () => {
    const camera = new THREE.PerspectiveCamera(60, 1, 0.01, 100);
    camera.position.z = 3;
    const projection = view(camera);
    assert.equal(projection.evaluate(earthTileKey(7, 0, 63)).visible, false);
    assert.equal(projection.evaluate(ROOTS[0]!).visible, true);
    assert.equal(projection.evaluate(earthTileKey(7, 127, 63)).visible, true);
    camera.rotation.y = Math.PI;
    assert.equal(view(camera).evaluate(earthTileKey(7, 127, 63)).visible, false);
  });

  test('earth tiles: 未取得子は親のページを保持し、親子が同時に連続遷移する', () => {
    const tiles = new EarthSurfaceTiles();
    const projection = new SyntheticProjection(3);
    const roots: EarthTileResident[] = ROOTS.map((key, layer) => ({ key, layer }));
    tiles.sync(projection, roots, 0);
    tiles.sync(projection, roots, 250);
    const stable = tiles.pageTable();
    const children = earthTileChildren(ROOTS[0]!).map((key, index) => ({ key, layer: index + 2 }));
    tiles.sync(projection, roots.concat(children.slice(1)), 300);
    assert.deepEqual(tiles.pageTable(), stable);
    tiles.sync(projection, roots.concat(children), 400);
    assert.deepEqual(earthPageAt(tiles.pageTable(), 0.1, 0.1), [2, 0, 1, 0]);
    tiles.sync(projection, roots.concat(children), 525);
    const halfway = earthPageAt(tiles.pageTable(), 0.1, 0.1);
    assert.deepEqual(halfway.slice(0, 3), [2, 0, 1]);
    assert.ok(halfway[3]! > 0 && halfway[3]! < 255);
    tiles.sync(projection, roots.concat(children), 650);
    assert.equal(earthPageAt(tiles.pageTable(), 0.1, 0.1)[3], 255);

    // 1..2pxの帯では分割状態を保ち、統合の途中は子/親を逆向きに混ぜる。
    projection.rootError = 1.5;
    tiles.sync(projection, roots.concat(children), 700);
    assert.equal(earthPageAt(tiles.pageTable(), 0.1, 0.1)[2], 1);
    projection.rootError = 0.5;
    tiles.sync(projection, roots.concat(children), 800);
    tiles.sync(projection, roots.concat(children), 925);
    assert.deepEqual(earthPageAt(tiles.pageTable(), 0.1, 0.1), halfway);
    tiles.sync(projection, roots.concat(children), 1050);
    assert.deepEqual(earthPageAt(tiles.pageTable(), 0.1, 0.1), [0, EARTH_BASE_LAYER, 0, 255]);
  });

  test('earth tiles: 未取得根はbaseを指し索引境界で親子の標本位置が一致する', () => {
    const tiles = new EarthSurfaceTiles();
    tiles.sync(new SyntheticProjection(3), [], 0);
    assert.deepEqual(earthPageAt(tiles.pageTable(), 0.2, 0.3), [255, 255, 255, 255]);
    assert.deepEqual(earthPageAt(tiles.pageTable(), 0, 1), earthPageAt(tiles.pageTable(), 1, 1));
    for (const z of [0, 3, 7]) {
      assert.deepEqual(earthTileSampleUv(0, 0.3, z), earthTileSampleUv(1, 0.3, z));
      assert.ok(earthTileSampleUv(0, 1, z).y > earthTileSampleUv(0, 0, z).y);
    }
  });
}
