// 地球タイルの投影選択、個別公開、ページ表境界を検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import {
  EARTH_BASE_LAYER, EARTH_TILE_MIN_Z,
  earthTileChildren, earthTileId, earthTileKey, earthTileNeighbors, earthTileParent, earthTileRoots,
} from '../../src/render/earth-surface-tile-key';
import { earthPageAt, earthTileSampleUv } from '../../src/render/earth-surface-page-table';
import { EarthSurfaceView } from '../../src/render/earth-surface-tile-projection';
import { EarthSurfaceTiles } from '../../src/render/earth-surface-tiles';
import type { EarthTileResident } from '../../src/render/earth-surface-tiles';
import type { EarthTileKey } from '../../src/render/earth-surface-tile-key';
import type { EarthTileMetric, EarthTileProjection } from '../../src/render/earth-surface-tile-projection';

const ROOTS = earthTileRoots().slice(0, 2);

function isAncestorOrSelf(key: EarthTileKey, target: EarthTileKey): boolean {
  for (let current: EarthTileKey | null = target; current !== null; current = earthTileParent(current)) {
    if (earthTileId(current) === earthTileId(key)) return true;
  }
  return false;
}

function tileCenter(key: EarthTileKey): readonly [number, number] {
  return [(key.x + 0.5) / 2 ** (key.z + 1), (key.y + 0.5) / 2 ** key.z];
}

class SyntheticProjection implements EarthTileProjection {
  // 指定した1段の親を分割した後は、その子を安定して表示する。
  public constructor(public rootError: number) {}

  // 全球を可視として、根の分割/統合の境界を独立に踏む。
  public evaluate(key: EarthTileKey): EarthTileMetric {
    return { visible: true, errorPx: key.z <= EARTH_TILE_MIN_Z ? this.rootError : 1.5, priority: 1 };
  }
}

