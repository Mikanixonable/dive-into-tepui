// フォーカス対象を注視点に置く軌道カメラ。フォーカスの毎フレーム解決と、フォーカス対象から
// 導かれる回転追従(慣性系・公転・自転・姿勢)を持つ。
//
// **chase は「動く実体を追っている視点」を指す語。** 天体や空間上の固定点ではなく機体
// (艦・敵・基地・弾薬)をフォーカスしている状態のことで、DOM id(#hud-chase-reset)・
// セーブキー(camera.chase)はこの意味で使う。カメラの実装が2つあった頃の名残ではない。
import * as THREE from 'three/webgpu';
import { Vec3, add, addScaled, cross, len, lenSq, norm, projectOntoPlane, scale, sub, v3 } from '../../math/vec3';
import { CELESTIAL_SHELL_RADIUS } from '../../render/stars';
import { Hud } from '../hud/hud';
import { MouseDelta } from '../input/input';
import { metersPerPixelAtDepth, ProjectionMode, Viewpoint } from '../../math/projection';
import { FrameAnchorSource, ReferenceFrame, FrameDir, FrameRotationSource, frameDir, framePoint, rotationSourceKey, toFrameDir, toInertialDir } from '../../physics/frame';
import { bodyAnchorSource, strongestAttractor } from '../../physics/attractor';
import { CelestialMotion, OrbitingMotion } from '../../physics/celestial-motion';
import type { CelestialSystem } from '../celestial/celestial-system';
import { Quat, qInvert, qMul, qNormalize, qRotate } from '../../math/quat';
import {
  LOCAL_FORWARD, LOCAL_RIGHT, LOCAL_UP, POLAR_PITCH_LIMIT, PolarEuler,
  eulerFromRotation, rotateByScreenDrag, rotationFromBasis, rotationFromEuler, sphericalOffset,
} from '../../math/orientation';
import { ECI_POLE, ECL_POLE_ECI, ECL_VERNAL } from '../../physics/ecliptic';
import { FocusTarget, focusTargetId, resolveFocusTarget, type FocusCandidate } from './focus-target';
import { CameraRotationFollowSaveData, FrameRotationSourceSaveData, FocusCameraSaveData } from '../save/save-data';

// 冥王星(遠日点約70AU)やエリス(遠日点約97AU)、散乱円盤の遠日点(数百AU)まで
// 視界に収められる引きの上限。
export const FOCUS_CAMERA_MIN_DIST = 1e3; // 天体フォーカス時の注視距離の下限 [m]
export const FOCUS_CAMERA_FOV_MIN = 15; // 最小垂直画角 [deg]
export const FOCUS_CAMERA_FOV_MAX = 120; // 最大垂直画角 [deg]
const FOCUS_CAMERA_MAX_DIST = 1e14;

// near は固定値ではなく、注視点までの距離をこの比で割った値を毎フレーム使う
// (near = dist / FOCUS_CAMERA_NEAR_RATIO)。比を大きくすると near が注視点に近づいて
// 手前がクリップされにくくなる。反転 32bit 深度では分解能が near に依らないので、
// この比が深度精度と取引になることはない。
const FOCUS_CAMERA_NEAR_RATIO = 1000;

// near = dist / FOCUS_CAMERA_NEAR_RATIO の比例則は dist の上限では星球シェル・
// 天球グリッド(CELESTIAL_SHELL_RADIUS)より大きくなる(dist=1e14 で near=1e11)。
// near クリップは光軸からの角度 θ に対して球殻上の点を R·cosθ まで切り詰めるので、
// R そのものでなく画面対角の半視野角 θ_diag での R·cosθ_diag を上限に取らないと、
// 画面中心だけ残して周辺・四隅の星が消える(FocusCamera.near 参照)。
// 1 未満のこの係数はその余弦にさらに掛ける安全マージン。
const FOCUS_CAMERA_NEAR_SHELL_MARGIN = 0.9;

// far も near と同様に固定値ではなく dist に連動させる
// (far = clamp(dist × FOCUS_CAMERA_FAR_RATIO, FOCUS_CAMERA_FAR_MIN, FOCUS_CAMERA_FAR_MAX))。
// far を dist に比例させないと、太陽・木星のような遠方天体は引いたカメラでは
// far 平面の外に出て消える。逆に近距離域で far を大きく取ることの費用は、反転 32bit 深度では
// 事実上ゼロ。
const FOCUS_CAMERA_FAR_RATIO = 100;

