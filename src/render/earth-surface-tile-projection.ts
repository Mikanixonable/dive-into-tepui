// タイルの投影評価を担当する。LOD状態そのものは所有しない。
import * as THREE from 'three/webgpu';
import { earthPositionAtUv, validateEarthAxes } from './earth-surface-coordinate';
import { EARTH_TILE_TEXELS, type EarthTileKey } from './earth-surface-tile-key';

export interface EarthTileMetric {
  readonly visible: boolean;
  readonly errorPx: number;
  readonly priority: number;
}

export interface EarthTileProjection {
  evaluate(key: EarthTileKey): EarthTileMetric;
}

export class EarthSurfaceView implements EarthTileProjection {
  private readonly axes: THREE.Vector3;
  private readonly bodyToView: THREE.Matrix4;
  private readonly projection: THREE.Matrix4;
  private readonly frustum: THREE.Frustum;
  private readonly eyeScaled: THREE.Vector3;
  private readonly observerDirection: THREE.Vector3;
  private readonly perspective: boolean;
  private readonly near: number;

  // earthToWorldは浮動原点補正済みの剛体変換。幅・高さは実drawing bufferの画素数。
  public constructor(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera, earthToWorld: THREE.Matrix4,
    axes: THREE.Vector3, private readonly width: number, private readonly height: number,
  ) {
    validateEarthAxes(axes);
    if (!(width > 0 && height > 0)) throw new RangeError('Invalid Earth viewport');
    this.axes = axes.clone();
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
    const center = earthPositionAtUv((key.x + 0.5) / columns, (key.y + 0.5) / rows, this.axes);
    const maxAxis = Math.max(this.axes.x, this.axes.y, this.axes.z);
    const minAxis = Math.min(this.axes.x, this.axes.y, this.axes.z);
    // 正規化したA*nの角変化は、nの角変化のaMax/aMin倍以内に収まる。
    const angle = Math.min(Math.PI, maxAxis / minAxis * (Math.PI / columns + Math.PI / (2 * rows)));
    const cap = center.clone().divide(this.axes).normalize();
    const observer = this.perspective ? this.eyeScaled : this.observerDirection;
    const separation = cap.angleTo(observer);
    const horizon = Math.cos(Math.max(0, separation - angle)) * observer.length();
    const sphere = new THREE.Sphere(center, 2 * maxAxis * Math.sin(angle / 2));
    if (horizon < (this.perspective ? 1 : 0) || !this.frustum.intersectsSphere(sphere)) {
      return { visible: false, errorPx: 0, priority: 0 };
    }

    // 経度はこの格子のまま連続的に進め、半周幅の根でも中央を含めて辺を測る。
    const points: THREE.Vector2[][] = [];
    for (let y = 0; y <= 2; y++) {
      const row: THREE.Vector2[] = [];
      for (let x = 0; x <= 2; x++) {
        const position = earthPositionAtUv((key.x + x / 2) / columns, (key.y + y / 2) / rows, this.axes)
          .applyMatrix4(this.bodyToView);
        if (this.perspective && -position.z <= this.near) {
          return { visible: true, errorPx: Infinity, priority: Infinity };
        }
        position.applyMatrix4(this.projection);
        row.push(new THREE.Vector2(position.x * this.width / 2, position.y * this.height / 2));
      }
      points.push(row);
    }
    const at = (x: number, y: number): THREE.Vector2 => points[y]![x]!;
    let maxEdge = 0;
    for (let index = 0; index <= 2; index++) {
      maxEdge = Math.max(maxEdge,
        at(0, index).distanceTo(at(1, index)) + at(1, index).distanceTo(at(2, index)),
        at(index, 0).distanceTo(at(index, 1)) + at(index, 1).distanceTo(at(index, 2)));
    }
    const bounds = new THREE.Box2().setFromPoints(points.flat());
    const area = bounds.getSize(new THREE.Vector2());
    const errorPx = maxEdge / EARTH_TILE_TEXELS;
    const centerDistance = at(1, 1).length() / Math.max(this.width, this.height);
    return { visible: true, errorPx, priority: errorPx * area.x * area.y / (1 + centerDistance) };
  }
}
