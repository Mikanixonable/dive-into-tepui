// 描画テスト環境の 1 ビュー。ケースを組み、ゲーム本体と同じ RenderPipeline でキャンバスへ描く。
// 絵の撮影(PNG)と、CPU / GPU それぞれの所要時間の計測もここが担う。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { GPU_PASS_COUNT, GPU_PASS_LABELS, GpuTimings } from '../../src/gpu-timings';
import { ProteinMotionMetricsRecorder, type ProteinMotionMetricSummary } from '../../src/protein-motion-metrics';
import { RenderPipeline } from '../../src/render/pipeline/render-pipeline';
import { LIT_OPAQUE_LAYER } from '../../src/render/pipeline/lit-layer';
import {
  SUN_COLOR, SUN_IRRADIANCE_1AU, SUN_RADIANT_INTENSITY, sunIrradianceAtDistance,
} from '../../src/render/pipeline/sun-light';
import { planetRadiance } from '../../src/render/pipeline/lighting/planet-light-source';
import { AMBIENT_WEAK } from '../../src/render/pipeline/lighting/ambient-source';
import { reversedOpaqueSort, reversedTransparentSort } from '../../src/render/pipeline/reversed-sort';
import { ATMOSPHERE_QUALITY, QUALITY_PRESETS, withGraphicsOption } from '../../src/render/graphics-settings';
import { ATMOSPHERE_DETAIL, ATMOSPHERE_DETAIL_OF_QUALITY } from '../../src/render/pipeline/atmosphere-pass';
import { rankAtmospheres } from '../../src/render/atmosphere-params';
import type { GraphicsOptionKey, GraphicsSettingsData } from '../../src/render/graphics-settings';
import { lambertPhase } from '../../src/physics/lambert-sphere';
import { AU } from '../../src/physics/planet-orbit';
import { R_SUN } from '../../src/physics/solar-system';
import type { DebugTargetId } from '../../src/render/pipeline/debug-target';
import type { RenderStyle } from '../../src/render/render-style';
import { CASES, sunDiameterPx, type CaseName, type LabCase, SUN_DIR, VIEW_HEIGHT, VIEW_WIDTH } from './cases';

