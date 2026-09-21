// 1台の注視カメラについて、直列化される視点とその変更規則を持つ。
import {
  LOCAL_FORWARD, LOCAL_RIGHT, LOCAL_UP, type Quat, qFromBasis, qRotate,
} from '../../math/quat';
import { sphericalOffset, type PolarEuler } from '../../math/polar-euler';
import { metersPerPixelAtDepth, tanHalfFov, type ProjectionMode } from '../../math/projection';
import {
  addScaled, cross, len, lenSq, norm, projectOntoPlane, scale, type SerializedVec3, type Vec3, v3,
} from '../../math/vec3';
import { ECI_POLE, ECL_POLE_ECI, ECL_VERNAL } from '../../physics/ecliptic';
import {
  type FrameAnchorSource,
  type FrameDir,
  type FrameRotationSource,
  type FrameTransform,
  type ReferenceFrame,
  frameDir,
  framePoint,
  rotationSourceKey,
  toFrameDir,
  toInertialDir,
} from '../../physics/frame';
import { OrbitingMotion } from '../../physics/celestial-motion';
import { CameraOrientation, type CameraRotationMode } from './camera-orientation';
import type { CelestialBodies } from '../celestial/celestial-bodies';
import type { RunEventSink } from '../run-events';
import type { FocusTarget, SerializedFocusTarget } from './focus-target';

const FOCUS_CAMERA_MIN_DIST = 1e3; // 天体フォーカス時の注視距離の下限 [m]
export const FOCUS_CAMERA_FOV_MIN = 15; // 最小垂直画角 [deg]
export const FOCUS_CAMERA_FOV_MAX = 120; // 最大垂直画角 [deg]
const FOCUS_CAMERA_MAX_DIST = 1e14; // 注視距離の上限 [m]
const ENTITY_MIN_DIST = 12; // 機体・固定点フォーカスでの最小注視距離 [m]
const FOCUS_CAMERA_FOV = 50; // 既定の垂直画角 [deg]
const STALE_FOLLOW_FRAMES_TO_DROP = 2; // 回転追従が成立しないフレームがこの数だけ続いたら外す

// 'attitude' はフォーカス機体の姿勢追従(対象は id でなくフォーカスから決まる)。
export type CameraRotationFollow = FrameRotationSource | { readonly kind: 'attitude' };
export type CameraReferencePlane = 'ecliptic' | 'equator' | 'moonOrbit';
export type CameraReferenceView = 'above' | 'side';

// offset・up の向きは、rotatingWith が姿勢追従なら対象姿勢からの相対値。
export interface SerializedFocusCameraSelection {
  readonly offset: SerializedVec3;
  readonly pan: SerializedVec3;
  readonly up: SerializedVec3;
  readonly rotatingWith: CameraRotationFollow | null;
  readonly focus: SerializedFocusTarget;
  readonly rotationMode: CameraRotationMode;
  readonly fovDeg: number;
  readonly referencePlane: CameraReferencePlane;
  readonly projectionMode: ProjectionMode;
  readonly orthographicHalfHeight: number;
  readonly staleFollowFrames: number;
  readonly focusReplaced: boolean;
}

// 入力の解釈が1フレーム分のカメラ操作へ換算した値。
export interface CameraInput {
  readonly zoomFactor: number;
  readonly dragRightRad: number;
  readonly dragUpRad: number;
  readonly rollRad: number;
  readonly keyYawRad: number;
  readonly keyPitchRad: number;
  readonly panDx: number;
  readonly panDy: number;
  readonly viewportHeight: number;
}

// 座標系に依存する視点命令と進行追従が読む、そのフレームの材料。
export interface CameraFrameSample {
  readonly displayTime: number;
  readonly frameAnchors: FrameAnchorSource;
  readonly attitude: Quat | null;
  readonly referenceUp: Vec3; // ECI
  readonly lostFocus: FocusTarget | null;
}

