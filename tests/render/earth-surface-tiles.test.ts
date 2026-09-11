// 四分木の位相、画面誤差、取得待機と親子遷移の不変条件を検査する。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import {
  EARTH_BASE_LAYER, EARTH_TILE_FRONTIER_LAYERS, EARTH_TILE_MIN_Z, EarthSurfaceTiles, EarthSurfaceView, earthPageAt,
  earthTileChildren, earthTileId, earthTileKey, earthTileNeighbors, earthTileParent, earthTileRoots,
  earthTilesAdjacent, earthTileSampleUv,
} from '../../src/render/earth-surface-tiles';
import type { EarthTileKey, EarthTileMetric, EarthTileProjection, EarthTileResident } from '../../src/render/earth-surface-tiles';

const ROOTS = earthTileRoots().slice(0, 2);

class SyntheticProjection implements EarthTileProjection {
  // 指定した1段の親を分割した後は、その子を安定して表示する。
  public constructor(public rootError: number) {}

  // 全球を可視として、根の分割/統合の境界を独立に踏む。
  public evaluate(key: EarthTileKey): EarthTileMetric {
    return { visible: true, errorPx: key.z === EARTH_TILE_MIN_Z ? this.rootError : 1.5, priority: 1 };
  }
}

// 取得済み子を常にそろえ、分割候補を深く作る投影。
class DeepProjection implements EarthTileProjection {
  public evaluate(key: EarthTileKey): EarthTileMetric {
    return { visible: true, errorPx: 3, priority: 1 / (1 + key.z) };
  }
}

// 子ごとのpriorityが交錯しても、親単位の最大値でgroupを選ばせる投影。
class InterleavedGroupProjection implements EarthTileProjection {
  public evaluate(key: EarthTileKey): EarthTileMetric {
    if (key.z === EARTH_TILE_MIN_Z) {
      return { visible: key.x < 2 && key.y === 0, errorPx: 3, priority: 0 };
    }
    if (key.z !== EARTH_TILE_MIN_Z + 1) return { visible: false, errorPx: 1.5, priority: 0 };
    if (key.x >= 4 || key.y >= 2) return { visible: false, errorPx: 1.5, priority: 0 };
    const priority = key.x < 2
      ? (key.x === 0 && key.y === 0 ? 90 : 1)
      : 100 - key.x * 10 - key.y * 10;
    return { visible: true, errorPx: 1.5, priority };
  }
}

// 指定した葉だけを分割候補にする投影。
class SelectiveProjection implements EarthTileProjection {
  public constructor(private active: readonly EarthTileKey[]) {}

  public setActive(keys: readonly EarthTileKey[]): void {
    this.active = keys;
  }

  public evaluate(key: EarthTileKey): EarthTileMetric {
    return {
      visible: true,
      errorPx: this.active.some((activeKey) => earthTileId(activeKey) === earthTileId(key)) ? 3 : 1.5,
      priority: 1,
    };
  }
}