export interface LabDistribution {
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

export interface LabMeasurement {
  readonly caseName: CaseName;
  readonly frames: number;
  readonly cpuRenderMs: LabDistribution;
  readonly gpuSupported: boolean;
  readonly gpuPassMs: Readonly<Record<string, LabDistribution>>;
  readonly proteinMotion: ProteinMotionMetricSummary;
  readonly proteinCase?: LabCase['proteinMotion'];
}

const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// 恒星を置く位置。向きも距離も観察のつまみが正本(ケースの sunDistance はその初期値)で、
// ゲーム本体と同じ放射強度を渡すので、そこで受ける放射照度もゲーム本体の同じ距離と一致する。
// 毎フレーム書き込む。
const SUN_POSITION = new THREE.Vector3();

// シーン光源(平行光)を置く距離 [m]。向きだけが意味を持つので、ケースの広がりより十分遠ければよい。
const SUN_LIGHT_DISTANCE = 1e5;

// 恒星方向とカメラ位置を毎フレーム組み立てる書き込み先。
const SUN_DIRECTION = new THREE.Vector3();
const CAMERA_OFFSET = new THREE.Vector3();
// 天体照の位相角を測る差分ベクトルの書き込み先。
const SUN_TO_LIGHT = new THREE.Vector3();
const ORIGIN_TO_LIGHT = new THREE.Vector3();

// カメラの仰角の限界 [deg]。真上・真下では上方向と視線が平行になり、姿勢が決まらない。
export const MAX_CAMERA_ELEVATION_DEG = 89;

// カメラのズーム(画角を狭める倍率)の常用対数の上限。0 がケース既定の画角。
export const MAX_CAMERA_ZOOM_LOG = 2;

// 恒星までの距離(天文単位)の常用対数の下限・上限。**対数で持つ** — 見かけ径が 1px を切る
// あたりの変化を読みたいので、AU を直に刻むと近距離側が粗すぎて追えない。下限の 0.01 AU は
// 太陽が画角(50°)いっぱいに広がる距離、上限の 100 AU は海王星軌道の外側。
export const MIN_SUN_DISTANCE_LOG_AU = -2;
export const MAX_SUN_DISTANCE_LOG_AU = 2;

// 観察の向き。角度は度、sunDistanceLogAu は恒星までの距離(天文単位)の常用対数、
// cameraDistanceLog はケース既定の距離に対する倍率の常用対数、cameraZoomLog はケース既定の
// 画角を狭める倍率の常用対数。
export type LabViewAngles = {
  readonly sunAzimuthDeg: number;
  readonly sunElevationDeg: number;
  readonly sunDistanceLogAu: number;
  readonly cameraAzimuthDeg: number;
  readonly cameraElevationDeg: number;
  readonly cameraDistanceLog: number;
  readonly cameraZoomLog: number;
};

// 方位角・仰角 [deg] から単位ベクトルを組む。方位角 0 が +Z、+90 度が +X。
function directionFromAngles(azimuthDeg: number, elevationDeg: number, out: THREE.Vector3): THREE.Vector3 {
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const horizontal = Math.cos(elevation);
  return out.set(Math.sin(azimuth) * horizontal, Math.sin(elevation), Math.cos(azimuth) * horizontal);
}

// directionFromAngles の逆写像。長さ 0 でない任意のベクトルを受ける。
function anglesFromDirection(v: THREE.Vector3): { azimuthDeg: number; elevationDeg: number } {
  const unitY = THREE.MathUtils.clamp(v.y / Math.max(v.length(), 1e-12), -1, 1);
  return {
    azimuthDeg: THREE.MathUtils.radToDeg(Math.atan2(v.x, v.z)),
    elevationDeg: THREE.MathUtils.radToDeg(Math.asin(unitY)),
  };
}

export class LabView {
  private readonly scene = new THREE.Scene();
  // ケースの太陽方向へ向け直すために持つ。恒星の位置と同じ向きを指す。
  private readonly sun = new THREE.DirectionalLight(SUN_COLOR.getHex(), SUN_IRRADIANCE_1AU);
  // 撮影先。合成パスが既に sRGB へ変換した値を書くので、素の RGBA8 で受ける
  // (-srgb フォーマットにすると二重変換になり、撮った PNG だけが白っぽくなる)。
  // 深度は 3D UI パスが要る — 合成パスが G バッファの深度をここへ複製し、線はそれに対して
  // 深度テストする。持たせないと線が不透明物を貫通して常に手前へ出る。
  private readonly captureTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });
  private current: LabCase | null = null;
  // スタイルを差し替えるとケースを組み直すので、いま出ているケースの名前も持つ。
  private currentName: CaseName | null = null;
  // 画面全体の見せ方。ゲーム本体と違い保存はせず、起動のたびに写実から始める。
  private style: RenderStyle = 'realistic';
  private lastRenderCpuMs = 0;
  // カメラが周回する点。ケースの注視点を視線上へ落としたもの。
  private readonly pivot = new THREE.Vector3();
  // ケース既定のカメラ距離 [m]。cameraDistanceLog の基準になる。
  private defaultCameraDistance = 1;
  // ケース既定の画角 [deg]。cameraZoomLog の基準になる。
  private defaultCameraFovDeg = 1;
  private angles: LabViewAngles = {
    sunAzimuthDeg: 0, sunElevationDeg: 0, sunDistanceLogAu: 0,
    cameraAzimuthDeg: 0, cameraElevationDeg: 0, cameraDistanceLog: 0, cameraZoomLog: 0,
  };
  // 描画品質設定のうち、パイプラインが読むものだけを操作の対象にする。ゲーム本体と保存先を
  // 分けるため、ここが値の正本を持つ(ブラウザへは残さない)。
  private graphicsData: GraphicsSettingsData = QUALITY_PRESETS.high;
  private readonly scratchBox = new THREE.Box3();
  private readonly caseCenterVector = new THREE.Vector3();
  private readonly scratchVector = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();

  private constructor(
    private readonly renderer: WebGPURenderer,
    private readonly pipeline: RenderPipeline,
    private readonly gpu: GpuTimings,
  ) {
    // RenderPipeline はカメラのチャンネルを一時的に絞る。シーンルートが既定の 0 だけだと
    // その時点で子要素の走査が止まるため、コンテナとして全チャンネルを受ける。
    this.scene.layers.enableAll();
    // NodeMaterial はカメラのチャンネルと重なる光源が1つも無いと照明モデルを組まない。
    // マテリアルパスはカメラを LIT_OPAQUE_LAYER 単独へ絞るので、光源も同チャンネルへ属させる。
    this.sun.layers.enable(LIT_OPAQUE_LAYER);
    this.scene.add(this.sun);
  }

  static async create(canvas: HTMLCanvasElement): Promise<LabView> {
    // 深度の扱いはゲーム本体(src/render/scene.ts)と揃える。ここが違うと、測りたい深度の
    // 分解能そのものが本番と別物になる。
    const renderer = new WebGPURenderer({
      canvas, reversedDepthBuffer: true,
    });
    renderer.setOpaqueSort(reversedOpaqueSort);
    renderer.setTransparentSort(reversedTransparentSort);
    renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT);
    await renderer.init();
    const gpu = new GpuTimings(renderer);
    gpu.enabled = true;
    const pipeline = new RenderPipeline(renderer, QUALITY_PRESETS.high, gpu);
    pipeline.ambient.setFraction(AMBIENT_WEAK);
    return new LabView(renderer, pipeline, gpu);
  }

  // ケースを差し替え、観察の向きをそのケースの既定へ戻して描く。
  show(name: CaseName): void {
    this.build(name);
    this.resetView();
    this.render();
  }

  // 表示スタイルを差し替え、いま出ているケースをそのスタイルで組み直す。**観察の向きは戻さない**
  // — 写実と模式図を同じ構図で見比べるための切り替えなので、既定へ戻すと見比べられない。
  setStyle(style: RenderStyle): void {
    this.style = style;
    if (this.currentName !== null) this.build(this.currentName);
    this.render();
  }

  // ケースをいまのスタイルで組み直してシーンへ載せ、それを現在のケースにする。前のケースは
  // シーンから外すだけで解放しない — 球の単位ジオメトリは LOD 段ごとに全利用元で共有されて
  // いて、ここで捨てると次のケースが壊れる。
  private build(name: CaseName): void {
    if (this.current !== null) {
      this.scene.remove(...this.current.objects);
      this.current.star?.dispose();
      disposeCaseObjects(this.current);
    }
    const built = CASES[name](this.style, this.pipeline.sunOcclusion, this.pipeline.sunLight);
    this.scene.add(...built.objects);
    built.star?.addTo(this.scene);
    this.current = built;
    this.currentName = name;
  }

  get graphics(): GraphicsSettingsData { return this.graphicsData; }

  // 描画品質設定の項目を1つ差し替え、パイプラインへ押し出してその場で描き直す。
  setGraphicsOption(key: GraphicsOptionKey, value: boolean | number): void {
    this.graphicsData = withGraphicsOption(this.graphicsData, key, value);
    this.pipeline.applyGraphics(this.graphicsData);
    this.render();
  }

  // 一様な環境光の割合。ゲーム本体はビューの種別から強弱を決めるが、ここには種別が無いので
  // 直に選ぶ。起動時は弱(戦闘ビュー)。
  get ambientFraction(): number { return this.pipeline.ambient.fraction; }

  setAmbientFraction(fraction: number): void {
    this.pipeline.ambient.setFraction(fraction);
    this.render();
  }

  // 画面へ出す中間バッファを選び、その場で描き直す。
  showDebugTarget(target: DebugTargetId): void {
    this.pipeline.debugTarget = target;
    this.render();
  }

  // いま観察している向き。ケースを選び直すとそのケースの既定値へ戻る。
  get viewAngles(): LabViewAngles { return this.angles; }

  // 現在のカメラ距離 [m]。cameraDistanceLog は倍率の対数なので、実寸はここから読む。
  get cameraDistance(): number { return this.defaultCameraDistance * 10 ** this.angles.cameraDistanceLog; }

  // 現在の画角 [deg]。ズームは画角を倍率ぶん狭めるので、半画角の正接を割って求める。
  get cameraFovDeg(): number {
    const halfTangent = Math.tan(THREE.MathUtils.degToRad(this.defaultCameraFovDeg / 2));
    return THREE.MathUtils.radToDeg(2 * Math.atan(halfTangent / 10 ** this.angles.cameraZoomLog));
  }

  // 現在の恒星までの距離 [m]。sunDistanceLogAu は天文単位の対数なので、実寸はここから読む。
  get sunDistance(): number { return AU * 10 ** this.angles.sunDistanceLogAu; }

  // 観察の向きを部分的に差し替え、その場で描き直す。仰角は姿勢が決まる範囲へ丸める。
  setViewAngles(changes: Partial<LabViewAngles>): void {
    const merged = { ...this.angles, ...changes };
    this.angles = {
      ...merged,
      cameraElevationDeg: THREE.MathUtils.clamp(
        merged.cameraElevationDeg, -MAX_CAMERA_ELEVATION_DEG, MAX_CAMERA_ELEVATION_DEG,
      ),
    };
    this.render();
  }

  // ケースのカメラと注視点から、観察の向きの既定値を引き直す。**注視点はカメラの視線上へ
  // 落としてから使う** — 視線から外れた点を注視させると、向きへ触れていないのに絵が回る。
  private resetView(): void {
    const built = this.current;
    if (built === null) return;
    const camera = built.camera;
    camera.updateMatrixWorld(true);
    camera.getWorldDirection(this.forward);
    const pivot = built.viewTarget ?? this.caseCenter(built);
    const depth = this.forward.dot(this.scratchVector.subVectors(pivot, camera.position));
    this.defaultCameraDistance = Math.max(depth, camera.near);
    this.defaultCameraFovDeg = camera.fov;
    this.pivot.copy(camera.position).addScaledVector(this.forward, this.defaultCameraDistance);
    const sun = anglesFromDirection(built.sunDirection ?? SUN_DIR);
    const eye = anglesFromDirection(this.scratchVector.copy(this.forward).negate());
    this.angles = {
      sunAzimuthDeg: sun.azimuthDeg,
      sunElevationDeg: sun.elevationDeg,
      sunDistanceLogAu: Math.log10((built.sunDistance ?? AU) / AU),
      cameraAzimuthDeg: eye.azimuthDeg,
      cameraElevationDeg: eye.elevationDeg,
      cameraDistanceLog: 0,
      cameraZoomLog: 0,
    };
  }

  // ケースの物体をすべて包む箱の中心。viewTarget を持たないケースの注視点になる。
  private caseCenter(built: LabCase): THREE.Vector3 {
    this.scratchBox.makeEmpty();
    for (const root of built.objects) {
      root.updateWorldMatrix(true, true);
      this.scratchBox.expandByObject(root);
    }
    if (this.scratchBox.isEmpty()) {
      return this.caseCenterVector.copy(built.camera.position).addScaledVector(this.forward, 1);
    }
    return this.scratchBox.getCenter(this.caseCenterVector);
  }

  // 動くものが無いので、描くのはケースを差し替えたときと、表示を切り替えたときと、撮影のとき。
  render(): void {
    if (this.current === null) return;
    // 恒星の位置とシーン光源の向きは、必ず同じ向きから引く。片方だけを更新すると、影の向きと
    // 明暗の境界の向きが食い違ったまま「それらしく」写る。
    const sunDirection = directionFromAngles(
      this.angles.sunAzimuthDeg, this.angles.sunElevationDeg, SUN_DIRECTION,
    );
    this.sun.position.copy(sunDirection).multiplyScalar(SUN_LIGHT_DISTANCE);
    const sunDistance = this.sunDistance;
    SUN_POSITION.copy(sunDirection).multiplyScalar(sunDistance);
    this.pipeline.sunLight.set(SUN_POSITION, R_SUN, SUN_COLOR, SUN_RADIANT_INTENSITY);
    // 天体照。ケースが置いた光源をスロットへ書く。放射輝度は恒星のつまみの距離と、
    // 描画原点を基準点とした位相角に追随する。
    this.pipeline.planetLight.set((this.current.planetLights ?? []).map((light) => {
      const toSun = SUN_TO_LIGHT.copy(SUN_POSITION).sub(light.center);
      const toOrigin = ORIGIN_TO_LIGHT.copy(ORIGIN).sub(light.center);
      const phase = lambertPhase(toSun.angleTo(toOrigin));
      const base = planetRadiance(
        light.albedo, sunIrradianceAtDistance(SUN_POSITION.distanceTo(light.center)),
      );
      return {
        center: light.center,
        radius: light.radius,
        radiance: [base[0] * phase, base[1] * phase, base[2] * phase] as const,
      };
    }));
    // 順応の基準点は描画原点。**ケースの sunDistance はここから恒星までの距離**なので、
    // 露出はその1つの数だけで決まり、ケースが物体をどこへ置いたかには引きずられない。
    this.pipeline.exposure.setReference(ORIGIN, SUN_POSITION);
    const camera = this.current.camera;
    directionFromAngles(this.angles.cameraAzimuthDeg, this.angles.cameraElevationDeg, CAMERA_OFFSET);
    camera.position.copy(this.pivot).addScaledVector(CAMERA_OFFSET, this.cameraDistance);
    camera.lookAt(this.pivot);
    camera.updateMatrixWorld(true);
    // 画角の書き換えは、投影行列を組み直すまで無言で効かない。
    camera.fov = this.cameraFovDeg;
    camera.updateProjectionMatrix();
    // 恒星の見た目は、光源と同じ位置から置き直す。**片方だけ動かさない** — 明るさの根拠と
    // 光点の位置が食い違うと、ちらつきの出どころを読み違える。詳細度の設定もゲーム本体と
    // 同じように掛ける(球と点像の切り替わる距離がここだけずれない)。
    this.current.star?.sync(
      SUN_POSITION, R_SUN, sunDiameterPx(sunDistance, camera.fov) * this.graphicsData.lodBias, camera.quaternion,
    );
    this.pipeline.sunOcclusion.setOccluders(this.current.occluders ?? []);
    const rings = this.current.rings;
    this.pipeline.sunOcclusion.setRings(rings?.center ?? ORIGIN, rings?.axis ?? UP, rings?.bands ?? []);
    // 天体の並べ替えと濃い表現の重みは、いま置いたカメラの位置からゲーム本体と同じ関数で引き直す。
    const quality = this.graphicsData.atmosphere;
    const detail = ATMOSPHERE_DETAIL_OF_QUALITY[quality];
    const { bodies, denseWeight } = rankAtmospheres((this.current.atmospheres ?? []).map((body) => ({
      body, altitude: camera.position.distanceTo(body.center) - body.surfaceRadius,
    })));
    this.pipeline.atmosphere.setBodies(
      quality === ATMOSPHERE_QUALITY.off ? [] : bodies,
      detail, detail === ATMOSPHERE_DETAIL.none ? 0 : denseWeight,
    );
    const startedAt = performance.now();
    this.pipeline.render(this.scene, camera, this.style);
    this.lastRenderCpuMs = performance.now() - startedAt;
    this.gpu.resolve();
  }

  async measure(name: CaseName, warmupFrames = 6, sampleFrames = 30): Promise<LabMeasurement> {
    this.show(name);
    await this.gpu.waitForResolve();
    this.gpu.reset();

    for (let frame = 0; frame < warmupFrames; frame++) {
      this.current?.updateProteinMotion?.((frame + 1) / 60);
      this.render();
      await this.gpu.waitForResolve();
    }
    this.gpu.reset();

    const cpuSamples: number[] = [];
    const gpuSamples = Array.from({ length: GPU_PASS_COUNT }, () => [] as number[]);
    const motion = new ProteinMotionMetricsRecorder();
    for (let frame = 0; frame < sampleFrames; frame++) {
      const motionSample = this.current?.updateProteinMotion?.((warmupFrames + frame + 1) / 60);
      this.render();
      cpuSamples.push(this.lastRenderCpuMs);
      await this.gpu.waitForResolve();
      const snapshot = this.gpu.snapshot();
      for (const [index, samples] of gpuSamples.entries()) samples.push(snapshot.elapsedMs[index] ?? 0);
      motion.record(motionSample ?? { cpuMs: 0, uploadBytes: 0, lodCounts: {} });
    }

    return {
      caseName: name,
      frames: sampleFrames,
      cpuRenderMs: distribution(cpuSamples),
      gpuSupported: this.gpu.snapshot().supported,
      gpuPassMs: Object.fromEntries(GPU_PASS_LABELS.map((label, index) => [label, distribution(gpuSamples[index]!)])),
      proteinMotion: motion.summary(),
      proteinCase: this.current?.proteinMotion,
    };
  }

  // キャンバスへ出るのと同じ絵を PNG のデータ URL で返す。合成パスが「キャンバスへ」と書いた
  // 出力先が撮影ターゲットへ差し替わるだけなので、トーンマッピングも sRGB 変換も同じに掛かる。
  async shoot(name: CaseName): Promise<string> {
    this.show(name);
    this.current?.updateProteinMotion?.(1);
    return this.capture();
  }

  // いま画面に出ているものを、ケースも観察の向きも変えずに撮る。
  async capture(): Promise<string> {
    this.renderer.setOutputRenderTarget(this.captureTarget);
    try {
      this.render();
    } finally {
      // 戻し忘れると以後キャンバスに何も出なくなる(撮影だけは通るので気付きにくい)。
      this.renderer.setOutputRenderTarget(null);
    }
    const pixels = await this.renderer.readRenderTargetPixelsAsync(this.captureTarget, 0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    return toPng(new Uint8Array(pixels.buffer));
  }
}

