// マップモードの地球中心広範囲視点カメラ。太陽回転系への切替とフォーカス対象の選択を持つ。
import * as THREE from 'three/webgpu';
import { Vec3, add, addScaled, cross, dot, len, lenSq, norm, scale, sub, v3 } from '../../math/vec3';
import * as C from '../const';
import { Hud } from '../hud/hud';
import { MouseDelta } from '../input/input';
import { metersPerPixelAtDepth, ProjectionMode, Viewpoint } from '../../math/projection';
import { FrameAnchorSource, ReferenceFrame, FrameDir, FrameRotationSource, frameDir, framePoint, toFrameDir, toInertialDir } from '../../physics/frame';
import { bodyAnchorSource, strongestAttractor } from '../../physics/celestial-body';
import { CelestialMotion, OrbitingMotion } from '../../physics/celestial-motion';
import type { CelestialSystem } from '../celestial/celestial-system';
import { Quat, qFromAxisAngle, qFromForwardUp, qMul, qNormalize, qRotate } from '../../physics/attitude';
import { ECI_POLE, ECL_POLE_ECI, ECL_VERNAL } from '../../physics/ecliptic';
import { MapPickable } from '../pickable/map-pickable';
import { FocusTarget, resolveFocusTarget } from './focus-target';
import { FrameRotationSourceSaveData, MapCameraSaveData } from '../save/save-data';

// 冥王星(遠日点約70AU)やエリス(遠日点約97AU)、散乱円盤の遠日点(数百AU)まで
// 視界に収められる引きの上限。
const OVERVIEW_CAMERA_MAX_DIST = 1e14;

// 広範囲視点の near は固定値ではなく、注視点までの距離をこの比で割った値を毎フレーム使う
// (near = dist / OVERVIEW_CAMERA_NEAR_RATIO)。比を大きくすると near が注視点に近づいて
// 手前がクリップされにくくなる。反転 32bit 深度では分解能が near に依らないので、
// この比が深度精度と取引になることはない。
const OVERVIEW_CAMERA_NEAR_RATIO = 1000;

// near = dist / OVERVIEW_CAMERA_NEAR_RATIO の比例則は dist の上限では星球シェル・
// 天球グリッド(CELESTIAL_SHELL_RADIUS)より大きくなる(dist=1e14 で near=1e11)。
// near クリップは光軸からの角度 θ に対して球殻上の点を R·cosθ まで切り詰めるので、
// R そのものでなく画面対角の半視野角 θ_diag での R·cosθ_diag を上限に取らないと、
// 画面中心だけ残して周辺・四隅の星が消える(MapCamera.near 参照)。
// 1 未満のこの係数はその余弦にさらに掛ける安全マージン。
const OVERVIEW_CAMERA_NEAR_SHELL_MARGIN = 0.9;

// 広範囲視点の far も near と同様に固定値ではなく dist に連動させる
// (far = clamp(dist × OVERVIEW_CAMERA_FAR_RATIO, OVERVIEW_CAMERA_FAR_MIN, OVERVIEW_CAMERA_FAR_MAX))。
// far を dist に比例させないと、太陽・木星のような遠方天体は引いたカメラでは
// far 平面の外に出て消える。逆に近距離域で far を大きく取ることの費用は、反転 32bit 深度では
// 事実上ゼロ。
const OVERVIEW_CAMERA_FAR_RATIO = 100;

// 最小ズーム(dist = OVERVIEW_CAMERA_MIN_DIST)でも月(3.8e8m)や星球シェルが
// far の外に出ないための下限。
export const OVERVIEW_CAMERA_FAR_MIN = 1.5e10;

// OVERVIEW_CAMERA_MAX_DIST × OVERVIEW_CAMERA_FAR_RATIO と等しい値。これより小さいと
// 最大ズームアウト付近で far = dist × FAR_RATIO の比例則がこの上限に張り付いてしまい、
// 注視点より奥にある軌道線・天体が far 平面でクリップされる。
const OVERVIEW_CAMERA_FAR_MAX = 1e16;

// セーブデータの rotatingWith を FrameRotationSource へ変換する。旧セーブは公転対象の id を
// 文字列(または回さないなら null)でそのまま持っていたので、その形は公転として受ける。
function rotationSourceFromSaveData(saved: FrameRotationSourceSaveData | string | null): FrameRotationSource | null {
  if (saved === null) return null;
  if (typeof saved === 'string') return { kind: 'revolution', id: saved };
  return { kind: saved.kind, id: saved.id };
}

