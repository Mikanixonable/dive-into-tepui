// 模式図スタイルの地表へ貼る線(海岸線・海/クレーターの輪郭など)。頂点はモデル座標(+Y が
// 自転軸、+Z が本初子午線)で、半径 1 の球面の SURFACE_LINE_RADIUS_RATIO 倍に置く。同じ頂点
// データから起こした geometry は共有する。
import * as THREE from 'three/webgpu';
import { markOverlay } from '../pipeline/lit-layer';
import { latLonPoint, pushSegment } from './body-graticule';
import { SCHEMATIC_LINE, SURFACE_LINE_RADIUS_RATIO } from '../schematic-style';

// 緯度・経度 [deg] のペアを1本の折れ線として並べた頂点列。
export type LatLonPolyline = readonly (readonly [number, number])[];

// 単位球面上の xyz を1ループとして並べた頂点列。
export type UnitSphereLoop = readonly (readonly [number, number, number])[];

// 地表へ貼る線の頂点データ。折れ線は隣接点どうしを繋ぎ、ループはさらに始点と終点も繋いで輪を閉じる。
export type SurfaceLines =
  | { readonly kind: 'latLonPolylines'; readonly polylines: readonly LatLonPolyline[] }
  | { readonly kind: 'unitSphereLoops'; readonly loops: readonly UnitSphereLoop[] };

// 1本の折れ線を、隣接点どうしのセグメントとして積む。
function pushPolyline(points: number[], polyline: LatLonPolyline): void {
  for (let i = 0; i + 1 < polyline.length; i++) {
    const [lat0, lon0] = polyline[i]!;
    const [lat1, lon1] = polyline[i + 1]!;
    pushSegment(
      points,
      latLonPoint(lat0, lon0, SURFACE_LINE_RADIUS_RATIO),
      latLonPoint(lat1, lon1, SURFACE_LINE_RADIUS_RATIO),
    );
  }
}

// 1本のループを、隣接点どうしのセグメントとして積む。終点から始点へ戻る1本も積み、輪を閉じる。
function pushLoop(points: number[], loop: UnitSphereLoop): void {
  for (let i = 0; i < loop.length; i++) {
    const [x0, y0, z0] = loop[i]!;
    const [x1, y1, z1] = loop[(i + 1) % loop.length]!;
    pushSegment(
      points,
      new THREE.Vector3(x0, y0, z0).multiplyScalar(SURFACE_LINE_RADIUS_RATIO),
      new THREE.Vector3(x1, y1, z1).multiplyScalar(SURFACE_LINE_RADIUS_RATIO),
    );
  }
}

// 頂点データ1つぶんの LineSegments 用 geometry を起こす。
function buildGeometry(lines: SurfaceLines): THREE.BufferGeometry {
  const points: number[] = [];
  if (lines.kind === 'latLonPolylines') {
    for (const polyline of lines.polylines) pushPolyline(points, polyline);
  } else {
    for (const loop of lines.loops) pushLoop(points, loop);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  return geometry;
}

// 起こした geometry の共有表。kind ごとに、頂点データの配列の同一性で引く。
const sharedGeometries: Record<SurfaceLines['kind'], WeakMap<object, THREE.BufferGeometry>> = {
  latLonPolylines: new WeakMap(),
  unitSphereLoops: new WeakMap(),
};

// 全天体で共有するマテリアル(色は定数で変化しないため使い回せる)。
let sharedMaterial: THREE.LineBasicMaterial | null = null;

// 頂点データに対応する geometry を共有表から引く。初回だけ起こして表へ載せる。
function sharedGeometry(lines: SurfaceLines): THREE.BufferGeometry {
  const cache = sharedGeometries[lines.kind];
  const vertices = lines.kind === 'latLonPolylines' ? lines.polylines : lines.loops;
  const cached = cache.get(vertices);
  if (cached !== undefined) return cached;
  const geometry = buildGeometry(lines);
  cache.set(vertices, geometry);
  return geometry;
}

// 共有マテリアルを引く。初回だけ生成する。
function surfaceLineMaterial(): THREE.LineBasicMaterial {
  if (sharedMaterial === null) sharedMaterial = new THREE.LineBasicMaterial({ color: SCHEMATIC_LINE });
  return sharedMaterial;
}

export class LineOverlay {
  private readonly line: THREE.LineSegments;

  // 渡された geometry と material で線を組み、3D UI パスのチャンネルへ置く。
  private constructor(geometry: THREE.BufferGeometry, material: THREE.LineBasicMaterial) {
    this.line = new THREE.LineSegments(geometry, material);
    markOverlay(this.line);
  }

  // 頂点データから天体1つぶんの地表ラインを起こす。同じ頂点データを渡せば geometry を共有する。
  public static of(lines: SurfaceLines): LineOverlay {
    return new LineOverlay(sharedGeometry(lines), surfaceLineMaterial());
  }

  // 天体の位置・スケール・自転姿勢を持つ group の子として置く。
  public addTo(parent: THREE.Object3D): void {
    parent.add(this.line);
  }

  // 線の表示・非表示を切り替える。
  public setVisible(visible: boolean): void {
    this.line.visible = visible;
  }

  // line を親から外す。共有の geometry・material は残す。
  public dispose(): void {
    this.line.removeFromParent();
  }
}