// 艦至近(dist = ENTITY_MIN_DIST)まで寄っても、見かけ直径が残る最遠の天体
// (直径 1.4e9 m の恒星を LOD 上限で見た 1.4e12 m)が far の外に出ないための下限。
const FOCUS_CAMERA_FAR_MIN = 2e12;

// FOCUS_CAMERA_MAX_DIST × FOCUS_CAMERA_FAR_RATIO と等しい値。これより小さいと
// 最大ズームアウト付近で far = dist × FAR_RATIO の比例則がこの上限に張り付いてしまい、
// 注視点より奥にある軌道線・天体が far 平面でクリップされる。
const FOCUS_CAMERA_FAR_MAX = 1e16;

// ホイール1目盛りのズーム率。exp(wheel × この値) を注視距離に掛ける(両ビュー共通)。
const WHEEL_ZOOM_RATE = 0.0015;
const DRAG_RAD_PER_PX = 0.005; // ドラッグ1pxあたりの視点回転量 [rad]

// 機体・固定点フォーカスでの最小注視距離 [m](艦を間近に見る寄り)。
const ENTITY_MIN_DIST = 12;

// 回転追従の選択(null は慣性系)。選択肢はフォーカス対象から導かれる —
// availableRotationFollows() が唯一の出所。'attitude' はフォーカス機体の姿勢への追従で、
// ReferenceFrame ではなくカメラ内の合成で実現される。
export type CameraRotationFollow = FrameRotationSource | { readonly kind: 'attitude' };

// 選択の同一性の照合キー(選択 UI・妥当性検査が使う)。
export function rotationFollowKey(follow: CameraRotationFollow | null): string {
  if (follow === null) return '';
  return follow.kind === 'attitude' ? 'attitude' : rotationSourceKey(follow);
}

// 保存が無いときの初期状態。yaw/pitch/dist は注視点まわりの初期視点(sphericalOffset 参照)。
// follow は選択肢の検査を通さず適用される — 対象が未解決でも選択は保持され、成立可否は
// update の猶予検査に委ねられる。
export interface FocusCameraInitial {
  readonly yaw: number;
  readonly pitch: number;
  readonly dist: number;
  readonly fovDeg: number;
  readonly focus: FocusTarget;
  readonly follow: CameraRotationFollow | null;
}

// カメラのビュー差(フォーカス喪失時の振る舞い・初期状態)と、姿勢の解決の差し込み口。
export interface FocusCameraConfig {
  // 'hold' は解決失敗が続いても最後に解決できた位置に留まる(戦闘ビュー)。
  // 'fallToOrigin' は2フレーム連続で失敗したら原点天体へフォーカスを戻す(マップビュー)。
  readonly focusLossPolicy: 'hold' | 'fallToOrigin';
  readonly initial: FocusCameraInitial;
  // フォーカス id(機体・役割トークン)の時刻 t における姿勢。天体・解決不能は null。
  readonly attitudeOf: (id: string, t: number) => Quat | null;
}

// マップビュー用の初期状態(地球を見下ろす従来の既定)。
export function defaultMapViewInitial(celestialSystem: CelestialSystem): FocusCameraInitial {
  return {
    yaw: 0.7, pitch: 0.45, dist: 4.5e7, fovDeg: FOCUS_CAMERA_FOV,
    focus: { kind: 'object', id: celestialSystem.origin.id },
    follow: null,
  };
}

// セーブデータの rotatingWith を FrameRotationSource へ変換する。旧セーブは公転対象の id を
// 文字列(または回さないなら null)でそのまま持っていたので、その形は公転として受ける。
function rotationSourceFromSaveData(saved: FrameRotationSourceSaveData | string | null): FrameRotationSource | null {
  if (saved === null) return null;
  if (typeof saved === 'string') return { kind: 'revolution', id: saved };
  return { kind: saved.kind, id: saved.id };
}

// セーブデータの rotatingWith を CameraRotationFollow へ変換する(姿勢追従も受ける)。
function rotationFollowFromSaveData(saved: CameraRotationFollowSaveData | string | null): CameraRotationFollow | null {
  if (saved !== null && typeof saved === 'object' && saved.kind === 'attitude') return { kind: 'attitude' };
  return rotationSourceFromSaveData(saved);
}