// 1台のカメラの視点を読む面。
export interface FocusCameraSource {
  readonly focus: FocusTarget;
  readonly focusLossPolicy: 'hold' | 'fallToOrigin';
  readonly distance: number;
  readonly pan: FrameDir;
  readonly cameraFrame: ReferenceFrame;
  readonly rotation: Quat;
  readonly rotationFollow: CameraRotationFollow | null;
  readonly cameraRotationMode: CameraRotationMode;
  readonly projection: ProjectionMode;
  readonly orthographicHalfHeight: number;
  readonly fov: number;
  readonly referencePlane: CameraReferencePlane;
  availableRotationFollows(sample: CameraFrameSample): readonly CameraRotationFollow[];
}

// 新しいゲームと視点のリセットで始める視点。
interface FocusCameraInitial {
  readonly angles: PolarEuler;
  readonly dist: number;
  readonly fovDeg: number;
  readonly focus: FocusTarget;
  readonly follow: CameraRotationFollow | null;
}

// ビューごとに固定の、カメラの既定の視点と規則。
export interface FocusCameraConfig {
  readonly view: 'combat' | 'map';
  // 注視対象を見失ったとき、注視を保つか原点天体へ戻すか。
  readonly focusLossPolicy: 'hold' | 'fallToOrigin';
  readonly initial: FocusCameraInitial;
  // オイラー操作の極軸を、基準の上方向と対象の姿勢のどちらから取るか。
  readonly eulerPole: 'reference' | 'attitude';
  // 視点のリセットで、初期値へ戻すか、視線を保って上方向とずらしだけを戻すか。
  readonly reset: 'initial' | 'orientation';
}

// 追従選択の同一性を表す安定キー。
export function rotationFollowKey(follow: CameraRotationFollow | null): string {
  if (follow === null) return '';
  return follow.kind === 'attitude' ? 'attitude' : rotationSourceKey(follow);
}

// 正射影の半高さ [m] を許容範囲へ収める。
function clampOrthographicHalfHeight(halfHeight: number): number {
  return Math.max(FOCUS_CAMERA_MIN_DIST * 1e-6, Math.min(FOCUS_CAMERA_MAX_DIST, halfHeight));
}

// 垂直画角 [deg] を許容範囲へ収める。有限でない値は既定へ落とす。
function clampFov(fovDeg: number): number {
  return Math.max(
    FOCUS_CAMERA_FOV_MIN,
    Math.min(FOCUS_CAMERA_FOV_MAX, Number.isFinite(fovDeg) ? fovDeg : FOCUS_CAMERA_FOV),
  );
}

// 座標系相対の方向を、成分そのままの Vec3 として読む。
function frameDirVector(value: FrameDir): Vec3 {
  return v3(value.x, value.y, value.z);
}

// 座標系 from で表した方向を、同じ瞬間の座標系 to で表し直す。
function reframeDir(from: FrameTransform, to: FrameTransform, d: Vec3): Vec3 {
  return frameDirVector(toFrameDir(to, toInertialDir(from, frameDir(d.x, d.y, d.z))));
}

export class FocusCameraSelection implements FocusCameraSource {
  private fovDeg: number;
  private _orthographicHalfHeight: number;
  private readonly orientation: CameraOrientation;
  private _cameraFrame: ReferenceFrame;

  public get focus(): FocusTarget { return this._focus; }
  public get focusLossPolicy(): 'hold' | 'fallToOrigin' { return this.config.focusLossPolicy; }
  public get distance(): number { return this._distance; }
  public get pan(): FrameDir { return this._pan; }
  public get cameraFrame(): ReferenceFrame { return this._cameraFrame; }
  public get rotation(): Quat { return this.orientation.effective(); }
  // いま追従しているもの。姿勢追従が最優先で、次に座標系の回転源、どちらも無ければ null。
  public get rotationFollow(): CameraRotationFollow | null {
    return this.orientation.followingAttitude ? { kind: 'attitude' } : this._cameraFrame.rotatingWith;
  }
  public get cameraRotationMode(): CameraRotationMode { return this.orientation.rotationMode; }
  public get projection(): ProjectionMode { return this.projectionMode; }
  public get orthographicHalfHeight(): number { return this._orthographicHalfHeight; }
  public get fov(): number { return this.fovDeg; }
  public get referencePlane(): CameraReferencePlane { return this._referencePlane; }

