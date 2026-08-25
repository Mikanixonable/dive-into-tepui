// 模式図スタイルの地球へ貼る海岸線。データは src/assets/earth-coastline.json
// (tools/export-coastline.mjs が Natural Earth 110m coastline から焼き込む、緯度・経度 [deg]
// のペアを1本の折れ線として並べた配列の配列)。頂点は body-graticule.ts と同じモデル座標規約
// (+Y が自転軸、+Z が本初子午線)で、半径 1 の球面から COASTLINE_RADIUS_RATIO 倍だけ外側に置く。
import * as THREE from 'three/webgpu';
import { markOverlay } from './pipeline/lit-layer';
import { latLonPoint, pushSegment } from './body-graticule';
import { SCHEMATIC_LINE } from './schematic-style';
import coastlineData from '../assets/earth-coastline.json';

// 経緯度グリッド(1.002)より内側に置き、グリッドと重なって Z-fighting しないようにする。
const COASTLINE_RADIUS_RATIO = 1.0015;

let sharedGeometry: THREE.BufferGeometry | null = null;
let sharedMaterial: THREE.LineBasicMaterial | null = null;

type LatLon = readonly [number, number];

// 1本の折れ線ぶんの頂点(緯度経度ペアの列)を、隣接点どうしのセグメントとして積む。
function pushLine(points: number[], line: readonly LatLon[]): void {
  for (let i = 0; i + 1 < line.length; i++) {
    const [lat0, lon0] = line[i]!;
    const [lat1, lon1] = line[i + 1]!;
    pushSegment(
      points,
      latLonPoint(lat0, lon0, COASTLINE_RADIUS_RATIO),
      latLonPoint(lat1, lon1, COASTLINE_RADIUS_RATIO),
    );
  }
}

function buildGeometry(): THREE.BufferGeometry {
  const points: number[] = [];
  for (const line of coastlineData as unknown as readonly LatLon[][]) pushLine(points, line);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  return geometry;
}

function coastlineGeometry(): THREE.BufferGeometry {
  if (sharedGeometry === null) sharedGeometry = buildGeometry();
  return sharedGeometry;
}

function coastlineMaterial(): THREE.LineBasicMaterial {
  if (sharedMaterial === null) sharedMaterial = new THREE.LineBasicMaterial({ color: SCHEMATIC_LINE });
  return sharedMaterial;
}

// 地球1つぶんの海岸線。ジオメトリ・マテリアルは(地球は1つしかないが)経緯度グリッドと
// 同じ構成に揃えるため共有として持つ。
export class EarthCoastline {
  private readonly line: THREE.LineSegments;

  constructor() {
    this.line = new THREE.LineSegments(coastlineGeometry(), coastlineMaterial());
    markOverlay(this.line);
  }

  // 地球の姿勢を持つ group の子として置く。位置・スケール・自転姿勢は親から自動で継承する。
  addTo(parent: THREE.Object3D): void {
    parent.add(this.line);
  }

  setVisible(visible: boolean): void {
    this.line.visible = visible;
  }

  dispose(): void {
    this.line.removeFromParent();
  }
}