// stage00初期高度・combat視点から実画素の地表投影を作る。
function stage00EarthProjection(): EarthSurfaceView {
  const earthRadius = 6_378_137;
  const polarRadius = 6_356_751.9;
  const altitude = 420_000;
  const distance = earthRadius + altitude;
  const inclination = THREE.MathUtils.degToRad(97);
  const radial = new THREE.Vector3(1, 0, 0);
  const prograde = new THREE.Vector3(0, Math.sin(inclination), -Math.cos(inclination));
  const z = prograde.clone().normalize();
  const x = radial.clone().cross(z).normalize();
  const y = z.clone().cross(x);
  const attitude = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
  const pitch = THREE.MathUtils.degToRad(0.3) - THREE.MathUtils.degToRad(10);
  const cameraOffset = new THREE.Vector3(0, Math.sin(pitch), -Math.cos(pitch))
    .applyQuaternion(attitude).multiplyScalar(38);
  const camera = new THREE.PerspectiveCamera(55, 1920 / 1080, 1, 1e9);
  camera.position.set(distance + cameraOffset.x, cameraOffset.y, cameraOffset.z);
  camera.lookAt(distance, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return new EarthSurfaceView(
    camera, new THREE.Matrix4(), new THREE.Vector3(earthRadius, polarRadius, earthRadius), 1920, 1080,
  );
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
    assert.equal(earthTileRoots().length, 2 ** (EARTH_TILE_MIN_Z + 1) * 2 ** EARTH_TILE_MIN_Z);
    assert.ok(earthTileRoots().every((key) => key.z === EARTH_TILE_MIN_Z));
  });

  test('earth tiles: stage00投影はz5からz7まで個別候補を返す', () => {
    const tiles = new EarthSurfaceTiles();
    const candidates = tiles.requestCandidates(stage00EarthProjection());
    const levels = new Set(candidates.map((key) => key.z));
    assert.ok(levels.has(EARTH_TILE_MIN_Z));
    assert.ok(levels.has(EARTH_TILE_MIN_Z + 1));
    assert.ok(levels.has(7));
    assert.equal(new Set(candidates.map(earthTileId)).size, candidates.length);
  });

  test('earth tiles: 4子を待たず到着したz6タイルを個別に公開する', () => {
    const tiles = new EarthSurfaceTiles();
    const projection = new SyntheticProjection(3);
    const root = earthTileRoots()[0]!;
    const child = earthTileChildren(root)[0]!;
    tiles.sync(projection, [{ key: root, layer: 0 }], 0);
    tiles.sync(projection, [{ key: root, layer: 0 }, { key: child, layer: 1 }], 300);
    const insideChild = earthPageAt(tiles.pageTable(), (child.x + 0.5) / 2 ** (child.z + 1), (child.y + 0.5) / 2 ** child.z);
    assert.equal(insideChild[0], 1);
    assert.equal(insideChild[2], child.z);
    const outsideChild = earthPageAt(tiles.pageTable(), (root.x + 0.75) / 2 ** (root.z + 1), (root.y + 0.75) / 2 ** root.z);
    assert.equal(outsideChild[0], 0);
    assert.equal(outsideChild[2], root.z);
  });

  test('earth tiles: 隣接がbaseのままでもz7タイルを公開する', () => {
    const tiles = new EarthSurfaceTiles();
    const target = earthTileKey(7, 0, 0);
    const projection: EarthTileProjection = {
      evaluate: (key) => ({
        visible: isAncestorOrSelf(key, target), errorPx: key.z < target.z ? 3 : 1, priority: 1,
      }),
    };
    tiles.sync(projection, [{ key: target, layer: 3 }], 0);
    const page = earthPageAt(tiles.pageTable(), (target.x + 0.5) / 2 ** (target.z + 1), (target.y + 0.5) / 2 ** target.z);
    assert.deepEqual(page, [3, EARTH_BASE_LAYER, target.z, 0]);
    assert.deepEqual(earthPageAt(tiles.pageTable(), 0.5, 0.5), [EARTH_BASE_LAYER, EARTH_BASE_LAYER, EARTH_BASE_LAYER, EARTH_BASE_LAYER]);
  });

  test('earth tiles: 可視候補の一段隣接をguard-band候補として返す', () => {
    const tiles = new EarthSurfaceTiles();
    const target = earthTileRoots()[0]!;
    const projection: EarthTileProjection = {
      evaluate: (key) => ({
        visible: isAncestorOrSelf(key, target), errorPx: key.z < EARTH_TILE_MIN_Z ? 3 : 1, priority: 1,
      }),
    };
    const visible = tiles.requestCandidates(projection);
    assert.deepEqual(visible.map(earthTileId), [earthTileId(target)]);
    const prefetch = tiles.prefetchCandidates(projection);
    assert.deepEqual(new Set(prefetch.map(earthTileId)), new Set(earthTileNeighbors(target).map(earthTileId)));
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
    assert.equal(projection.evaluate(earthTileKey(EARTH_TILE_MIN_Z, 30, 8)).visible, true);
    assert.equal(projection.evaluate(earthTileKey(7, 127, 63)).visible, true);
    camera.rotation.y = Math.PI;
    assert.equal(view(camera).evaluate(earthTileKey(7, 127, 63)).visible, false);
  });

  test('earth tiles: 未取得子はbaseまたは親を保持し、到着した子だけ遷移する', () => {
    const tiles = new EarthSurfaceTiles();
    const projection = new SyntheticProjection(3);
    const roots: EarthTileResident[] = ROOTS.map((key, layer) => ({ key, layer }));
    tiles.sync(projection, roots, 0);
    tiles.sync(projection, roots, 250);
    const children = earthTileChildren(ROOTS[0]!).map((key, index) => ({ key, layer: index + 2 }));
    tiles.sync(projection, roots.concat(children.slice(1)), 300);
    const missingChildUv = tileCenter(children[0]!.key);
    assert.deepEqual(earthPageAt(tiles.pageTable(), missingChildUv[0], missingChildUv[1]).slice(0, 3), [0, EARTH_BASE_LAYER, ROOTS[0]!.z]);
    tiles.sync(projection, roots.concat(children), 400);
    assert.deepEqual(earthPageAt(tiles.pageTable(), ...tileCenter(children[0]!.key)), [2, 0, EARTH_TILE_MIN_Z + 1, 0]);
    tiles.sync(projection, roots.concat(children), 525);
    const halfway = earthPageAt(tiles.pageTable(), ...tileCenter(children[0]!.key));
    assert.deepEqual(halfway.slice(0, 3), [2, 0, EARTH_TILE_MIN_Z + 1]);
    assert.ok(halfway[3]! > 0 && halfway[3]! < 255);
    tiles.sync(projection, roots.concat(children), 650);
    assert.equal(earthPageAt(tiles.pageTable(), ...tileCenter(children[0]!.key))[3], 255);

    // 解像度を下げても、到着済みの個別detailは他の地域と独立して保持する。
    projection.rootError = 0.5;
    tiles.sync(projection, roots.concat(children), 700);
    assert.equal(earthPageAt(tiles.pageTable(), ...tileCenter(children[0]!.key))[2], EARTH_TILE_MIN_Z);
  });

  test('earth tiles: 別keyへ再利用されたlayerをleafとfade親へ誤適用しない', () => {
    const projection = new SyntheticProjection(3);
    const roots: EarthTileResident[] = ROOTS.map((key, layer) => ({ key, layer }));
    const children = earthTileChildren(ROOTS[0]!).map((key, index) => ({ key, layer: index + 2 }));

    const leafReuse = new EarthSurfaceTiles();
    leafReuse.sync(projection, roots, 0);
    leafReuse.sync(projection, roots, 250);
    leafReuse.sync(projection, roots.concat(children), 400);
    const reusedLayer = { key: earthTileKey(EARTH_TILE_MIN_Z + 1, 2, 0), layer: children[0]!.layer };
    leafReuse.sync(projection, roots.concat(children.slice(1), reusedLayer), 700);
    assert.deepEqual(earthPageAt(leafReuse.pageTable(), ...tileCenter(children[0]!.key)), [0, EARTH_BASE_LAYER, EARTH_TILE_MIN_Z, 255]);

    const parentReuse = new EarthSurfaceTiles();
    parentReuse.sync(projection, roots, 0);
    parentReuse.sync(projection, roots, 250);
    parentReuse.sync(projection, roots.concat(children), 400);
    const reusedParent = { key: earthTileKey(EARTH_TILE_MIN_Z + 1, 2, 0), layer: roots[0]!.layer };
    parentReuse.sync(projection, [roots[1]!, ...children, reusedParent], 700);
    const page = earthPageAt(parentReuse.pageTable(), ...tileCenter(children[0]!.key));
    assert.equal(page[0], children[0]!.layer);
    assert.equal(page[1], EARTH_BASE_LAYER);
    assert.equal(page[2], children[0]!.key.z);
    assert.equal(page[3], 255);
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