const WORLD_UP = v3(0, 1, 0);
const FOCUS_CAMERA_FOV = 50;
type CameraRotationMode = 'quaternion' | 'euler';
export type CameraReferencePlane = 'ecliptic' | 'equator' | 'moonOrbit';
export type CameraReferenceView = 'above' | 'side';

function frameDirVector(value: FrameDir): Vec3 {
  return v3(value.x, value.y, value.z);
}

export class FocusCamera {
  // 透視/平行の THREE カメラ実体。どちらを描画に使うかは projectionMode で決まる。
  private readonly perspectiveCamera: THREE.PerspectiveCamera;
  private readonly orthographicCamera: THREE.OrthographicCamera;
  private fovDeg = FOCUS_CAMERA_FOV;
  private rotationMode: CameraRotationMode;
  private projectionMode: ProjectionMode;
  private orthographicHalfHeight = 1;
  // rotationQ はカメラのローカル(+Z=注視点からカメラ、+Y=画面上)を cameraFrame へ
  // 写すクォータニオン。オイラー操作も最終的には必ずこの値へ変換して描画する。
  private rotationQ: Quat;
  private euler: PolarEuler;

  // offset_r … 注視点 → カメラの相対位置ベクトル(方位・仰角・距離を兼ねる)
  // pan_r    … focus → 注視点のパン変位
  // up_r     … カメラの上方向(テンキー0/1のロールで offset_r まわりに回る)
  private offset_r: FrameDir;
  private pan_r: FrameDir;
  private up_r: FrameDir;
  // カメラ視点を固定する座標系。姿勢追従中は慣性系に固定し、姿勢は rotationQ への合成で掛ける。
  private _cameraFrame: ReferenceFrame;
  // 姿勢追従(rotationFollow = 'attitude')の状態。rotationQ は追従中、対象姿勢からの相対値になる。
  // lastAttitudeQ が null の間は絶対値のまま扱い、初めて姿勢が引けたときに相対値へ読み替える
  // (ロード直後がこの状態 — 保存された向きは絶対値で、保存時の姿勢は残っていない)。
  private _attitudeFollow = false;
  private lastAttitudeQ: Quat | null = null;
  // 選択中の追従が選択肢から外れた連続フレーム数。役割・機体の一時的な解決失敗に、
  // フォーカスと同じ2フレームの猶予を与える。
  private staleFollowFrames = 0;
  private displayTime = 0; // set cameraFrame の座標変換に使う。線・メッシュと同じ表示時刻に揃える。
  // 最新の update 呼び出しが受け取った FrameAnchorSource。reset/resetPan/cameraFrame setter は
  // フレームの外(入力ハンドラ)から呼ばれるため、update と同じ値をここから読む。
  private frameAnchors: FrameAnchorSource = bodyAnchorSource([], 0);
  private _focus: FocusTarget;
  private missingFocusFrames = 0;
  private lastResolvedFocus = v3();
  private _focusVelocity: Vec3 | null = null;

  get focus(): FocusTarget { return this._focus; }

  // 注視点の ECI 速度。速度を答えられない対象を注視しているあいだは null。
  get focusVelocity(): Vec3 | null { return this._focusVelocity; }

  // target が 'point'(座標系に焼き込んだ固定点)で frame が回転系なら、その天体の
  // 公転に追随する固定点になる。フォーカスが変わると回転追従の選択肢も変わるので、
  // 外れた選択は慣性系へ落とす。
  setFocusTarget(target: FocusTarget, resetPan = true): void {
    this._focus = target;
    this.missingFocusFrames = 0;
    if (resetPan) this.resetPan();
    const follow = this.rotationFollow;
    if (follow !== null && !this.isFollowAvailable(follow)) this.setRotationFollow(null);
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
    fovDeg: FOCUS_CAMERA_FOV,
    aspect: window.innerWidth / window.innerHeight,
    projection: 'perspective',
  };