  // config のビューのカメラを、渡した視点から組む。省いた値はそのビューの既定の視点で補う。
  // rotation は rotationFollow が姿勢追従なら対象姿勢からの相対の向き、そうでなければ絶対の向き。
  public constructor(
    private readonly celestialBodies: CelestialBodies,
    private readonly config: FocusCameraConfig,
    private readonly events: RunEventSink,
    private _focus: FocusTarget = config.initial.focus,
    rotationFollow: CameraRotationFollow | null = config.initial.follow,
    private _distance = config.initial.dist,
    private _pan: FrameDir = frameDir(0, 0, 0),
    rotation: Quat = qFromBasis(sphericalOffset(config.initial.angles, 1), v3(0, 1, 0)),
    rotationMode: CameraRotationMode = 'euler',
    fovDeg = config.initial.fovDeg,
    private projectionMode: ProjectionMode = 'perspective',
    orthographicHalfHeight = _distance * tanHalfFov(clampFov(fovDeg)),
    private _referencePlane: CameraReferencePlane = 'equator',
    // 回転追従が成立しないまま続いたフレーム数。
    private staleFollowFrames = 0,
    // setFocus で差し替えた注視に、まだ回転追従の可否を当てていないか。
    private focusReplaced = false,
  ) {
    this._cameraFrame = this.frameFollowing(rotationFollow);
    this.orientation = new CameraOrientation(rotation, rotationMode, rotationFollow?.kind === 'attitude');
    this.fovDeg = clampFov(fovDeg);
    this._orthographicHalfHeight = clampOrthographicHalfHeight(orthographicHalfHeight);
  }

  // 直列化した視点から、config のビューのカメラを1台復元する。
  public static deserialize(
    serialized: SerializedFocusCameraSelection,
    celestialBodies: CelestialBodies,
    config: FocusCameraConfig,
    events: RunEventSink,
  ): FocusCameraSelection {
    const { offset, pan, up, focus, projectionMode, orthographicHalfHeight, referencePlane } = serialized;
    const offsetVector = v3(offset.x, offset.y, offset.z);
    return new FocusCameraSelection(
      celestialBodies,
      config,
      events,
      focus.kind === 'object'
        ? { kind: 'object', id: focus.id }
        : {
          kind: 'point',
          frame: celestialBodies.frames.frameOf(focus.center, focus.rotatingWith),
          point: framePoint(focus.point.x, focus.point.y, focus.point.z),
        },
      serialized.rotatingWith,
      len(offsetVector),
      frameDir(pan.x, pan.y, pan.z),
      qFromBasis(offsetVector, v3(up.x, up.y, up.z)),
      // null も欠けと同じく既定へ落とす(既定引数は undefined でしか働かない)。
      serialized.rotationMode ?? undefined,
      serialized.fovDeg ?? undefined,
      projectionMode === 'perspective' || projectionMode === 'orthographic' ? projectionMode : undefined,
      Number.isFinite(orthographicHalfHeight) ? orthographicHalfHeight : undefined,
      referencePlane === 'ecliptic' || referencePlane === 'equator' || referencePlane === 'moonOrbit'
        ? referencePlane : undefined,
      serialized.staleFollowFrames,
      serialized.focusReplaced,
    );
  }

  // フォーカスを差し替え、パンを対象の位置へ戻す。新しい対象で成立しない回転追従は、次の
  // followProgress で猶予を置かずに慣性系へ戻る。
  public setFocus(target: FocusTarget): void {
    this._focus = target;
    this.focusReplaced = true;
    this.resetPan();
  }

  // id の対象を指していれば原点天体へ戻す。
  public clearFocusIf(id: string): void {
    if (this._focus.kind === 'object' && this._focus.id === id) {
      this.setFocus({ kind: 'object', id: this.celestialBodies.originId });
    }
  }

  // fallToOrigin のカメラが、見失ったと確定した注視 lostFocus をまだ指していれば原点天体へ戻す。
  private followFocusLoss(lostFocus: FocusTarget | null): void {
    if (this.config.focusLossPolicy !== 'fallToOrigin' || lostFocus !== this._focus) return;
    this.setFocus({ kind: 'object', id: this.celestialBodies.originId });
  }