const WORLD_UP = v3(0, 1, 0);
const OVERVIEW_CAMERA_FOV = 50;
const FRAME_FORWARD = v3(0, 0, 1);
const FRAME_UP = v3(0, 1, 0);
const FRAME_RIGHT = v3(1, 0, 0);
const EULER_PITCH_LIMIT = Math.PI / 2 - 1e-3;

export type CameraRotationMode = 'quaternion' | 'euler';
export type CameraReferencePlane = 'ecliptic' | 'equator' | 'moonOrbit';
export type CameraReferenceView = 'above' | 'side';

interface CameraEuler {
  yaw: number;
  pitch: number;
  roll: number;
}

// 初期視点(注視点まわりの方位角・仰角・距離)。offset_r の初期値の組み立てにだけ使う。
const INIT_YAW = 0.7;
const INIT_PITCH = 0.45;
const INIT_DIST = 4.5e7;

// 注視点 → カメラの相対位置ベクトルを、方位角・仰角・距離から組む。回転軸 Y まわりの
// 方位 yaw と、そこからの仰角 pitch。初期状態の視点を名前の付いた角度で置くための純粋関数。
function sphericalOffset(yaw: number, pitch: number, dist: number): Vec3 {
  const cp = Math.cos(pitch);
  return scale(v3(cp * Math.cos(yaw), Math.sin(pitch), cp * Math.sin(yaw)), dist);
}

function frameDirVector(value: FrameDir): Vec3 {
  return v3(value.x, value.y, value.z);
}

export class MapCamera {
  // 軌道計画モード用の地球中心カメラ(モルニヤ級軌道全体が収まる遠方まで)
  private readonly perspectiveCamera: THREE.PerspectiveCamera;
  private readonly orthographicCamera: THREE.OrthographicCamera;
  private fovDeg = OVERVIEW_CAMERA_FOV;
  private rotationMode: CameraRotationMode;
  private projectionMode: ProjectionMode;
  private orthographicHalfHeight = 1;
  // rotationQ はカメラのローカル(+Z=注視点からカメラ、+Y=画面上)を cameraFrame へ
  // 写すクォータニオン。オイラー操作も最終的には必ずこの値へ変換して描画する。
  private rotationQ: Quat;
  private euler: CameraEuler;

  // offset_r … 注視点 → カメラの相対位置ベクトル(方位・仰角・距離を兼ねる)
  // pan_r    … focus → 注視点のパン変位
  // up_r     … カメラの上方向(テンキー0/1のロールで offset_r まわりに回る)
  private offset_r: FrameDir;
  private pan_r: FrameDir;
  private up_r: FrameDir;
  // カメラ視点を固定する座標系。
  private _cameraFrame: ReferenceFrame;
  private displayTime = 0; // set cameraFrame の座標変換に使う。線・メッシュと同じ表示時刻に揃える。
  // 最新の update 呼び出しが受け取った FrameAnchorSource。reset/resetPan/cameraFrame setter は
  // フレームの外(入力ハンドラ)から呼ばれるため、update と同じ値をここから読む。
  private frameAnchors: FrameAnchorSource = bodyAnchorSource([]);
  private _focus: FocusTarget;
  private missingFocusFrames = 0;
  private lastResolvedFocus = v3();

  get focus(): FocusTarget { return this._focus; }

  // target が 'point'(座標系に焼き込んだ固定点)で frame が回転系なら、その天体の
  // 公転に追随する固定点になる。
  setFocusTarget(target: FocusTarget, resetPan = true): void {
    this._focus = target;
    this.missingFocusFrames = 0;
    if (resetPan) this.resetPan();
  }

  clearFocusIf(id: string): void {
    if (this._focus.kind === 'object' && this._focus.id === id) {
      this.setFocusTarget({ kind: 'object', id: this.celestialSystem.origin.id });
    }
  }

  viewpoint: Viewpoint = {
    position: v3(),
    lookTarget: v3(),
    up: WORLD_UP,
    fovDeg: OVERVIEW_CAMERA_FOV,
    aspect: window.innerWidth / window.innerHeight,
    projection: 'perspective',
  };

