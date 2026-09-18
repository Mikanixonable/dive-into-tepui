// 保存されたカメラ視点と進行の瞬間値から、1フレームの論理視点を導出する。
import { add, len, scale, sub, type Vec3, v3 } from '../../math/vec3';
import { LOCAL_FORWARD, LOCAL_UP, qRotate } from '../../math/quat';
import type { Viewpoint } from '../../math/projection';
import { frameDir, toInertialDir } from '../../physics/frame';
import { strongestAttractor } from '../../physics/attractor';
import { ECI_POLE, ECL_POLE_ECI } from '../../physics/ecliptic';
import type { CelestialBody } from '../../physics/celestial-body';
import type { Viewport } from '../../render/viewport';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { CameraFrameSample, FocusCameraSource } from '../viewer/focus-camera-selection';
import type { FocusTarget } from '../viewer/focus-target';
import { resolveFocusTarget, type FocusCandidate } from './focus-derivation';

export type CameraRigSource = Pick<
  FocusCameraSource,
  | 'focus'
  | 'focusLossPolicy'
  | 'distance'
  | 'pan'
  | 'cameraFrame'
  | 'rotation'
  | 'projection'
  | 'orthographicHalfHeight'
  | 'fov'
>;

export class CameraRig {
  private trackedFocus: FocusTarget | null = null;
  private missingFocusFrames = 0;
  private lastResolvedFocus = v3();
  private _focusVelocity: Vec3 | null = null;
  private _lostFocus: FocusTarget | null = null;
  private _viewpoint: Viewpoint = {
    position: v3(),
    lookTarget: v3(),
    up: v3(0, 1, 0),
    fovDeg: 50,
    aspect: 1,
    projection: 'perspective',
  };

  public get viewpoint(): Viewpoint { return this._viewpoint; }
  public get focusVelocity(): Vec3 | null { return this._focusVelocity; }
  public get resolvedFocus(): Vec3 { return this.lastResolvedFocus; }
  public get lostFocus(): FocusTarget | null { return this._lostFocus; }

  public constructor(private readonly celestialBodies: CelestialBodies) {}

  // 現在のカメラ位置に応じたオイラー極・ロールリセットの上方向を返す。
  public referenceUp(sample: Pick<CameraFrameSample, 'displayTime' | 'frameAnchors'>): Vec3 {
    if (sample.frameAnchors.bodies.length > 0) {
      const cameraPos = this._viewpoint.position;
      const pivot = sample.frameAnchors.bodiesPivot;
      const nearest = strongestAttractor(cameraPos, sample.frameAnchors.bodies, pivot);
      const distToBody = len(sub(cameraPos, nearest.positionAt(pivot)));
      const planetaryScaleThreshold = 1e9; // 天体近傍とみなす距離 [m]
      const nearestBody = this.celestialBodies.findMotion(nearest.id);
      if (distToBody <= planetaryScaleThreshold && nearestBody !== null) {
        return nearestBody.orientationAt(sample.displayTime)?.axis ?? ECI_POLE;
      }
    }
    return ECL_POLE_ECI;
  }

  // 注視点・パン・向きを表示時刻へ解決し、このフレームの Viewpoint を作る。
  public update(
    source: CameraRigSource,
    sample: CameraFrameSample,
    candidates: readonly FocusCandidate[],
    viewport: Pick<Viewport, 'width' | 'height'>,
  ): void {
    if (this.trackedFocus !== source.focus) {
      this.trackedFocus = source.focus;
      this.missingFocusFrames = 0;
      this._lostFocus = null;
    }
    const result = resolveFocusTarget(
      source.focus,
      candidates,
      sample.displayTime,
      sample.frameAnchors,
      this.celestialBodies.frames,
      this.celestialMotionOf,
      (id, t) => this.celestialBodies.stateAt(id, t),
      { missingFocusFrames: this.missingFocusFrames, lastResolvedFocus: this.lastResolvedFocus },
    );
    this.missingFocusFrames = result.missingFocusFrames;
    this.lastResolvedFocus = result.lastResolvedFocus;
    this._focusVelocity = result.vel;
    this._lostFocus = result.lost ? source.focus : null;
    // 原点へ戻す対象を見失ったフレームは、パンも戻した原点を見る。
    const fallen = result.lost && source.focusLossPolicy === 'fallToOrigin';

    const transform = this.celestialBodies.frames.transformAt(
      source.cameraFrame, sample.displayTime, sample.frameAnchors,
    );
    const panEci = toInertialDir(transform, source.pan);
    const offsetFrame = qRotate(source.rotation, LOCAL_FORWARD);
    const upFrame = qRotate(source.rotation, LOCAL_UP);
    const offsetDirection = toInertialDir(
      transform,
      frameDir(offsetFrame.x, offsetFrame.y, offsetFrame.z),
    );
    const up = toInertialDir(transform, frameDir(upFrame.x, upFrame.y, upFrame.z));
    const lookTarget = fallen ? v3() : add(result.pos, panEci);
    this._viewpoint = {
      position: add(lookTarget, scale(offsetDirection, source.distance)),
      lookTarget,
      up,
      fovDeg: source.fov,
      aspect: viewport.width / viewport.height,
      projection: source.projection,
      orthographicHalfHeight: source.orthographicHalfHeight,
    };
  }

  // 登録天体の運動を返し、それ以外の id には null を返す。
  private readonly celestialMotionOf = (id: string): CelestialBody | null => (
    this.celestialBodies.findMotion(id) ?? null
  );
}