  // 進行直後の姿勢と座標系へ相対値を追従させ、成立しなくなった追従を慣性系へ戻す。
  public followProgress(sample: CameraFrameSample): void {
    this.followFocusLoss(sample.lostFocus);
    if (this.orientation.followingAttitude) this.orientation.refreshAttitude(sample.attitude);
    const focusReplaced = this.focusReplaced;
    this.focusReplaced = false;
    const follow = this.rotationFollow;
    if (follow === null || this.isFollowAvailable(follow, sample)) {
      this.staleFollowFrames = 0;
      return;
    }
    // 対象が一時的に解決できないだけのフレームでは外さない。
    this.staleFollowFrames++;
    if (!focusReplaced && this.staleFollowFrames < STALE_FOLLOW_FRAMES_TO_DROP) return;
    this.staleFollowFrames = 0;
    this.setRotationFollow(null, sample);
  }

  // 現在のフォーカスから選べる回転追従を返す。
  public availableRotationFollows(sample: CameraFrameSample): readonly CameraRotationFollow[] {
    if (this._focus.kind === 'point') return [];
    const id = this._focus.id;
    const out: CameraRotationFollow[] = [];
    // 天体なら自分と衛星の公転・自転を、実体なら重力源まわりの公転と姿勢を選べる。
    const body = this.celestialBodies.findMotion(id);
    if (body !== null) {
      if (body.primary !== null) out.push({ kind: 'revolution', id });
      for (const motion of this.celestialBodies.celestialMotions) {
        if (motion.primary?.id === id) out.push({ kind: 'revolution', id: motion.id });
      }
      if (body.spinRotationAt(sample.displayTime) !== null) out.push({ kind: 'spin', id });
    } else {
      if (sample.frameAnchors.attractorOf(id, sample.displayTime) !== null) {
        out.push({ kind: 'revolution', id });
      }
      if (sample.attitude !== null) out.push({ kind: 'attitude' });
    }
    return out;
  }

  // 回転追従を切り替え、保持中の向きを新しい基準へ読み替える。
  public setRotationFollow(follow: CameraRotationFollow | null, sample: CameraFrameSample): void {
    const valid = follow !== null && this.isFollowAvailable(follow, sample) ? follow : null;
    this.orientation.endAttitudeFollow();
    if (valid?.kind === 'attitude') {
      if (sample.attitude === null) return;
      this.setCameraRotation(null, sample);
      this.orientation.beginAttitudeFollow(sample.attitude);
      return;
    }
    this.setCameraRotation(valid, sample);
  }

  // 姿勢追従と慣性系を往復し、切り替わったときだけ出来事を記録する。
  public toggleAttitudeFollow(sample: CameraFrameSample): void {
    // 追従中なら慣性系へ戻す。
    if (this.orientation.followingAttitude) {
      this.orientation.endAttitudeFollow();
      this.events.record({ kind: 'cameraAttitudeFollowToggled', on: false });
      return;
    }
    // 姿勢を持つ対象を注視しているときだけ姿勢追従へ入る。
    if (!this.isFollowAvailable({ kind: 'attitude' }, sample)) return;
    this.setRotationFollow({ kind: 'attitude' }, sample);
    if (this.orientation.followingAttitude) {
      this.events.record({ kind: 'cameraAttitudeFollowToggled', on: true });
    }
  }

