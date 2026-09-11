// EarthSurfaceViewの再構築条件と、フレーム間で保持する投影値を所有する。
import * as THREE from 'three/webgpu';
import type { CelestialSurfaceFrame } from './celestial/celestial-surface';
import { EarthSurfaceView } from './earth-surface-tile-projection';

const PROJECTION_REBUILD_INTERVAL_MS = 100;

export class EarthSurfaceProjectionCache {
  private projectionValue: EarthSurfaceView | null = null;
  private builtTimeMs: number | null = null;
  private cameraWorldValue: THREE.Matrix4 | null = null;
  private cameraViewValue: THREE.Matrix4 | null = null;
  private projectionMatrixValue: THREE.Matrix4 | null = null;
  private bodyToViewValue: THREE.Matrix4 | null = null;
  private axesValue: THREE.Vector3 | null = null;
  private viewportValue: { width: number; height: number } | null = null;
  private cameraTypeValue: 'perspective' | 'orthographic' | null = null;
  private coordinateSystemValue: number | null = null;
  private reversedDepthValue: boolean | null = null;

  public get(frame: CelestialSurfaceFrame): EarthSurfaceView {
    if (!(frame.camera instanceof THREE.PerspectiveCamera)
      && !(frame.camera instanceof THREE.OrthographicCamera)) {
      throw new Error('Earth surface projection requires a perspective or orthographic camera');
    }
    const cameraType = frame.camera instanceof THREE.PerspectiveCamera ? 'perspective' : 'orthographic';
    const projectionChanged = this.projectionValue === null
      || this.cameraViewValue === null
      || this.cameraWorldValue === null
      || !this.cameraWorldValue.equals(frame.camera.matrixWorld)
      || !this.cameraViewValue.equals(frame.camera.matrixWorldInverse)
      || this.projectionMatrixValue === null
      || !this.projectionMatrixValue.equals(frame.camera.projectionMatrix)
      || this.bodyToViewValue === null
      || !this.bodyToViewValue.equals(frame.bodyToView)
      || this.axesValue === null
      || !this.axesValue.equals(frame.axes)
      || this.viewportValue?.width !== frame.viewport.width
      || this.viewportValue?.height !== frame.viewport.height
      || this.cameraTypeValue !== cameraType
      || this.coordinateSystemValue !== frame.camera.coordinateSystem
      || this.reversedDepthValue !== frame.camera.reversedDepth;
    const timeRewound = this.builtTimeMs !== null && frame.timeMs < this.builtTimeMs;
    const rebuildWindowElapsed = this.builtTimeMs !== null
      && frame.timeMs - this.builtTimeMs >= PROJECTION_REBUILD_INTERVAL_MS;
    const rebuild = this.projectionValue === null
      || timeRewound || (projectionChanged && rebuildWindowElapsed);
    if (rebuild) {
      const bodyToWorld = frame.camera.matrixWorld.clone().multiply(frame.bodyToView);
      this.projectionValue = new EarthSurfaceView(
        frame.camera, bodyToWorld, frame.axes, frame.viewport.width, frame.viewport.height,
      );
      this.cameraWorldValue = frame.camera.matrixWorld.clone();
      this.cameraViewValue = frame.camera.matrixWorldInverse.clone();
      this.projectionMatrixValue = frame.camera.projectionMatrix.clone();
      this.bodyToViewValue = frame.bodyToView.clone();
      this.axesValue = frame.axes.clone();
      this.viewportValue = { width: frame.viewport.width, height: frame.viewport.height };
      this.cameraTypeValue = cameraType;
      this.coordinateSystemValue = frame.camera.coordinateSystem;
      this.reversedDepthValue = frame.camera.reversedDepth;
      this.builtTimeMs = frame.timeMs;
    }
    if (this.projectionValue === null) throw new Error('Earth surface projection is unavailable');
    return this.projectionValue;
  }

  public reset(): void {
    this.projectionValue = null;
    this.builtTimeMs = null;
    this.cameraWorldValue = null;
    this.cameraViewValue = null;
    this.projectionMatrixValue = null;
    this.bodyToViewValue = null;
    this.axesValue = null;
    this.viewportValue = null;
    this.cameraTypeValue = null;
    this.coordinateSystemValue = null;
    this.reversedDepthValue = null;
  }
}