  // THREE.PerspectiveCamera と初期視点(offset_r/pan_r/up_r/座標系/フォーカス)を組む。saved が
  // あればその値から、無ければ既定の見下ろし視点から組む。座標系は必ず frames.frameOf 経由で
  // 解決する — ReferenceFrame をリテラルで組むと参照同一性が崩れる(frame.ts 参照)。
  constructor(
    private readonly _hud: Hud,
    private readonly celestialSystem: CelestialSystem,
    saved?: MapCameraSaveData,
  ) {
    this.rotationMode = saved?.rotationMode ?? 'euler';
    this.projectionMode = saved?.projectionMode === 'orthographic' ? 'orthographic' : 'perspective';
    this._referencePlane = saved?.referencePlane === 'ecliptic' || saved?.referencePlane === 'moonOrbit'
      ? saved.referencePlane : 'equator';
    this.fovDeg = this.clampFov(saved?.fovDeg ?? OVERVIEW_CAMERA_FOV);
    const frames = celestialSystem.frames;
    if (saved) {
      this._cameraFrame = frames.frameOf(celestialSystem.origin.id, rotationSourceFromSaveData(saved.rotatingWith));
      this.offset_r = frameDir(saved.offset.x, saved.offset.y, saved.offset.z);
      this.pan_r = frameDir(saved.pan.x, saved.pan.y, saved.pan.z);
      this.up_r = frameDir(saved.up.x, saved.up.y, saved.up.z);
      this._focus = saved.focus.kind === 'object'
        ? { kind: 'object', id: saved.focus.id }
        : {
          kind: 'point',
          frame: frames.frameOf(saved.focus.center, rotationSourceFromSaveData(saved.focus.rotatingWith)),
          point: framePoint(saved.focus.point.x, saved.focus.point.y, saved.focus.point.z),
        };
    } else {
      this._cameraFrame = frames.inertialFrame;
      const tf0 = frames.transformAt(this._cameraFrame, 0, bodyAnchorSource([]));
      this.offset_r = toFrameDir(tf0, sphericalOffset(INIT_YAW, INIT_PITCH, INIT_DIST));
      this.pan_r = toFrameDir(tf0, v3());
      this.up_r = toFrameDir(tf0, WORLD_UP);
      this._focus = { kind: 'object', id: celestialSystem.origin.id };
    }
    this.rotationQ = this.rotationFromBasis(frameDirVector(this.offset_r), frameDirVector(this.up_r));
    this.euler = this.eulerFromRotation(this.rotationQ);
    const defaultHalfHeight = this.dist * Math.tan(THREE.MathUtils.degToRad(this.fovDeg * 0.5));
    const savedHalfHeight = saved?.orthographicHalfHeight;
    const halfHeight = savedHalfHeight !== undefined && Number.isFinite(savedHalfHeight) ? savedHalfHeight : defaultHalfHeight;
    this.orthographicHalfHeight = Math.max(C.OVERVIEW_CAMERA_MIN_DIST * 1e-6,
      Math.min(OVERVIEW_CAMERA_MAX_DIST, halfHeight));
    this.perspectiveCamera = new THREE.PerspectiveCamera(
      this.fovDeg,
      window.innerWidth / window.innerHeight,
      this.near,
      this.far,
    );
    this.orthographicCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, this.near, this.far);
  }

  public get camera(): THREE.Camera {
    return this.projectionMode === 'orthographic' ? this.orthographicCamera : this.perspectiveCamera;
  }

  private clampFov(fovDeg: number): number {
    return Math.max(C.OVERVIEW_CAMERA_FOV_MIN, Math.min(C.OVERVIEW_CAMERA_FOV_MAX,
      Number.isFinite(fovDeg) ? fovDeg : OVERVIEW_CAMERA_FOV));
  }

  private rotationFromBasis(offset: Vec3, up: Vec3): Quat {
    return qFromForwardUp(norm(offset), norm(up)) ?? { x: 0, y: 0, z: 0, w: 1 };
  }

  // カメラの位置に応じて、ロールリセットおよびオイラー極軸の基準ベクトル(ECI 座標系)を返す。
  // カメラが天体近傍(1,000,000 km 以内)にある場合は最寄り天体の自転軸、広域にある場合は黄道面法線。
  private referenceUpAxisEci(): Vec3 {
    if (this.frameAnchors.bodies.length > 0) {
      const cameraPos = this.viewpoint.position;
      const nearest = strongestAttractor(cameraPos, this.frameAnchors.bodies);
      const distToBody = len(sub(cameraPos, nearest.state.r));
      const PLANETARY_SCALE_THRESHOLD = 1e9; // 1,000,000 km in meters

      const nearestBody = this.celestialSystem.find(nearest.id);
      if (distToBody <= PLANETARY_SCALE_THRESHOLD && nearestBody !== null) {
        return nearestBody.motion.orientationAt(this.displayTime)?.axis ?? ECI_POLE;
      }
    }
    return ECL_POLE_ECI;
  }

  // Euler 操作の極はカメラ座標系の +Y ではなく、カメラ位置に応じた自転軸または黄道面法線にする。
  // 座標系が慣性系以外でも、基準軸を同じ座標系へ変換してから使う。
  private eulerPolarAxis(): Vec3 {
    const tf = this.celestialSystem.frames.transformAt(this._cameraFrame, this.displayTime, this.frameAnchors);
    return norm(frameDirVector(toFrameDir(tf, this.referenceUpAxisEci())));
  }

  private eulerBasis(polar: Vec3): { reference: Vec3; east: Vec3 } {
    let reference = sub(FRAME_RIGHT, scale(polar, dot(FRAME_RIGHT, polar)));
    if (lenSq(reference) < 1e-8) reference = sub(FRAME_FORWARD, scale(polar, dot(FRAME_FORWARD, polar)));
    reference = norm(reference);
    return { reference, east: norm(cross(reference, polar)) };
  }

  private eulerFromRotation(rotation: Quat, polar = this.eulerPolarAxis()): CameraEuler {
    const offset = qRotate(rotation, FRAME_FORWARD);
    const basis = this.eulerBasis(polar);
    const pitch = Math.asin(Math.max(-1, Math.min(1, dot(offset, polar))));
    const horizontal = sub(offset, scale(polar, dot(offset, polar)));
    const yaw = Math.atan2(dot(horizontal, basis.east), dot(horizontal, basis.reference));
    const up = qRotate(rotation, FRAME_UP);
    let referenceUp = sub(polar, scale(offset, dot(polar, offset)));
    if (lenSq(referenceUp) < 1e-8) referenceUp = sub(basis.reference, scale(offset, dot(basis.reference, offset)));
    referenceUp = norm(referenceUp);
    const roll = Math.atan2(dot(offset, cross(referenceUp, up)), dot(referenceUp, up));
    return { yaw, pitch: Math.max(-EULER_PITCH_LIMIT, Math.min(EULER_PITCH_LIMIT, pitch)), roll };
  }

  private rotationFromEuler(euler: CameraEuler, polar = this.eulerPolarAxis()): Quat {
    const pitch = Math.max(-EULER_PITCH_LIMIT, Math.min(EULER_PITCH_LIMIT, euler.pitch));
    const basis = this.eulerBasis(polar);
    const cp = Math.cos(pitch);
    const offset = addScaled(
      addScaled(scale(basis.reference, cp * Math.cos(euler.yaw)), basis.east, cp * Math.sin(euler.yaw)),
      polar,
      Math.sin(pitch),
    );
    let referenceUp = sub(polar, scale(offset, dot(polar, offset)));
    if (lenSq(referenceUp) < 1e-8) referenceUp = sub(basis.reference, scale(offset, dot(basis.reference, offset)));
    const base = this.rotationFromBasis(offset, norm(referenceUp));
    return qNormalize(qMul(qFromAxisAngle(offset, euler.roll), base));
  }

  private setRotationBasis(offset: Vec3, up: Vec3): void {
    this.rotationQ = this.rotationFromBasis(offset, up);
    this.offset_r = frameDir(offset.x * this.dist, offset.y * this.dist, offset.z * this.dist);
    this.up_r = frameDir(up.x, up.y, up.z);
    this.euler = this.eulerFromRotation(this.rotationQ);
  }

  private framePlaneNormal(plane: CameraReferencePlane): Vec3 {
    if (plane === 'ecliptic') return ECL_POLE_ECI;
    if (plane === 'moonOrbit') {
      const moon = this.celestialSystem.find('moon')?.motion;
      if (moon instanceof OrbitingMotion) return moon.orbitNormalAt(this.displayTime);
    }
    if (plane === 'equator') {
      const earth = this.celestialSystem.find('earth') ?? this.celestialSystem.origin;
      return earth.motion.orientationAt(this.displayTime)?.axis ?? ECI_POLE;
    }
    return ECL_POLE_ECI;
  }

  private projectOntoPlane(vector: Vec3, planeNormal: Vec3): Vec3 {
    return sub(vector, scale(planeNormal, dot(vector, planeNormal)));
  }

  // 注視点からカメラまでの距離を返す。
  get dist(): number {
    return Math.hypot(this.offset_r.x, this.offset_r.y, this.offset_r.z);
  }

  public get fov(): number {
    return this.fovDeg;
  }

  public get cameraRotationMode(): CameraRotationMode {
    return this.rotationMode;
  }

  public get projection(): ProjectionMode {
    return this.projectionMode;
  }

  public get referencePlane(): CameraReferencePlane {
    return this._referencePlane;
  }

  public setFovDeg(fovDeg: number): void {
    const nextFov = this.clampFov(fovDeg);
    if (nextFov === this.fovDeg) return;
    if (this.projectionMode === 'perspective') {
      const oldScale = Math.tan(THREE.MathUtils.degToRad(this.fovDeg * 0.5));
      const newScale = Math.tan(THREE.MathUtils.degToRad(nextFov * 0.5));
      this.setDistance(this.dist * newScale / oldScale);
    }
    this.fovDeg = nextFov;
  }

  public resetFov(): void {
    this.setFovDeg(OVERVIEW_CAMERA_FOV);
  }

  public setProjectionMode(mode: ProjectionMode): void {
    if (mode === this.projectionMode) return;
    if (mode === 'orthographic') {
      this.orthographicHalfHeight = this.dist * Math.tan(THREE.MathUtils.degToRad(this.fovDeg * 0.5));
    } else {
      this.setDistance(this.orthographicHalfHeight / Math.tan(THREE.MathUtils.degToRad(this.fovDeg * 0.5)));
    }
    this.projectionMode = mode;
  }

  private setDistance(distance: number): void {
    const current = this.dist;
    const next = Math.max(this.minDist, Math.min(OVERVIEW_CAMERA_MAX_DIST, distance));
    if (!(current > 0) || next === current) return;
    this.offset_r = frameDir(
      this.offset_r.x * next / current,
      this.offset_r.y * next / current,
      this.offset_r.z * next / current,
    );
  }

  public setCameraRotationMode(mode: CameraRotationMode): void {
    if (mode === this.rotationMode) return;
    if (mode === 'euler') this.euler = this.eulerFromRotation(this.rotationQ);
    else this.rotationQ = this.rotationFromEuler(this.euler);
    this.rotationMode = mode;
  }

  // 真上/真横の基準面。セーブ対象ではなく、次回の操作状態を示すHUD表示用の状態。
  private _referencePlane: CameraReferencePlane = 'equator';

  public setReferencePlane(plane: CameraReferencePlane): void {
    this._referencePlane = plane;
  }

  public setReferenceView(view: CameraReferenceView): void {
    const tf = this.celestialSystem.frames.transformAt(this._cameraFrame, this.displayTime, this.frameAnchors);
    const normal = norm(frameDirVector(toFrameDir(tf, this.framePlaneNormal(this._referencePlane))));
    const currentOffset = qRotate(this.rotationQ, FRAME_FORWARD);
    let offset: Vec3;
    let up: Vec3;
    if (view === 'above') {
      offset = normal;
      up = this.projectOntoPlane(frameDirVector(toFrameDir(tf, ECL_VERNAL)), normal);
      if (lenSq(up) < 1e-8) up = this.projectOntoPlane(FRAME_RIGHT, normal);
    } else {
      offset = this.projectOntoPlane(currentOffset, normal);
      if (lenSq(offset) < 1e-8) offset = this.projectOntoPlane(frameDirVector(toFrameDir(tf, ECL_VERNAL)), normal);
      if (lenSq(offset) < 1e-8) offset = this.projectOntoPlane(FRAME_RIGHT, normal);
      up = normal;
    }
    offset = norm(offset);
    up = norm(up);
    this.setRotationBasis(offset, up);
    this.resetPan();
    this._hud.hint(view === 'above' ? '基準面の真上を表示' : '基準面の真横を表示');
  }

  // CameraSystem.sync が読む近クリップ距離。dist に比例させることで、どのズーム段でも
  // 注視点を切り落とさない(OVERVIEW_CAMERA_NEAR_RATIO 参照)。
  // near クリップは光軸からの角度 θ の点を R·cosθ で切り詰める平面なので、画面対角の
  // 半視野角(fov・aspect から求まる)での R·cosθ_diag を超えないようクランプし、
  // 星球シェル・天球グリッドの周辺・四隅がクリップされないようにする。
  get near(): number {
    const halfV = THREE.MathUtils.degToRad(this.fov * 0.5);
    const halfH = Math.atan(Math.tan(halfV) * window.innerWidth / window.innerHeight);
    const halfDiag = Math.atan(Math.hypot(Math.tan(halfV), Math.tan(halfH)));
    const nearMax = C.CELESTIAL_SHELL_RADIUS * Math.cos(halfDiag) * OVERVIEW_CAMERA_NEAR_SHELL_MARGIN;
    return Math.min(nearMax, this.dist / OVERVIEW_CAMERA_NEAR_RATIO);
  }

  // CameraSystem.sync が読む遠クリップ距離。dist に比例させることで、引いたカメラでも
  // 太陽・木星のような遠方天体が far の外に出て消えない(OVERVIEW_CAMERA_FAR_RATIO 参照)。
  get far(): number {
    return Math.min(OVERVIEW_CAMERA_FAR_MAX, Math.max(OVERVIEW_CAMERA_FAR_MIN, this.dist * OVERVIEW_CAMERA_FAR_RATIO));
  }

  // 現在のフォーカス対象がクランプ後も表面下にめり込まない最小注視距離。
  // フォーカスが天体でなければ通常の下限をそのまま使う。
  private get minDist(): number {
    const body = this._focus.kind === 'object' ? this.celestialSystem.find(this._focus.id) : null;
    if (body === null) return C.OVERVIEW_CAMERA_MIN_DIST;
    return Math.max(C.OVERVIEW_CAMERA_MIN_DIST, body.def.radius);
  }

  // ロールを初期状態(天体近傍: 自転軸、広域: 黄道面法線)に戻し、パンでフォーカスから
  // ずれていた注視点もフォーカス位置へ戻す。
  reset(): void {
    const tf = this.celestialSystem.frames.transformAt(this._cameraFrame, this.displayTime, this.frameAnchors);
    const offset = qRotate(this.rotationQ, FRAME_FORWARD);
    const upAxisEci = this.referenceUpAxisEci();
    const up = norm(frameDirVector(toFrameDir(tf, upAxisEci)));
    const projectedUp = norm(this.projectOntoPlane(up, offset));
    this.setRotationBasis(offset, projectedUp);
    this.resetPan();
    this._hud.hint('マップ視点をリセット');
  }

  // パン変位をゼロに戻す。
  resetPan(): void {
    const tf = this.celestialSystem.frames.transformAt(this._cameraFrame, this.displayTime, this.frameAnchors);
    this.pan_r = toFrameDir(tf, v3());
  }

  // 天体 id の運動。登録されていない id(機体・役割トークン・ラグランジュ点)には null。
  private readonly celestialMotionOf = (id: string): CelestialMotion | null => (
    this.celestialSystem.find(id)?.motion ?? null
  );

  // 候補が一時的に欠けたフレームでは直前の注視点を保ち、連続して消えた対象は ECI 原点へ戻す。
  // point は座標系が回っていれば ECI 座標が動くため、毎フレーム焼き直す。
  private resolveFocus(candidates: readonly MapPickable[], displayTime: number, frameAnchors: FrameAnchorSource): Vec3 {
    const result = resolveFocusTarget(
      this._focus, candidates, displayTime, frameAnchors,
      this.celestialSystem.frames, this.celestialMotionOf,
      { missingFocusFrames: this.missingFocusFrames, lastResolvedFocus: this.lastResolvedFocus },
    );
    this.missingFocusFrames = result.missingFocusFrames;
    this.lastResolvedFocus = result.lastResolvedFocus;
    if (result.fallToOrigin) {
      this.setFocusTarget({ kind: 'object', id: this.celestialSystem.origin.id });
      return v3();
    }
    return result.pos;
  }

  // 現在視点を固定している座標系を返す。
  get cameraFrame(): ReferenceFrame {
    return this._cameraFrame;
  }

  // 最後に resolveFocus が解決した注視点の ECI 位置。
  get resolvedFocus(): Vec3 {
    return this.lastResolvedFocus;
  }

  // カメラ視点の回転対象を切り替える。中心は常に ECI 中心天体 — offset_r/pan_r/up_r は
  // 方向(FrameDir)しか持たず原点移動の影響を受けないので、中心をどれにしても視点は変わらない。
  // 切替の瞬間にカメラ視点(ECI)を跳ばせないよう、現在の座標系から新しい座標系へ変換し直す。
  setCameraRotation(rotatingWith: FrameRotationSource | null): void {
    const frames = this.celestialSystem.frames;
    const frame = frames.frameOf(this.celestialSystem.origin.id, rotatingWith);
    const from = this._cameraFrame;
    if (frame === from) return;
    const tfFrom = frames.transformAt(from, this.displayTime, this.frameAnchors);
    const offEci = toInertialDir(tfFrom, this.offset_r);
    const panEci = toInertialDir(tfFrom, this.pan_r);
    const upEci = toInertialDir(tfFrom, this.up_r);
    const tfTo = frames.transformAt(frame, this.displayTime, this.frameAnchors);
    this.offset_r = toFrameDir(tfTo, offEci);
    this.pan_r = toFrameDir(tfTo, panEci);
    this.up_r = toFrameDir(tfTo, upEci);
    this._cameraFrame = frame;
    this.rotationQ = this.rotationFromBasis(frameDirVector(this.offset_r), frameDirVector(this.up_r));
    this.euler = this.eulerFromRotation(this.rotationQ);
  }

  // マウス/キー入力から viewpoint を1フレーム分更新する。displayTime は線・メッシュが描かれる
  // のと同じ表示時刻 — 座標系変換をそこに揃えないと、回転系選択時に線・メッシュだけが
  // displayTime へ動いてカメラだけ現在時刻に取り残される。
  update(
    mouse: MouseDelta,
    keyYaw: number,
    keyPitch: number,
    dt: number,
    displayTime: number,
    candidates: readonly MapPickable[],
    frameAnchors: FrameAnchorSource,
  ): void {
    this.displayTime = displayTime;
    this.frameAnchors = frameAnchors;
    const focus = this.resolveFocus(candidates, displayTime, frameAnchors);
    const tf = this.celestialSystem.frames.transformAt(this._cameraFrame, displayTime, frameAnchors);
    let offFrame: Vec3;
    let upFrame: Vec3;
    if (this.rotationMode === 'euler') {
      this.rotationQ = this.rotationFromEuler(this.euler);
    }
    offFrame = qRotate(this.rotationQ, FRAME_FORWARD);
    upFrame = qRotate(this.rotationQ, FRAME_UP);
    let offEci = toInertialDir(tf, frameDir(offFrame.x, offFrame.y, offFrame.z));
    let panEci = toInertialDir(tf, this.pan_r);
    let upEci = toInertialDir(tf, frameDir(upFrame.x, upFrame.y, upFrame.z));

    // ホイールで距離を、ドラッグ/キーで視点方向を更新する。ヨー/ピッチはワールド軸ではなく
    // 現在の上/右軸まわりに回す — ロールで上方向が傾いても、画面上の動きと入力方向が一致する。
    // マップビューはトラックパッドの細かいスクロールでも操作しやすいよう、
    // スクロールによるズーム感度を combat の基準値から 1.5 倍にする。
    const zoomFactor = Math.exp(mouse.wheel * 0.0018);
    const dist = this.projectionMode === 'orthographic'
      ? this.dist
      : Math.max(this.minDist, Math.min(OVERVIEW_CAMERA_MAX_DIST, this.dist * zoomFactor));
    if (this.projectionMode === 'orthographic' && mouse.wheel !== 0) {
      this.orthographicHalfHeight = Math.max(C.OVERVIEW_CAMERA_MIN_DIST * 1e-6,
        Math.min(OVERVIEW_CAMERA_MAX_DIST, this.orthographicHalfHeight * zoomFactor));
    }
    upEci = norm(addScaled(upEci, offEci, -dot(upEci, offEci) / dot(offEci, offEci)));
    const yaw = mouse.dx * 0.005 - keyYaw * C.CAM_KEY_YAW_RATE * dt;
    const pitch = mouse.dy * 0.005 + keyPitch * C.CAM_KEY_PITCH_RATE * dt;
    if (this.rotationMode === 'quaternion') {
      // rotationQ の +Z は注視点からカメラへ向く軸。ドラッグの回転軸は、戦闘ビューと
      // 同じくドラッグ方向とこの視線軸の外積にする。cameraForward(-offFrame)を使うと
      // 左右ドラッグの回転符号が反転する。
      const keyYawAngle = -keyYaw * C.CAM_KEY_YAW_RATE * dt;
      const keyPitchAngle = keyPitch * C.CAM_KEY_PITCH_RATE * dt;
      if (keyYawAngle !== 0) {
        this.rotationQ = qNormalize(qMul(qFromAxisAngle(upFrame, keyYawAngle), this.rotationQ));
      }
      offFrame = qRotate(this.rotationQ, FRAME_FORWARD);
      upFrame = qRotate(this.rotationQ, FRAME_UP);
      if (keyPitchAngle !== 0) {
        const right = norm(cross(norm(offFrame), upFrame));
        this.rotationQ = qNormalize(qMul(qFromAxisAngle(right, keyPitchAngle), this.rotationQ));
      }

      offFrame = qRotate(this.rotationQ, FRAME_FORWARD);
      upFrame = qRotate(this.rotationQ, FRAME_UP);
      const screenRight = norm(cross(scale(offFrame, -1), upFrame));
      const dragVec = addScaled(scale(screenRight, mouse.dx), upFrame, -mouse.dy);
      const dragLen = Math.hypot(dragVec.x, dragVec.y, dragVec.z);
      if (dragLen > 1e-9) {
        const axis = norm(cross(dragVec, offFrame));
        this.rotationQ = qNormalize(qMul(qFromAxisAngle(axis, dragLen * 0.005), this.rotationQ));
      }

      offFrame = qRotate(this.rotationQ, FRAME_FORWARD);
      if (mouse.roll !== 0) this.rotationQ = qNormalize(qMul(qFromAxisAngle(offFrame, mouse.roll), this.rotationQ));
    } else {
      this.euler.yaw += yaw;
      this.euler.pitch = Math.max(-EULER_PITCH_LIMIT, Math.min(EULER_PITCH_LIMIT, this.euler.pitch + pitch));
      this.euler.roll += mouse.roll;
      this.rotationQ = this.rotationFromEuler(this.euler);
    }
    offFrame = qRotate(this.rotationQ, FRAME_FORWARD);
    upFrame = qRotate(this.rotationQ, FRAME_UP);
    offEci = scale(toInertialDir(tf, frameDir(offFrame.x, offFrame.y, offFrame.z)), dist);
    const newDir = norm(offEci);
    upEci = toInertialDir(tf, frameDir(upFrame.x, upFrame.y, upFrame.z));
    upEci = norm(addScaled(upEci, newDir, -dot(upEci, newDir)));

    // 中ボタンドラッグ/2本指ドラッグでパン変位を更新する
    if (mouse.panDx !== 0 || mouse.panDy !== 0) {
      const viewDir = scale(newDir, -1);
      const right = norm(cross(viewDir, upEci));
      const camUp = norm(cross(right, viewDir));
      const metersPerPixel = this.projectionMode === 'orthographic'
        ? (2 * this.orthographicHalfHeight) / Math.max(1, window.innerHeight)
        : metersPerPixelAtDepth(this.fovDeg, dist, Math.max(1, window.innerHeight));
      panEci = addScaled(panEci, right, -mouse.panDx * metersPerPixel);
      panEci = addScaled(panEci, camUp, mouse.panDy * metersPerPixel);
    }

    // フォーカス+パン+視点オフセットから実位置を組み立てる
    const lookTarget = add(focus, panEci);
    this.viewpoint = {
      position: add(lookTarget, offEci),
      lookTarget,
      up: upEci,
      fovDeg: this.fovDeg,
      aspect: window.innerWidth / window.innerHeight,
      projection: this.projectionMode,
      orthographicHalfHeight: this.orthographicHalfHeight,
    };
    this.up_r = toFrameDir(tf, upEci);
    this.offset_r = toFrameDir(tf, offEci);
    this.pan_r = toFrameDir(tf, panEci);
    this.euler = this.eulerFromRotation(this.rotationQ);
  }

  // offset_r/pan_r/up_r・視点の座標系・フォーカス対象をセーブデータへ書き出す。
  serialize(): MapCameraSaveData {
    const focus: MapCameraSaveData['focus'] = this._focus.kind === 'object'
      ? { kind: 'object', id: this._focus.id }
      : {
        kind: 'point',
        center: this._focus.frame.center,
        rotatingWith: this._focus.frame.rotatingWith,
        point: { x: this._focus.point.x, y: this._focus.point.y, z: this._focus.point.z },
      };
    return {
      offset: { x: this.offset_r.x, y: this.offset_r.y, z: this.offset_r.z },
      pan: { x: this.pan_r.x, y: this.pan_r.y, z: this.pan_r.z },
      up: { x: this.up_r.x, y: this.up_r.y, z: this.up_r.z },
      rotatingWith: this._cameraFrame.rotatingWith,
      focus,
      rotationMode: this.rotationMode,
      fovDeg: this.fovDeg,
      projectionMode: this.projectionMode,
      orthographicHalfHeight: this.orthographicHalfHeight,
      referencePlane: this._referencePlane,
    };
  }
}