function disposeCaseObjects(built: LabCase): void {
  built.disposeProteinMotion?.();
  for (const root of built.objects) {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!object.userData.ownsGeometry && !object.userData.ownsMaterial) return;
      if (object.userData.ownsGeometry && 'geometry' in mesh && mesh.geometry) mesh.geometry.dispose();
      if (!object.userData.ownsMaterial || !('material' in mesh)) return;
      const material = mesh.material as THREE.Material | THREE.Material[];
      if (Array.isArray(material)) material.forEach((entry) => entry.dispose());
      else material.dispose();
    });
  }
}

function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

function distribution(values: readonly number[]): LabDistribution {
  if (values.length === 0) return { avg: 0, p50: 0, p95: 0, max: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return {
    avg: values.reduce((sum, value) => sum + value, 0) / values.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

// 読み出した RGBA 画素を PNG のデータ URL にする。
function toPng(pixels: Uint8Array): string {
  const canvas = document.createElement('canvas');
  canvas.width = VIEW_WIDTH;
  canvas.height = VIEW_HEIGHT;
  const context = canvas.getContext('2d')!;
  context.putImageData(new ImageData(new Uint8ClampedArray(pixels), VIEW_WIDTH, VIEW_HEIGHT), 0, 0);
  return canvas.toDataURL('image/png');
}