// 指定した葉をGPU常駐済みfixtureへ変換する。
function residents(keys: readonly EarthTileKey[], firstLayer = 0): EarthTileResident[] {
  return keys.map((key, index) => ({ key, layer: firstLayer + index }));
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

// 取得候補を1groupずつ常駐させ、層の上限内で使われていない層を再利用する。
function admitResidentGroup(
  candidates: readonly EarthTileKey[], tiles: EarthSurfaceTiles,
  resident: Map<string, EarthTileResident>, nextLayer: number,
): number {
  const pinned = new Set(tiles.pinnedLayers());
  while (resident.size + candidates.length > EARTH_TILE_FRONTIER_LAYERS) {
    const victim = [...resident.values()].find((tile) => !pinned.has(tile.layer));
    assert.ok(victim !== undefined, 'resident admission has no evictable layer');
    resident.delete(earthTileId(victim.key));
  }
  const used = new Set([...resident.values()].map((tile) => tile.layer));
  let layer = nextLayer;
  for (const key of candidates) {
    if (resident.has(earthTileId(key))) continue;
    while (used.has(layer)) layer = (layer + 1) % EARTH_TILE_FRONTIER_LAYERS;
    resident.set(earthTileId(key), { key, layer });
    used.add(layer);
    layer = (layer + 1) % EARTH_TILE_FRONTIER_LAYERS;
  }
  return layer;
}

// 葉の被覆面積と全隣接辺の2:1制約を検査する。
function assertBalanced(frontier: readonly EarthTileKey[]): void {
  assert.equal(frontier.reduce((area, key) => area + 1 / 4 ** key.z, 0), 2);
  assertAdjacentBalanced(frontier);
}

// 可視葉だけを受け取り、隣接する葉の段差を検査する。
function assertAdjacentBalanced(frontier: readonly EarthTileKey[]): void {
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
    assert.equal(earthTileRoots().length, 512);
    assert.ok(earthTileRoots().every((key) => key.z === EARTH_TILE_MIN_Z));
  });

  test('earth tiles: stage00投影で取得順が変わってもz6/z7候補へ進みfrontierを保つ', () => {
    for (const reverseArrival of [false, true]) {
      const tiles = new EarthSurfaceTiles();
      const projection = stage00EarthProjection();
      const resident = new Map<string, EarthTileResident>();
      const candidateStages = new Set<number>();
      let nextLayer = 0;
      for (let frame = 0; frame < 120 && !candidateStages.has(7); frame++) {
        tiles.sync(projection, [...resident.values()], frame * 250);
        const frontier = tiles.frontier.map((tile) => tile.key);
        assertAdjacentBalanced(frontier);
        const candidates = tiles.requestCandidates(projection)
          .filter((key) => !resident.has(earthTileId(key)));
        const arrival = reverseArrival ? candidates.slice().reverse() : candidates;
        for (const key of arrival) candidateStages.add(key.z);
        const groups = new Map<string, EarthTileKey[]>();
        for (const key of arrival) {
          const parent = earthTileParent(key);
          const groupId = parent === null ? earthTileId(key) : earthTileId(parent);
          const group = groups.get(groupId) ?? [];
          group.push(key);
          groups.set(groupId, group);
        }
        const group = [...groups.values()].find((keys) => keys.length === 4) ?? arrival;
        if (group.length === 0) continue;
        nextLayer = admitResidentGroup(group, tiles, resident, nextLayer);
        assert.ok(resident.size <= EARTH_TILE_FRONTIER_LAYERS);
      }
      assert.ok(candidateStages.has(6));
      assert.ok(candidateStages.has(7));
    }
  });

  test('earth tiles: 1回のsyncで開始するsplit groupを4つに制限する', () => {
    const tiles = new EarthSurfaceTiles();
    const projection = new DeepProjection();
    const roots = residents(earthTileRoots().slice(0, 4));
    tiles.sync(projection, roots, 0);
    const z1 = roots.map((resident) => earthTileChildren(resident.key)).flat();
    tiles.sync(projection, roots.concat(residents(z1, roots.length)), 250);
    const frontier = tiles.frontier.map((tile) => tile.key);
    assert.equal(frontier.filter((key) => key.z === EARTH_TILE_MIN_Z).length, 508);
    assert.equal(frontier.filter((key) => key.z === EARTH_TILE_MIN_Z + 1).length, 16);
    assertBalanced(frontier);
  });

  test('earth tiles: 交錯するpriorityでも候補は親group単位で連続する', () => {
    const tiles = new EarthSurfaceTiles();
    const projection = new InterleavedGroupProjection();
    const roots = residents(ROOTS);
    tiles.sync(projection, roots, 0);
    tiles.sync(projection, roots, 250);

    const candidates = tiles.requestCandidates(projection);
    assert.equal(candidates.length, 8);
    for (let offset = 0; offset < candidates.length; offset += 4) {
      const parents = new Set(candidates.slice(offset, offset + 4)
        .map((key) => earthTileId(earthTileParent(key)!)));
      assert.equal(parents.size, 1);
    }
    assert.deepEqual(candidates.map((key) => earthTileId(key)), [
      ...earthTileChildren(ROOTS[0]!).map(earthTileId).sort(),
      ...earthTileChildren(ROOTS[1]!).map(earthTileId).sort(),
    ]);
  });

  test('earth tiles: 2:1に必要な隣接子がなければ親を維持する', () => {
    const tiles = new EarthSurfaceTiles();
    const projection = new SelectiveProjection([ROOTS[0]!]);
    const roots = residents(ROOTS);
    tiles.sync(projection, roots, 0);
    const firstChildren = earthTileChildren(ROOTS[0]!);
    tiles.sync(projection, roots.concat(residents(firstChildren, 2)), 250);

    const target = firstChildren[0]!;
    projection.setActive([target]);
    const targetChildren = earthTileChildren(target);
    tiles.sync(projection, roots.concat(residents(firstChildren, 2), residents(targetChildren, 10)), 500);
    const frontier = tiles.frontier.map((tile) => tile.key);
    assert.ok(frontier.some((key) => earthTileId(key) === earthTileId(target)));
    assert.ok(frontier.every((key) => key.z <= EARTH_TILE_MIN_Z + 1));
    assertBalanced(frontier);
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
    assert.equal(projection.evaluate(earthTileKey(EARTH_TILE_MIN_Z, 15, 4)).visible, true);
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
    assert.deepEqual(earthPageAt(tiles.pageTable(), 0.01, 0.01), [2, 0, EARTH_TILE_MIN_Z + 1, 0]);
    tiles.sync(projection, roots.concat(children), 525);
    const halfway = earthPageAt(tiles.pageTable(), 0.01, 0.01);
    assert.deepEqual(halfway.slice(0, 3), [2, 0, EARTH_TILE_MIN_Z + 1]);
    assert.ok(halfway[3]! > 0 && halfway[3]! < 255);
    tiles.sync(projection, roots.concat(children), 650);
    assert.equal(earthPageAt(tiles.pageTable(), 0.1, 0.1)[3], 255);

    // 1..2pxの帯では分割状態を保ち、統合の途中は子/親を逆向きに混ぜる。
    projection.rootError = 1.5;
    tiles.sync(projection, roots.concat(children), 700);
    assert.equal(earthPageAt(tiles.pageTable(), 0.01, 0.01)[2], EARTH_TILE_MIN_Z + 1);
    projection.rootError = 0.5;
    tiles.sync(projection, roots.concat(children), 800);
    tiles.sync(projection, roots.concat(children), 925);
    assert.deepEqual(earthPageAt(tiles.pageTable(), 0.01, 0.01), halfway);
    tiles.sync(projection, roots.concat(children), 1050);
    assert.deepEqual(earthPageAt(tiles.pageTable(), 0.01, 0.01), [0, EARTH_BASE_LAYER, EARTH_TILE_MIN_Z, 255]);
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
    assert.deepEqual(earthPageAt(leafReuse.pageTable(), 0.01, 0.01), [EARTH_BASE_LAYER, EARTH_BASE_LAYER, EARTH_BASE_LAYER, 255]);

    const parentReuse = new EarthSurfaceTiles();
    parentReuse.sync(projection, roots, 0);
    parentReuse.sync(projection, roots, 250);
    parentReuse.sync(projection, roots.concat(children), 400);
    const reusedParent = { key: earthTileKey(EARTH_TILE_MIN_Z + 1, 2, 0), layer: roots[0]!.layer };
    parentReuse.sync(projection, [roots[1]!, ...children, reusedParent], 450);
    const page = earthPageAt(parentReuse.pageTable(), 0.01, 0.01);
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
