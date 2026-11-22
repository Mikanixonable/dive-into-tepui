// タイルの投影評価を担当する。LOD状態そのものは所有しない。
import * as THREE from 'three/webgpu';
import { validateEarthAxes, writeEarthPositionAtUv } from './coordinate';
import { EARTH_TILE_TEXELS, type EarthTileKey } from './tile-key';

export interface EarthTileMetric {
  readonly visible: boolean;
  readonly errorPx: number;
  readonly priority: number;
}

export interface EarthTileProjection {
  evaluate(key: EarthTileKey): EarthTileMetric;
}

// 画面へ写らない区画の評価。
const INVISIBLE: EarthTileMetric = { visible: false, errorPx: 0, priority: 0 };
// 近平面を跨ぐ区画の評価。必ず分割させ、最優先で要求させる。
const CROSSES_NEAR: EarthTileMetric = { visible: true, errorPx: Infinity, priority: Infinity };
// 区画の東西・南北を 2 等分した格子の 1 辺の点数。
const GRID = 3;

export class EarthSurfaceView implements EarthTileProjection {
  private readonly axes: THREE.Vector3;
  private readonly bodyToView: THREE.Matrix4;
  private readonly projection: THREE.Matrix4;
  private readonly frustum: THREE.Frustum;
  private readonly eyeScaled: THREE.Vector3;
  private readonly observerDirection: THREE.Vector3;
  private readonly perspective: boolean;
  private readonly near: number;
  // 半軸の長短比。区画の角の広がりを楕円体の歪みぶん広げる。
  private readonly axisRatio: number;
  private readonly maxAxis: number;
  // evaluate の作業領域。評価は1つずつ行うので共有してよい。
  private readonly center = new THREE.Vector3();
  private readonly cap = new THREE.Vector3();
  private readonly sphere = new THREE.Sphere();
  private readonly position = new THREE.Vector3();
  private readonly points: readonly THREE.Vector2[] = Array.from({ length: GRID * GRID }, () => new THREE.Vector2());

  // earthToWorldは浮動原点補正済みの剛体変換。幅・高さは実drawing bufferの画素数。
  public constructor(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, earthToWorld: THREE.Matrix4,
    axes: THREE.Vector3, private readonly width: number, private readonly height: number,
  ) {
    validateEarthAxes(axes);
    if (!(width > 0 && height > 0)) throw new RangeError('Invalid Earth viewport');
    this.axes = axes.clone();
    this.maxAxis = Math.max(axes.x, axes.y, axes.z);
    this.axisRatio = this.maxAxis / Math.min(axes.x, axes.y, axes.z);
    this.bodyToView = camera.matrixWorldInverse.clone().multiply(earthToWorld);
    this.projection = camera.projectionMatrix.clone();
    this.frustum = new THREE.Frustum().setFromProjectionMatrix(
      this.projection.clone().multiply(this.bodyToView), camera.coordinateSystem, camera.reversedDepth,
    );
    // 地平線判定は楕円体を単位球へ写した座標で行う。
    const viewToBody = this.bodyToView.clone().invert();
    this.eyeScaled = new THREE.Vector3().applyMatrix4(viewToBody).divide(axes);
    this.observerDirection = new THREE.Vector3(0, 0, 1).transformDirection(viewToBody).divide(axes).normalize();
    this.perspective = camera instanceof THREE.PerspectiveCamera;
    this.near = camera.near;
  }

  // 完全に不可視の区画を除き、画面上の東西・南北の最大辺長から1texelの誤差を返す。
  public evaluate(key: EarthTileKey): EarthTileMetric {
    const columns = 2 ** (key.z + 1);
    const rows = 2 ** key.z;
    const center = writeEarthPositionAtUv(this.center, (key.x + 0.5) / columns, (key.y + 0.5) / rows, this.axes);
    // 正規化したA*nの角変化は、nの角変化のaMax/aMin倍以内に収まる。
    const angle = Math.min(Math.PI, this.axisRatio * (Math.PI / columns + Math.PI / (2 * rows)));
    const cap = this.cap.copy(center).divide(this.axes).normalize();
    const observer = this.perspective ? this.eyeScaled : this.observerDirection;
    const separation = cap.angleTo(observer);
    const horizon = Math.cos(Math.max(0, separation - angle)) * observer.length();
    this.sphere.center.copy(center);
    this.sphere.radius = 2 * this.maxAxis * Math.sin(angle / 2);
    if (horizon < (this.perspective ? 1 : 0) || !this.frustum.intersectsSphere(this.sphere)) return INVISIBLE;

    // 経度はこの格子のまま連続的に進め、半周幅の根でも中央を含めて辺を測る。
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        const position = writeEarthPositionAtUv(
          this.position, (key.x + x / 2) / columns, (key.y + y / 2) / rows, this.axes,
        ).applyMatrix4(this.bodyToView);
        if (this.perspective && -position.z <= this.near) return CROSSES_NEAR;
        position.applyMatrix4(this.projection);
        this.points[y * GRID + x]!.set(position.x * this.width / 2, position.y * this.height / 2);
      }
    }
    const at = (x: number, y: number): THREE.Vector2 => this.points[y * GRID + x]!;
    let maxEdge = 0;
    for (let index = 0; index < GRID; index++) {
      maxEdge = Math.max(maxEdge,
        at(0, index).distanceTo(at(1, index)) + at(1, index).distanceTo(at(2, index)),
        at(index, 0).distanceTo(at(index, 1)) + at(index, 1).distanceTo(at(index, 2)));
    }
    // 格子の画面上の外接矩形の面積で優先度を重み付ける。
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of this.points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
    const errorPx = maxEdge / EARTH_TILE_TEXELS;
    const centerDistance = at(1, 1).length() / Math.max(this.width, this.height);
    return { visible: true, errorPx, priority: errorPx * (maxX - minX) * (maxY - minY) / (1 + centerDistance) };
  }
}