  // THREE.PerspectiveCamera と初期視点(offset_r/pan_r/up_r/座標系/フォーカス)を組む。saved が
  // あればその値から、無ければ既定の見下ろし視点から組む。座標系は必ず frames.frameOf 経由で
  // 解決する — ReferenceFrame をリテラルで組むと参照同一性が崩れる(frame.ts 参照)。
  constructor(
    private readonly _hud: Hud,
    private readonly celestialSystem: CelestialSystem,
    private readonly config: FocusCameraConfig,
    saved?: FocusCameraSaveData,
  ) {
    this.rotationMode = saved?.rotationMode ?? 'euler';
    this.projectionMode = saved?.projectionMode === 'orthographic' ? 'orthographic' : 'perspective';
    this._referencePlane = saved?.referencePlane === 'ecliptic' || saved?.referencePlane === 'moonOrbit'
      ? saved.referencePlane : 'equator';
    this.fovDeg = this.clampFov(saved?.fovDeg ?? config.initial.fovDeg);
    const frames = celestialSystem.frames;
    if (saved) {
      const savedFollow = rotationFollowFromSaveData(saved.rotatingWith);
      if (savedFollow?.kind === 'attitude') {
        this._cameraFrame = frames.inertialFrame;
        this._attitudeFollow = true;
      } else {
        this._cameraFrame = frames.frameOf(celestialSystem.origin.id, savedFollow ?? null);
      }
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
      const init = config.initial;
      this._focus = init.focus;
      this._cameraFrame = frames.inertialFrame;
      this.applyInitialFollow(init.follow);
      const offset = sphericalOffset(init.yaw, init.pitch, init.dist);
      this.offset_r = frameDir(offset.x, offset.y, offset.z);
      this.pan_r = frameDir(0, 0, 0);
      this.up_r = frameDir(WORLD_UP.x, WORLD_UP.y, WORLD_UP.z);
    }
    this.rotationQ = rotationFromBasis(frameDirVector(this.offset_r), frameDirVector(this.up_r));
    this.euler = this.toEuler(this.rotationQ);
    const defaultHalfHeight = this.dist * Math.tan(THREE.MathUtils.degToRad(this.fovDeg * 0.5));
    const savedHalfHeight = saved?.orthographicHalfHeight;
    const halfHeight = savedHalfHeight !== undefined && Number.isFinite(savedHalfHeight) ? savedHalfHeight : defaultHalfHeight;
    this.orthographicHalfHeight = Math.max(FOCUS_CAMERA_MIN_DIST * 1e-6,
      Math.min(FOCUS_CAMERA_MAX_DIST, halfHeight));
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
    return Math.max(FOCUS_CAMERA_FOV_MIN, Math.min(FOCUS_CAMERA_FOV_MAX,
      Number.isFinite(fovDeg) ? fovDeg : FOCUS_CAMERA_FOV));
  }