  // 1フレーム分の回転・ズーム・パン操作を積み、距離と仰角を許容範囲へ収める。
  public applyInput(input: CameraInput, sample: CameraFrameSample): void {
    // ズーム。透視では注視距離を、正射影では半高さを縮める。
    if (this.projectionMode === 'perspective') {
      this.setDistance(this.distance * input.zoomFactor);
    } else if (input.zoomFactor !== 1) {
      this._orthographicHalfHeight = clampOrthographicHalfHeight(this._orthographicHalfHeight * input.zoomFactor);
    }

    // 回転。オイラー操作だけが極軸を要るので、そこだけ座標系から解いて渡す。
    if (this.orientation.usesEuler) {
      this.orientation.turn(
        input.dragRightRad - input.keyYawRad,
        -input.dragUpRad + input.keyPitchRad,
        input.rollRad,
        this.eulerPolarAxis(sample),
      );
    } else {
      this.orientation.turnByDrag(
        input.dragRightRad,
        input.dragUpRad,
        input.rollRad,
        input.keyYawRad,
        input.keyPitchRad,
      );
    }

    // パン。画面上のずらしを、いまの視線・上方向から座標系相対のずらしへ直して積む。
    if (input.panDx === 0 && input.panDy === 0) return;
    const transform = this.celestialBodies.frames.transformAt(
      this._cameraFrame, sample.displayTime, sample.frameAnchors,
    );
    const rotation = this.orientation.effective();
    const offsetFrame = qRotate(rotation, LOCAL_FORWARD);
    const upFrame = qRotate(rotation, LOCAL_UP);
    const offsetEci = toInertialDir(transform, frameDir(offsetFrame.x, offsetFrame.y, offsetFrame.z));
    const upEci = toInertialDir(transform, frameDir(upFrame.x, upFrame.y, upFrame.z));
    const viewDir = scale(offsetEci, -1);
    const right = norm(cross(viewDir, upEci));
    const cameraUp = norm(cross(right, viewDir));
    const metersPerPixel = this.projectionMode === 'orthographic'
      ? (2 * this._orthographicHalfHeight) / Math.max(1, input.viewportHeight)
      : metersPerPixelAtDepth(this.fovDeg, this.distance, Math.max(1, input.viewportHeight));
    let panEci = toInertialDir(transform, this._pan);
    panEci = addScaled(panEci, right, -input.panDx * metersPerPixel);
    panEci = addScaled(panEci, cameraUp, input.panDy * metersPerPixel);
    this._pan = toFrameDir(transform, panEci);
  }

  // 垂直画角を設定し、透視投影では見かけの大きさを保つよう距離も換算する。
  public setFovDeg(fovDeg: number): void {
    const nextFov = clampFov(fovDeg);
    if (nextFov === this.fovDeg) return;
    if (this.projectionMode === 'perspective') {
      const oldScale = tanHalfFov(this.fovDeg);
      const newScale = tanHalfFov(nextFov);
      this.setDistance(this.distance * newScale / oldScale);
    }
    this.fovDeg = nextFov;
  }

  // 垂直画角を既定へ戻す。透視投影では setFovDeg と同じく距離も換算する。
  public resetFov(): void {
    this.setFovDeg(FOCUS_CAMERA_FOV);
  }

  // 投影方式を切り替え、透視距離と正射影の半高さを相互に換算する。
  public setProjectionMode(mode: ProjectionMode): void {
    if (mode === this.projectionMode) return;
    if (mode === 'orthographic') {
      this._orthographicHalfHeight = this.distance * tanHalfFov(this.fovDeg);
    } else {
      this.setDistance(this._orthographicHalfHeight / tanHalfFov(this.fovDeg));
    }
    this.projectionMode = mode;
  }

  // ドラッグ操作の解釈(オイラー/クォータニオン)を切り替える。向きの値は保たれる。
  public setCameraRotationMode(mode: CameraRotationMode): void {
    this.orientation.setRotationMode(mode);
  }

  // 真上・真横へ回すときに基準にする面を選ぶ。いまの向きは変えない。
  public setReferencePlane(plane: CameraReferencePlane): void {
    this._referencePlane = plane;
  }

