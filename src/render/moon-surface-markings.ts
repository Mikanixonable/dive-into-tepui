// 模式図スタイルの月へ貼る主要な海・クレーターの輪郭。データは src/assets/moon-features.json
// (tools/export-moon-features.mjs が assets-src/moon-features.json の中心緯度経度・直径から
// 円として焼き込む、単位球面上の xyz 頂点を1ループとして並べた配列の配列)。半径 1 の球面から
// SURFACE_LINE_RADIUS_RATIO 倍だけ外側に置く点は body-graticule.ts / earth-coastline.ts と同じ。
import * as THREE from 'three/webgpu';
import { LineOverlay } from './line-overlay';
import { pushSegment } from './body-graticule';
import { SCHEMATIC_LINE, SURFACE_LINE_RADIUS_RATIO } from './schematic-style';
import moonFeaturesData from '../assets/moon-features.json';

let sharedGeometry: THREE.BufferGeometry | null = null;
let sharedMaterial: THREE.LineBasicMaterial | null = null;

type Xyz = readonly [number, number, number];

// 1ループぶんの頂点(単位球面上の点列)を、隣接点どうしのセグメントとして積む。始点と終点も
// つなぎ、閉じた円にする。
function pushLoop(points: number[], loop: readonly Xyz[]): void {
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

function buildGeometry(): THREE.BufferGeometry {
  const points: number[] = [];
  for (const loop of moonFeaturesData as unknown as readonly Xyz[][]) pushLoop(points, loop);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  return geometry;
}

function moonFeaturesGeometry(): THREE.BufferGeometry {
  if (sharedGeometry === null) sharedGeometry = buildGeometry();
  return sharedGeometry;
}

function moonFeaturesMaterial(): THREE.LineBasicMaterial {
  if (sharedMaterial === null) sharedMaterial = new THREE.LineBasicMaterial({ color: SCHEMATIC_LINE });
  return sharedMaterial;
}

// 月1つぶんの海・クレーターの輪郭。
export class MoonSurfaceMarkings extends LineOverlay {
  constructor() {
    super(moonFeaturesGeometry(), moonFeaturesMaterial());
  }
}