  // カメラの位置に応じて、ロールリセットおよびオイラー極軸の基準ベクトル(ECI 座標系)を返す。
  // カメラが天体近傍(1,000,000 km 以内)にある場合は最寄り天体の自転軸、広域にある場合は黄道面法線。
  private referenceUpAxisEci(): Vec3 {
    if (this.frameAnchors.bodies.length > 0) {
      const cameraPos = this.viewpoint.position;
      const pivot = this.frameAnchors.bodiesPivot;
      const nearest = strongestAttractor(cameraPos, this.frameAnchors.bodies, pivot);
      const distToBody = len(sub(cameraPos, nearest.positionAt(pivot)));
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

  // 分解と組み立ては math/polar-euler が持つ。カメラが与えるのは極軸だけ。
  private toEuler(rotation: Quat): PolarEuler {
    return eulerFromRotation(rotation, this.eulerPolarAxis());
  }

  private fromEuler(euler: PolarEuler): Quat {
    return rotationFromEuler(euler, this.eulerPolarAxis());
  }

  // 実効回転(姿勢追従を掛けた後の向き)を offset/up の基底で置き直す。
  private setRotationBasis(offset: Vec3, up: Vec3): void {
    this.storeEffectiveRotation(rotationFromBasis(offset, up));
    this.offset_r = frameDir(offset.x * this.dist, offset.y * this.dist, offset.z * this.dist);
    this.up_r = frameDir(up.x, up.y, up.z);
    this.euler = this.toEuler(this.rotationQ);
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
    this.setFovDeg(FOCUS_CAMERA_FOV);
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
    const next = Math.max(this.minDist, Math.min(FOCUS_CAMERA_MAX_DIST, distance));
    if (!(current > 0) || next === current) return;
    this.offset_r = frameDir(
      this.offset_r.x * next / current,
      this.offset_r.y * next / current,
      this.offset_r.z * next / current,
    );
  }

  public setCameraRotationMode(mode: CameraRotationMode): void {
    if (mode === this.rotationMode) return;
    if (mode === 'euler') this.euler = this.toEuler(this.rotationQ);
    else this.rotationQ = this.fromEuler(this.euler);
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
    const currentOffset = qRotate(this.composeAttitude(this.rotationQ), LOCAL_FORWARD);
    let offset: Vec3;
    let up: Vec3;
    if (view === 'above') {
      offset = normal;
      up = projectOntoPlane(frameDirVector(toFrameDir(tf, ECL_VERNAL)), normal);
      if (lenSq(up) < 1e-8) up = projectOntoPlane(LOCAL_RIGHT, normal);
    } else {
      offset = projectOntoPlane(currentOffset, normal);
      if (lenSq(offset) < 1e-8) offset = projectOntoPlane(frameDirVector(toFrameDir(tf, ECL_VERNAL)), normal);
      if (lenSq(offset) < 1e-8) offset = projectOntoPlane(LOCAL_RIGHT, normal);
      up = normal;
    }
    offset = norm(offset);
    up = norm(up);
    this.setRotationBasis(offset, up);
    this.resetPan();
    this._hud.hint(view === 'above' ? '基準面の真上を表示' : '基準面の真横を表示');
  }

  // CameraSystem.sync が読む近クリップ距離。dist に比例させることで、どのズーム段でも
  // 注視点を切り落とさない(FOCUS_CAMERA_NEAR_RATIO 参照)。
  // near クリップは光軸からの角度 θ の点を R·cosθ で切り詰める平面なので、画面対角の
  // 半視野角(fov・aspect から求まる)での R·cosθ_diag を超えないようクランプし、
  // 星球シェル・天球グリッドの周辺・四隅がクリップされないようにする。
  get near(): number {
    const halfV = THREE.MathUtils.degToRad(this.fov * 0.5);
    const halfH = Math.atan(Math.tan(halfV) * window.innerWidth / window.innerHeight);
    const halfDiag = Math.atan(Math.hypot(Math.tan(halfV), Math.tan(halfH)));
    const nearMax = CELESTIAL_SHELL_RADIUS * Math.cos(halfDiag) * FOCUS_CAMERA_NEAR_SHELL_MARGIN;
    return Math.min(nearMax, this.dist / FOCUS_CAMERA_NEAR_RATIO);
  }

  // CameraSystem.sync が読む遠クリップ距離。dist に比例させることで、引いたカメラでも
  // 太陽・木星のような遠方天体が far の外に出て消えない(FOCUS_CAMERA_FAR_RATIO 参照)。
  get far(): number {
    return Math.min(FOCUS_CAMERA_FAR_MAX, Math.max(FOCUS_CAMERA_FAR_MIN, this.dist * FOCUS_CAMERA_FAR_RATIO));
  }

  // 現在のフォーカス対象がクランプ後も表面下にめり込まない最小注視距離。
  // 天体は半径まで、機体・固定点は艦を間近に見る距離まで寄れる。
  private get minDist(): number {
    const body = this._focus.kind === 'object' ? this.celestialSystem.find(this._focus.id) : null;
    if (body === null) return ENTITY_MIN_DIST;
    return Math.max(FOCUS_CAMERA_MIN_DIST, body.def.radius);
  }

  // ロールを初期状態(天体近傍: 自転軸、広域: 黄道面法線)に戻し、パンでフォーカスから
  // ずれていた注視点もフォーカス位置へ戻す。
  reset(): void {
    const tf = this.celestialSystem.frames.transformAt(this._cameraFrame, this.displayTime, this.frameAnchors);
    const offset = qRotate(this.composeAttitude(this.rotationQ), LOCAL_FORWARD);
    const upAxisEci = this.referenceUpAxisEci();
    const up = norm(frameDirVector(toFrameDir(tf, upAxisEci)));
    const projectedUp = norm(projectOntoPlane(up, offset));
    this.setRotationBasis(offset, projectedUp);
    this.resetPan();
    this._hud.hint('マップビューの視点をリセット');
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

  // 注視点の位置を返し、速度は focusVelocity へ残す。候補が一時的に欠けたフレームでは直前の
  // 注視点を保ち、連続して消えた対象は ECI 原点へ戻す。
  // point は座標系が回っていれば ECI 座標が動くため、毎フレーム焼き直す。
  private resolveFocus(candidates: readonly FocusCandidate[], displayTime: number, frameAnchors: FrameAnchorSource): Vec3 {
    const result = resolveFocusTarget(
      this._focus, candidates, displayTime, frameAnchors,
      this.celestialSystem.frames, this.celestialMotionOf,
      (id, t) => this.celestialSystem.stateAt(id, t),
      { missingFocusFrames: this.missingFocusFrames, lastResolvedFocus: this.lastResolvedFocus },
    );
    this.missingFocusFrames = result.missingFocusFrames;
    this.lastResolvedFocus = result.lastResolvedFocus;
    this._focusVelocity = result.vel;
    if (result.fallToOrigin) {
      // 'hold' は注視点を最後に解決できた位置に留める。対象が再び解決できれば追従が戻る。
      if (this.config.focusLossPolicy === 'hold') return this.lastResolvedFocus;
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

  // 選択中の回転追従(null は慣性系)。
  get rotationFollow(): CameraRotationFollow | null {
    return this._attitudeFollow ? { kind: 'attitude' } : this._cameraFrame.rotatingWith;
  }

  // いま選べる回転追従の選択肢(慣性系は常に選べるので含めない)。フォーカスが天体なら
  // 自分の公転・子の公転・自分の自転、機体・役割なら(周回中のみ)公転と姿勢。固定点は空。
  availableRotationFollows(displayTime: number): readonly CameraRotationFollow[] {
    if (this._focus.kind === 'point') return [];
    const id = this._focus.id;
    const out: CameraRotationFollow[] = [];
    const body = this.celestialSystem.find(id);
    if (body !== null) {
      if (body.motion.primary !== null) out.push({ kind: 'revolution', id });
      for (const motion of this.celestialSystem.celestialMotions) {
        if (motion.primary?.id === id) out.push({ kind: 'revolution', id: motion.id });
      }
      if (body.motion.spinRotationAt(displayTime) !== null) out.push({ kind: 'spin', id });
    } else {
      if (this.frameAnchors.attractorOf(id, displayTime) !== null) out.push({ kind: 'revolution', id });
      if (this.config.attitudeOf(id, displayTime) !== null) out.push({ kind: 'attitude' });
    }
    return out;
  }

  private isFollowAvailable(follow: CameraRotationFollow): boolean {
    const key = rotationFollowKey(follow);
    return this.availableRotationFollows(this.displayTime).some((f) => rotationFollowKey(f) === key);
  }

  // 回転追従を切り替える。選択肢に無い値は慣性系として扱う。どの切替でも視点は跳ばない —
  // 保持していた向きを新しい基準へ読み替える。
  setRotationFollow(follow: CameraRotationFollow | null): void {
    const valid = follow !== null && this.isFollowAvailable(follow) ? follow : null;
    this.bakeOutAttitude();
    if (valid?.kind === 'attitude') {
      const id = focusTargetId(this._focus);
      const att = id !== undefined ? this.config.attitudeOf(id, this.displayTime) : null;
      if (att === null) return;
      this.setCameraRotation(null);
      this.rotationQ = qNormalize(qMul(qInvert(att), this.rotationQ));
      this.lastAttitudeQ = att;
      this._attitudeFollow = true;
      this.euler = this.toEuler(this.rotationQ);
      return;
    }
    this.setCameraRotation(valid);
  }

  // [G] の実体: フォーカスが機体なら姿勢追従⇄慣性系をトグルして true。それ以外は何もせず false。
  toggleAttitudeFollow(): boolean {
    if (this._attitudeFollow) {
      this.bakeOutAttitude();
      return true;
    }
    if (!this.isFollowAvailable({ kind: 'attitude' })) return false;
    this.setRotationFollow({ kind: 'attitude' });
    return this._attitudeFollow;
  }

  // フォーカス・回転追従・視点・画角を初期状態(config.initial)へ戻す。
  // 姿勢追従中にリセットすると、既定の視点は追従基準に対して置かれる(= 対象の後方見下ろしへ戻る)。
  resetToInitial(): void {
    const init = this.config.initial;
    this._focus = init.focus;
    this.missingFocusFrames = 0;
    this.applyInitialFollow(init.follow);
    const offset = sphericalOffset(init.yaw, init.pitch, init.dist);
    this.offset_r = frameDir(offset.x, offset.y, offset.z);
    this.up_r = frameDir(WORLD_UP.x, WORLD_UP.y, WORLD_UP.z);
    this.rotationQ = rotationFromBasis(offset, WORLD_UP);
    this.euler = this.toEuler(this.rotationQ);
    this.fovDeg = this.clampFov(init.fovDeg);
    this.resetPan();
  }

  // 初期の回転追従を、選択肢の検査を通さず適用する。対象が未解決でも選択は保持され、
  // 成立可否は update の猶予検査に委ねられる。姿勢追従中に姿勢追従を再適用したときは
  // 基準の姿勢を保つ(rotationQ を相対値として解釈し続けるため)。
  private applyInitialFollow(follow: CameraRotationFollow | null): void {
    const keepAttitude = follow?.kind === 'attitude' && this._attitudeFollow ? this.lastAttitudeQ : null;
    this.staleFollowFrames = 0;
    this.lastAttitudeQ = keepAttitude;
    if (follow?.kind === 'attitude') {
      this._cameraFrame = this.celestialSystem.frames.inertialFrame;
      this._attitudeFollow = true;
      return;
    }
    this._attitudeFollow = false;
    this._cameraFrame = this.celestialSystem.frames.frameOf(this.celestialSystem.origin.id, follow ?? null);
  }

  // 姿勢追従を解き、rotationQ を絶対の向きへ読み替える(掛かっていなければ何もしない)。
  private bakeOutAttitude(): void {
    if (!this._attitudeFollow) return;
    if (this.lastAttitudeQ !== null) {
      this.rotationQ = qNormalize(qMul(this.lastAttitudeQ, this.rotationQ));
    }
    this._attitudeFollow = false;
    this.lastAttitudeQ = null;
    this.euler = this.toEuler(this.rotationQ);
  }

  // 選択中の追従が選択肢から外れていれば慣性系へ落とす。一時的な解決失敗
  // (役割の乗り換え中など)に2フレームの猶予を与える。
  private dropStaleRotationFollow(): void {
    const follow = this.rotationFollow;
    if (follow === null || this.isFollowAvailable(follow)) {
      this.staleFollowFrames = 0;
      return;
    }
    this.staleFollowFrames++;
    if (this.staleFollowFrames < 2) return;
    this.staleFollowFrames = 0;
    this.setRotationFollow(null);
  }

  // 姿勢追従の合成に使う姿勢を最新へ。解決できないフレームは直前の姿勢を保つ(視点が跳ねない)。
  private refreshAttitude(): void {
    if (!this._attitudeFollow) return;
    const id = focusTargetId(this._focus);
    const att = id !== undefined ? this.config.attitudeOf(id, this.displayTime) : null;
    if (att === null) return;
    if (this.lastAttitudeQ === null) {
      // 絶対値で持っていた向き(ロード直後)を、初めて引けた姿勢からの相対値へ読み替える。
      this.rotationQ = qNormalize(qMul(qInvert(att), this.rotationQ));
    }
    this.lastAttitudeQ = att;
  }

  // rotationQ に姿勢追従を掛けた、描画・入力に使う実効回転。
  private composeAttitude(rot: Quat): Quat {
    return this._attitudeFollow && this.lastAttitudeQ !== null ? qMul(this.lastAttitudeQ, rot) : rot;
  }

  // 実効回転から rotationQ へ書き戻す(姿勢追従中は相対値へ読み替える)。
  private storeEffectiveRotation(q: Quat): void {
    this.rotationQ = this._attitudeFollow && this.lastAttitudeQ !== null
      ? qNormalize(qMul(qInvert(this.lastAttitudeQ), q)) : qNormalize(q);
  }

  // カメラ視点の回転対象を切り替える。中心は常に ECI 中心天体 — offset_r/pan_r/up_r は
  // 方向(FrameDir)しか持たず原点移動の影響を受けないので、中心をどれにしても視点は変わらない。
  // 切替の瞬間にカメラ視点(ECI)を跳ばせないよう、現在の座標系から新しい座標系へ変換し直す。
  private setCameraRotation(rotatingWith: FrameRotationSource | null): void {
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
    this.rotationQ = rotationFromBasis(frameDirVector(this.offset_r), frameDirVector(this.up_r));
    this.euler = this.toEuler(this.rotationQ);
  }

  // マウス/キー入力から viewpoint を1フレーム分更新する。displayTime は線・メッシュが描かれる
  // のと同じ表示時刻 — 座標系変換をそこに揃えないと、回転系選択時に線・メッシュだけが
  // displayTime へ動いてカメラだけ現在時刻に取り残される。
  update(
    mouse: MouseDelta,
    keyYawRad: number,
    keyPitchRad: number,
    displayTime: number,
    candidates: readonly FocusCandidate[],
    frameAnchors: FrameAnchorSource,
  ): void {
    this.displayTime = displayTime;
    this.frameAnchors = frameAnchors;
    this.dropStaleRotationFollow();
    this.refreshAttitude();
    const focus = this.resolveFocus(candidates, displayTime, frameAnchors);
    const tf = this.celestialSystem.frames.transformAt(this._cameraFrame, displayTime, frameAnchors);
    // オイラー操作の極軸は座標系の幾何で定義されるので、姿勢追従中はクォータニオン経路で回す。
    const eulerActive = this.rotationMode === 'euler' && !this._attitudeFollow;
    if (eulerActive) {
      this.rotationQ = this.fromEuler(this.euler);
    }
    // q は姿勢追従を掛けた実効回転。入力はこれに対して適用し、末尾で rotationQ へ書き戻す。
    let q = this.composeAttitude(this.rotationQ);
    let panEci = toInertialDir(tf, this.pan_r);

    // ホイールで距離を、ドラッグ/キーで視点方向を更新する。
    const zoomFactor = Math.exp(mouse.wheel * WHEEL_ZOOM_RATE);
    const dist = this.projectionMode === 'orthographic'
      ? this.dist
      : Math.max(this.minDist, Math.min(FOCUS_CAMERA_MAX_DIST, this.dist * zoomFactor));
    if (this.projectionMode === 'orthographic' && mouse.wheel !== 0) {
      this.orthographicHalfHeight = Math.max(FOCUS_CAMERA_MIN_DIST * 1e-6,
        Math.min(FOCUS_CAMERA_MAX_DIST, this.orthographicHalfHeight * zoomFactor));
    }
    const yaw = mouse.dx * DRAG_RAD_PER_PX - keyYawRad;
    const pitch = mouse.dy * DRAG_RAD_PER_PX + keyPitchRad;
    if (eulerActive) {
      this.euler.yaw += yaw;
      this.euler.pitch = Math.max(-POLAR_PITCH_LIMIT, Math.min(POLAR_PITCH_LIMIT, this.euler.pitch + pitch));
      this.euler.roll += mouse.roll;
      q = this.fromEuler(this.euler);
    } else {
      q = rotateByScreenDrag(
        q, mouse.dx * DRAG_RAD_PER_PX, -mouse.dy * DRAG_RAD_PER_PX, mouse.roll, keyYawRad, keyPitchRad,
      );
    }
    this.storeEffectiveRotation(q);
    const offFrame = qRotate(q, LOCAL_FORWARD);
    const upFrame = qRotate(q, LOCAL_UP);
    const offEci = scale(toInertialDir(tf, frameDir(offFrame.x, offFrame.y, offFrame.z)), dist);
    const newDir = norm(offEci);
    const upEci = norm(projectOntoPlane(toInertialDir(tf, frameDir(upFrame.x, upFrame.y, upFrame.z)), newDir));

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
    this.euler = this.toEuler(this.rotationQ);
  }

  // offset_r/pan_r/up_r・視点の座標系・フォーカス対象をセーブデータへ書き出す。
  serialize(): FocusCameraSaveData {
    const focus: FocusCameraSaveData['focus'] = this._focus.kind === 'object'
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
      rotatingWith: this._attitudeFollow ? { kind: 'attitude' } : this._cameraFrame.rotatingWith,
      focus,
      rotationMode: this.rotationMode,
      fovDeg: this.fovDeg,
      projectionMode: this.projectionMode,
      orthographicHalfHeight: this.orthographicHalfHeight,
      referencePlane: this._referencePlane,
    };
  }
}