  // 視点を基準面の真上または真横へ回し、パンを戻す。
  public setReferenceView(view: CameraReferenceView, sample: CameraFrameSample): void {
    // 基準面の法線を、視点を持つ座標系で表す。
    const transform = this.celestialBodies.frames.transformAt(
      this._cameraFrame, sample.displayTime, sample.frameAnchors,
    );
    const normal = norm(frameDirVector(toFrameDir(transform, this.framePlaneNormal(sample))));
    const currentOffset = qRotate(this.orientation.effective(), LOCAL_FORWARD);
    // 真上は法線から見下ろし、真横は現在の視線を基準面へ射影する。縮退した場合は春分方向、次に右軸を採用する。
    let offset: Vec3;
    let up: Vec3;
    if (view === 'above') {
      offset = normal;
      up = projectOntoPlane(frameDirVector(toFrameDir(transform, ECL_VERNAL)), normal);
      if (lenSq(up) < 1e-8) up = projectOntoPlane(LOCAL_RIGHT, normal);
    } else {
      offset = projectOntoPlane(currentOffset, normal);
      if (lenSq(offset) < 1e-8) {
        offset = projectOntoPlane(frameDirVector(toFrameDir(transform, ECL_VERNAL)), normal);
      }
      if (lenSq(offset) < 1e-8) offset = projectOntoPlane(LOCAL_RIGHT, normal);
      up = normal;
    }
    this.orientation.setEffective(qFromBasis(offset, up));
    this.resetPan();
    this.events.record({ kind: 'cameraReferenceViewSelected', view });
  }

  // ビュー固有の既定へ視点を戻す。
  public reset(sample: CameraFrameSample): void {
    if (this.config.reset === 'initial') {
      this.resetToInitial();
    } else {
      // 視線はそのままで、上方向を基準の上方向へ揃え、ずらしを戻す。
      const transform = this.celestialBodies.frames.transformAt(
        this._cameraFrame, sample.displayTime, sample.frameAnchors,
      );
      const offset = qRotate(this.orientation.effective(), LOCAL_FORWARD);
      const up = frameDirVector(toFrameDir(transform, sample.referenceUp));
      this.orientation.setEffective(qFromBasis(offset, up));
      this.resetPan();
    }
    this.events.record({ kind: 'cameraViewReset', view: this.config.view });
  }

  // 直列化した形へ畳む。向きは姿勢追従中なら対象姿勢からの相対値のまま書く。
  // 例外(ARCHITECTURE R12): 向き(CameraOrientation の値)と注視距離・追従(自分の値)を、変位 offset・
  // 上方向 up・rotatingWith に合成して書く。持ち主ごとの記録に分けると保存の形式が変わり、版 4 の
  // 記録が読めなくなる。形式は版を上げるときにまとめて直す。
  public serialize(): SerializedFocusCameraSelection {
    const focus: SerializedFocusCameraSelection['focus'] = this._focus.kind === 'object'
      ? { kind: 'object', id: this._focus.id }
      : {
        kind: 'point',
        center: this._focus.frame.center,
        rotatingWith: this._focus.frame.rotatingWith,
        point: { x: this._focus.point.x, y: this._focus.point.y, z: this._focus.point.z },
      };
    // 向きと注視距離を、注視点からカメラへの変位 offset と上方向 up の組へ畳む。
    const rotation = this.orientation.raw;
    const offset = scale(qRotate(rotation, LOCAL_FORWARD), this._distance);
    const up = qRotate(rotation, LOCAL_UP);
    return {
      offset: { x: offset.x, y: offset.y, z: offset.z },
      pan: { x: this._pan.x, y: this._pan.y, z: this._pan.z },
      up: { x: up.x, y: up.y, z: up.z },
      rotatingWith: this.rotationFollow,
      focus,
      rotationMode: this.orientation.rotationMode,
      fovDeg: this.fovDeg,
      projectionMode: this.projectionMode,
      orthographicHalfHeight: this._orthographicHalfHeight,
      referencePlane: this._referencePlane,
      staleFollowFrames: this.staleFollowFrames,
      focusReplaced: this.focusReplaced,
    };
  }

  // その追従が、いまの注視対象と表示時刻で選べるものとして立っているか。
  private isFollowAvailable(follow: CameraRotationFollow, sample: CameraFrameSample): boolean {
    const key = rotationFollowKey(follow);
    return this.availableRotationFollows(sample).some((candidate) => rotationFollowKey(candidate) === key);
  }

  // 注視距離 [m] を、注視対象の半径(天体でなければ実体の下限)と上限の間へ収めて据える。
  public setDistance(distance: number): void {
    const body = this._focus.kind === 'object' ? this.celestialBodies.findMotion(this._focus.id) : null;
    const minDistance = body === null ? ENTITY_MIN_DIST : Math.max(FOCUS_CAMERA_MIN_DIST, body.def.radius);
    this._distance = Math.max(minDistance, Math.min(FOCUS_CAMERA_MAX_DIST, distance));
  }

