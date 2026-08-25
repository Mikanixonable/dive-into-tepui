// 模式図スタイルで天体へ貼る経緯度グリッド線。頂点は自転前のモデル座標(+Y が自転軸、+Z が
// 本初子午線 — celestial-surface.ts と同じ規約)で、半径 1 の球面から GRATICULE_RADIUS_RATIO
// 倍だけ外側に置く。天体ごとの group(位置・スケール・自転姿勢を毎フレーム与える親)の子として
// 置けば、姿勢の再計算をせずそのまま自転へ追従する。
import * as THREE from 'three/webgpu';
import { markOverlay } from './pipeline/lit-layer';
import {
  GRATICULE_STEP_DEG, GRATICULE_COLOR, GRATICULE_OPACITY, GRATICULE_RADIUS_RATIO,
} from './schematic-style';

// 球のシルエットが1px未満の誤差で見えるのに十分な、円1本あたりの分割数。
const CIRCLE_SEGMENTS = 128;

// 全天体で共有する経緯線のジオメトリとマテリアル(色・不透明度は定数で変化しないため
// 使い回せる)。celestial-surface.ts の sharedLodGeometries と同じく遅延生成し、解放しない。
let sharedGeometry: THREE.BufferGeometry | null = null;
let sharedMaterial: THREE.LineBasicMaterial | null = null;

// 緯度・経度から、半径 GRATICULE_RADIUS_RATIO の球面上の点(モデル座標)を返す。
function latLonPoint(latDeg: number, lonDeg: number): THREE.Vector3 {
  const latRad = (latDeg * Math.PI) / 180;
  const lonRad = (lonDeg * Math.PI) / 180;
  const c = GRATICULE_RADIUS_RATIO * Math.cos(latRad);
  return new THREE.Vector3(
    c * Math.sin(lonRad), GRATICULE_RADIUS_RATIO * Math.sin(latRad), c * Math.cos(lonRad));
}

// 2点ぶんの座標を LineSegments 用の頂点配列へ追記する。
function pushSegment(points: number[], a: THREE.Vector3, b: THREE.Vector3): void {
  points.push(a.x, a.y, a.z, b.x, b.y, b.z);
}

// 経線1本(極から極まで)を、隣接点どうしのセグメントの列として積む。
function pushMeridian(points: number[], lonDeg: number): void {
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const lat0 = -90 + (180 * i) / CIRCLE_SEGMENTS;
    const lat1 = -90 + (180 * (i + 1)) / CIRCLE_SEGMENTS;
    pushSegment(points, latLonPoint(lat0, lonDeg), latLonPoint(lat1, lonDeg));
  }
}

// 緯線1本(全周)を、隣接点どうしのセグメントの列として積む。ループ状の線は描画基盤が扱えない
// ため(rendering-workflow SKILL 参照)、始点と終点が一致する開いた折れ線として組む。
function pushParallel(points: number[], latDeg: number): void {
  for (let i = 0; i < CIRCLE_SEGMENTS; i++) {
    const lon0 = (360 * i) / CIRCLE_SEGMENTS;
    const lon1 = (360 * (i + 1)) / CIRCLE_SEGMENTS;
    pushSegment(points, latLonPoint(latDeg, lon0), latLonPoint(latDeg, lon1));
  }
}

// 経線24本(経度15°刻み)・緯線11本(緯度15°刻み、両極を除く)ぶんのセグメントを1つの
// バッファへ詰める。
function buildGeometry(): THREE.BufferGeometry {
  const points: number[] = [];
  for (let lonDeg = 0; lonDeg < 360; lonDeg += GRATICULE_STEP_DEG) pushMeridian(points, lonDeg);
  for (let latDeg = -90 + GRATICULE_STEP_DEG; latDeg < 90; latDeg += GRATICULE_STEP_DEG) {
    pushParallel(points, latDeg);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
  return geometry;
}

// 共有ジオメトリを遅延生成して返す。
function graticuleGeometry(): THREE.BufferGeometry {
  if (sharedGeometry === null) sharedGeometry = buildGeometry();
  return sharedGeometry;
}

// 共有マテリアルを遅延生成して返す。
function graticuleMaterial(): THREE.LineBasicMaterial {
  if (sharedMaterial === null) {
    sharedMaterial = new THREE.LineBasicMaterial({
      color: GRATICULE_COLOR, transparent: true, opacity: GRATICULE_OPACITY, depthWrite: false,
    });
  }
  return sharedMaterial;
}

// 天体1つぶんの経緯度グリッド線。ジオメトリ・マテリアルは全天体で共有し、
// この THREE.LineSegments だけを天体ごとに持つ。
export class BodyGraticule {
  private readonly line: THREE.LineSegments;

  // 共有ジオメトリ・共有マテリアルを参照する線オブジェクトを1つ作る。
  constructor() {
    this.line = new THREE.LineSegments(graticuleGeometry(), graticuleMaterial());
    markOverlay(this.line);
  }

  // 天体の姿勢を持つ group の子として置く。位置・スケール・自転姿勢は親から自動で継承する。
  addTo(parent: THREE.Object3D): void {
    parent.add(this.line);
  }

  // グリッドの表示・非表示を切り替える。
  setVisible(visible: boolean): void {
    this.line.visible = visible;
  }

  // line を親から外す。ジオメトリ・マテリアルは全天体で共有しているため解放しない。
  dispose(): void {
    this.line.removeFromParent();
  }
}
