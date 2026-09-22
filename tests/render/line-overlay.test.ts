// LineOverlay(render/celestial/line-overlay.ts)の回帰テスト。頂点データの形ごとの繋ぎ方
// (折れ線は隣接点どうし、ループは始点と終点も繋いで閉じる)、頂点が地表から浮く球面に載ること、
// 同じ頂点データが geometry を共有することを見る。期待値の正本は、閉じた輪と開いた折れ線の
// セグメント数という数え上げと、半径オフセットの定義で、線の形そのものは固定しない。
import * as assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { test } from '../harness';
import { LineOverlay, type LatLonPolyline, type UnitSphereLoop } from '../../src/render/celestial/line-overlay';
import { SURFACE_LINE_RADIUS_RATIO } from '../../src/render/schematic-style';

// 開いた折れ線2本(頂点 4 個と 3 個)。極や日付変更線をまたぐ点を混ぜ、緯度経度の全域を使う。
const POLYLINES: readonly LatLonPolyline[] = [
  [[0, 0], [35, 139], [-33, -70], [80, 179]],
  [[-90, 0], [0, 90], [90, 0]],
];

// 折れ線を1本だけ持つ別のデータ。共有表が頂点データごとに分かれていることを見るために使う。
const OTHER_POLYLINES: readonly LatLonPolyline[] = [
  [[10, 20], [11, 21]],
];

// 緯度 30° の緯線を 5 分割した閉ループ1本。単位球面上の点として与える。
const LOOPS: readonly UnitSphereLoop[] = [
  [0, 1, 2, 3, 4].map((i) => {
    const lonRad = (2 * Math.PI * i) / 5;
    const latRad = Math.PI / 6;
    const c = Math.cos(latRad);
    return [c * Math.sin(lonRad), Math.sin(latRad), c * Math.cos(lonRad)] as const;
  }),
];

// overlay が親へ足した LineSegments の geometry を取り出す。
function geometryOf(overlay: LineOverlay): THREE.BufferGeometry {
  const parent = new THREE.Object3D();
  overlay.addTo(parent);
  const line = parent.children[0];
  if (!(line instanceof THREE.LineSegments)) throw new Error('LineOverlay が LineSegments を足していない');
  return line.geometry;
}

// LineSegments は頂点2個で1本を描くので、セグメント数は頂点数の半分。
function segmentCount(geometry: THREE.BufferGeometry): number {
  return geometry.getAttribute('position').count / 2;
}

// 全頂点が半径 SURFACE_LINE_RADIUS_RATIO の球面に載っていることを確かめる。
function assertOnOffsetSphere(geometry: THREE.BufferGeometry): void {
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const radius = Math.hypot(position.getX(i), position.getY(i), position.getZ(i));
    assert.ok(
      Math.abs(radius - SURFACE_LINE_RADIUS_RATIO) < 1e-6,
      `頂点 ${i} が地表オフセットの球面から外れている (${radius})`,
    );
  }
}

export function register(): void {
  test('line-overlay: 折れ線は開いたまま隣接点どうしを繋ぐ', () => {
    const geometry = geometryOf(LineOverlay.of({ kind: 'latLonPolylines', polylines: POLYLINES }));
    const expected = POLYLINES.reduce((sum, polyline) => sum + polyline.length - 1, 0);
    assert.equal(segmentCount(geometry), expected, '折れ線の端どうしが繋がっている');
  });

  test('line-overlay: ループは始点と終点も繋いで閉じる', () => {
    const geometry = geometryOf(LineOverlay.of({ kind: 'unitSphereLoops', loops: LOOPS }));
    const expected = LOOPS.reduce((sum, loop) => sum + loop.length, 0);
    assert.equal(segmentCount(geometry), expected, 'ループが閉じていない');
  });

  test('line-overlay: 頂点は地表から浮かせた球面に載る', () => {
    assertOnOffsetSphere(geometryOf(LineOverlay.of({ kind: 'latLonPolylines', polylines: POLYLINES })));
    assertOnOffsetSphere(geometryOf(LineOverlay.of({ kind: 'unitSphereLoops', loops: LOOPS })));
  });

  test('line-overlay: 同じ頂点データは geometry を共有し、違う頂点データは共有しない', () => {
    const first = geometryOf(LineOverlay.of({ kind: 'latLonPolylines', polylines: POLYLINES }));
    const again = geometryOf(LineOverlay.of({ kind: 'latLonPolylines', polylines: POLYLINES }));
    assert.equal(again, first, '同じ頂点データから geometry を組み直している');

    const other = geometryOf(LineOverlay.of({ kind: 'latLonPolylines', polylines: OTHER_POLYLINES }));
    assert.notEqual(other, first, '違う頂点データが同じ geometry を引いている');

    const loops = geometryOf(LineOverlay.of({ kind: 'unitSphereLoops', loops: LOOPS }));
    assert.notEqual(loops, first, '形の違う頂点データが同じ geometry を引いている');
  });
}