  // 注視点からのずらしを消し、視線を対象の中心へ戻す。
  private resetPan(): void {
    this._pan = frameDir(0, 0, 0);
  }

  // オイラー操作の極軸を、いまの座標系相対の単位方向として返す。姿勢追従中は対象のローカル上方。
  private eulerPolarAxis(sample: CameraFrameSample): Vec3 {
    if (this.orientation.followingAttitude && sample.attitude !== null) return LOCAL_UP;
    const transform = this.celestialBodies.frames.transformAt(
      this._cameraFrame, sample.displayTime, sample.frameAnchors,
    );
    const polarEci = this.config.eulerPole === 'attitude' && sample.attitude !== null
      ? qRotate(sample.attitude, LOCAL_UP) : sample.referenceUp;
    return norm(frameDirVector(toFrameDir(transform, polarEci)));
  }

  // いま選ばれている基準面の法線(ECI)。求まらない面は黄道極か ECI の極で代える。
  private framePlaneNormal(sample: CameraFrameSample): Vec3 {
    if (this._referencePlane === 'ecliptic') return ECL_POLE_ECI;
    // 月の軌道面。月が公転していなければ黄道極へ落ちる。
    if (this._referencePlane === 'moonOrbit') {
      const moon = this.celestialBodies.findMotion('moon');
      if (moon instanceof OrbitingMotion) return moon.orbitNormalAt(sample.displayTime);
    }
    // 赤道面は地球(居なければ原点天体)の自転軸。自転軸が引けなければ ECI の極。
    if (this._referencePlane === 'equator') {
      const earth = this.celestialBodies.findMotion('earth')
        ?? this.celestialBodies.motionOf(this.celestialBodies.originId);
      return earth.orientationAt(sample.displayTime)?.axis ?? ECI_POLE;
    }
    return ECL_POLE_ECI;
  }

  // 座標系の回転源を差し替える。向きとずらしは、その瞬間の見え方が変わらないよう移し替える。
  private setCameraRotation(rotatingWith: FrameRotationSource | null, sample: CameraFrameSample): void {
    const frames = this.celestialBodies.frames;
    const frame = frames.frameOf(this.celestialBodies.originId, rotatingWith);
    const from = this._cameraFrame;
    if (frame === from) return;
    // 同じ表示時刻の新旧の座標系で、視線・上方向・ずらしを表し直す。
    const fromTransform = frames.transformAt(from, sample.displayTime, sample.frameAnchors);
    const toTransform = frames.transformAt(frame, sample.displayTime, sample.frameAnchors);
    const rotation = this.orientation.effective();
    const offset = reframeDir(fromTransform, toTransform, qRotate(rotation, LOCAL_FORWARD));
    const up = reframeDir(fromTransform, toTransform, qRotate(rotation, LOCAL_UP));
    this._pan = toFrameDir(toTransform, toInertialDir(fromTransform, this._pan));
    this._cameraFrame = frame;
    this.orientation.setEffective(qFromBasis(offset, up));
  }

  // 注視・座標系・距離・向き・画角・ずらしを、このビューの初期値へまとめて戻す。
  private resetToInitial(): void {
    const initial = this.config.initial;
    this._focus = initial.focus;
    this.staleFollowFrames = 0;
    this._cameraFrame = this.frameFollowing(initial.follow);
    this.orientation.resetFollow(initial.follow?.kind === 'attitude');
    this._distance = initial.dist;
    this.orientation.setRaw(qFromBasis(sphericalOffset(initial.angles, 1), v3(0, 1, 0)));
    this.fovDeg = clampFov(initial.fovDeg);
    this.resetPan();
  }

  // 回転追従 follow のときに視点を持つ座標系。姿勢追従は慣性系で持ち、それ以外は原点の座標系。
  private frameFollowing(follow: CameraRotationFollow | null): ReferenceFrame {
    return follow?.kind === 'attitude'
      ? this.celestialBodies.frames.inertialFrame
      : this.celestialBodies.frames.frameOf(this.celestialBodies.originId, follow);
  }
}
