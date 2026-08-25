// 模式図スタイルの地球へ貼る海岸線。データは src/assets/earth-coastline.json
// (tools/export-coastline.mjs が Natural Earth 110m coastline から焼き込む、緯度・経度 [deg]
// のペアを1本の折れ線として並べた配列の配列)。頂点は body-graticule.ts と同じモデル座標規約
// (+Y が自転軸、+Z が本初子午線)で、半径 1 の球面から SURFACE_LINE_RADIUS_RATIO 倍だけ外側に置く。
import * as THREE from 'three/webgpu';
import { LineOverlay } from './line-overlay';
import { latLonPoint, pushSegment } from './body-graticule';
import { SCHEMATIC_LINE, SURFACE_LINE_RADIUS_RATIO } from './schematic-style';
import coastlineData from '../assets/earth-coastline.json';

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
      latLonPoint(lat0, lon0, SURFACE_LINE_RADIUS_RATIO),
      latLonPoint(lat1, lon1, SURFACE_LINE_RADIUS_RATIO),
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

// 地球1つぶんの海岸線。
export class EarthCoastline extends LineOverlay {
  constructor() {
    super(coastlineGeometry(), coastlineMaterial());
  }
}
