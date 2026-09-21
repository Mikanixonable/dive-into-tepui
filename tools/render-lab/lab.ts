// 描画テスト環境の 1 ビュー。ケースを組み、ゲーム本体と同じ RenderPipeline でキャンバスへ描く。
// 絵の撮影(PNG)と、CPU / GPU それぞれの所要時間の計測もここが担う。
import * as THREE from 'three/webgpu';
import { WebGPURenderer } from 'three/webgpu';
import { GPU_PASS_COUNT, GPU_PASS_LABELS, GpuTimings } from '../../src/render/gpu-timings';
import { ProteinMotionMetricsRecorder, type ProteinMotionMetricSummary } from '../../src/game/protein/protein-motion-metrics';
import { RenderPipeline } from '../../src/render/pipeline/render-pipeline';
import { irradianceAtDistance, scaledRadiantIntensity } from '../../src/render/pipeline/sun-light';
import { R_SUN, SUN, SUN_LIGHT_COLOR, SUN_SURFACE_COLOR } from '../../src/game/celestial/solar-system/sun';
import { createStarSphere } from '../../src/render/celestial/star-sphere';
import { surfaceRadianceOf } from '../../src/render/celestial/celestial-entity/star-celestial-view';
import { farClip } from '../../src/render/camera/camera-view';
import { planetRadiance, type PlanetLightValue } from '../../src/render/pipeline/lighting/planet-light-source';
import { ambientFraction } from '../../src/render/pipeline/lighting/ambient-source';
import { reversedOpaqueSort, reversedTransparentSort } from '../../src/render/pipeline/reversed-sort';
import { castsCumulusShadow } from '../../src/render/pipeline/shadow/shadow-select';
import { atmosphereDraws, withAirglowEnabled, type AtmosphereBody } from '../../src/render/atmosphere';
import { RingMaterials } from '../../src/render/celestial/ring';
import { metersPerPixelAtDepth } from '../../src/math/projection';
import { AU } from '../../src/physics/astronomical-unit';
import { R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { CASES, type CaseName } from './cases';
import { sunDiameterPx, type LabCase, type LabShot, SUN_DIR, VIEW_HEIGHT, VIEW_WIDTH } from './lab-case';
import { EARTH_LIGHT_ALBEDO, LabEarth } from './lab-earth';
import { anglesFromDirection, directionFromAngles, type LabViewAngles } from './view-angles';
import { pixelsToPngDataUrl } from '../lab-png';
import type { GraphicsOptionKey, GraphicsSettingsData } from '../../src/render/graphics-settings';
import type { StoredSetting } from '../../src/settings/stored-setting';
import type { DebugTargetId } from '../../src/render/pipeline/debug-target';
import type { RenderStyle } from '../../src/render/render-style';

// 所要時間 [ms] の分布。
export interface LabDistribution {
  readonly avg: number;
  readonly p50: number;
  readonly p95: number;
  readonly max: number;
}

// 1 ケースの計測結果。gpuPassMs はパスのラベルごと。
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

// 恒星を置く位置(描画座標)。向きも距離も観察のつまみが正本で、毎フレーム書き込む。
const SUN_POSITION = new THREE.Vector3();

// 恒星方向とカメラ位置を毎フレーム組み立てる書き込み先。
const SUN_DIRECTION = new THREE.Vector3();
const CAMERA_OFFSET = new THREE.Vector3();

// 地球の天体照へ渡す恒星の向きの置き場。毎フレーム書き換えて使い回す。
const EARTH_STAR_DIRECTION = new THREE.Vector3();

// カメラの仰角の限界 [deg]。真上・真下では上方向と視線が平行になり、姿勢が決まらない。
export const MAX_CAMERA_ELEVATION_DEG = 89;

// カメラのズーム(画角を狭める倍率)の常用対数の上限。0 がケース既定の画角。
export const MAX_CAMERA_ZOOM_LOG = 2;

// 恒星までの距離(天文単位)の常用対数の下限・上限。**対数で持つ** — 見かけ径が 1px を切る
// あたりの変化を読みたいので、AU を直に刻むと近距離側が粗すぎて追えない。下限の 0.01 AU は
// 太陽が画角(50°)いっぱいに広がる距離、上限の 100 AU は海王星軌道の外側。
export const MIN_SUN_DISTANCE_LOG_AU = -2;
export const MAX_SUN_DISTANCE_LOG_AU = 2;

// 撮影がケースの部品と地球の揃いを待つ上限 [ms]。超えたらそのまま撮り、撮影そのものは落とさない。
// **重いケースの最初のフレームは、シェーダを組むあいだ 10 秒を超えて止まる**ので、上限は広く取る。
const READY_TIMEOUT_MS = 60_000;

// 撮影 1 枚が、絵の落ち着きを待って撮る回数の上限。実測では全撮影が 3 回以内に一致したので、その倍を取る。
const MAX_SETTLE_CAPTURES = 6;

export class LabView {
  private readonly scene = new THREE.Scene();
  // 撮影先。合成パスは sRGB へ変換済みの値を書くので素の RGBA8 で受ける(-srgb にすると二重変換で
  // 白っぽくなる)。深度は 3D UI パスの線が深度テストに使うので持たせる(無いと線が不透明物を貫通する)。
  private readonly captureTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    depthBuffer: true,
  });
  private current: LabCase | null = null;
  // スタイルを差し替えるとケースを組み直すので、いま出ているケースの名前も持つ。
  private currentName: CaseName | null = null;
  // 画面全体の見せ方。起動のたびに写実から始める。
  private style: RenderStyle = 'realistic';
  private lastRenderCpuMs = 0;
  // カメラが周回する点。ケースの注視点を視線上へ落としたもの。
  private readonly pivot = new THREE.Vector3();
  // ケース既定のカメラ距離 [m]。cameraDistanceLog の基準になる。
  private defaultCameraDistance = 1;
  // ケース既定の画角 [deg]。cameraZoomLog の基準になる。
  private defaultCameraFovDeg = 1;
  // ケース既定の観察の向き。**ケースを組んで向きを引き直した時点で控える** — 描くとケースのカメラが
  // 動くので、あとから引き直すと動いたあとの向きを既定と取り違える。
  private defaultAngles: LabViewAngles = {
    sunAzimuthDeg: 0, sunElevationDeg: 0, sunDistanceLogAu: 0,
    cameraAzimuthDeg: 0, cameraElevationDeg: 0, cameraDistanceLog: 0, cameraZoomLog: 0,
    earthAzimuthDeg: 0, earthElevationDeg: 0, earthAltitudeLog: 0, earthLatitudeDeg: 0, earthLongitudeDeg: 0,
  };
  private angles: LabViewAngles = this.defaultAngles;
  private readonly scratchBox = new THREE.Box3();
  private readonly caseCenterVector = new THREE.Vector3();
  private readonly scratchVector = new THREE.Vector3();
  private readonly forward = new THREE.Vector3();
  // 全ケースの環の帯が共有するマテリアル。
  private readonly ringMaterials: RingMaterials;
  // 恒星の見た目。ケースによらず、光源の恒星と同じ位置・半径へ描くたびに置き直す。
  private readonly star = createStarSphere(
    SUN_SURFACE_COLOR, surfaceRadianceOf(scaledRadiantIntensity(SUN.radiantIntensity), R_SUN),
  );
  // 地球。実写の画像と雲場をケースの切り替えのたびに読み直さないよう 1 つだけ組み、地球を置く
  // ケースのあいだだけシーンへ出して、観察のつまみの置き方へ描くたびに置き直す。
  private readonly earth = new LabEarth();

  // 起動時の描画品質設定。撮影はこれへ差分を重ねる。
  private readonly startupGraphics: GraphicsSettingsData;

  // graphics は描く描画品質設定の器。
  private constructor(
    private readonly renderer: WebGPURenderer,
    private readonly pipeline: RenderPipeline,
    private readonly gpu: GpuTimings,
    private readonly graphics: StoredSetting<GraphicsSettingsData>,
  ) {
    // RenderPipeline はカメラのチャンネルを一時的に絞る。シーンルートが既定の 0 だけだと
    // その時点で子要素の走査が止まるため、コンテナとして全チャンネルを受ける。
    this.scene.layers.enableAll();
    this.ringMaterials = new RingMaterials(pipeline.bodyShadow, pipeline.sunLight);
    this.star.addTo(this.scene);
    this.startupGraphics = graphics.current;
    graphics.subscribe((next) => this.applyGraphics(next));
  }

  // graphics は描く描画品質設定の器。この時点の値を起動時の設定として控え、以後はその変更を受けて
  // 描き直す。
  public static async create(
    canvas: HTMLCanvasElement, graphics: StoredSetting<GraphicsSettingsData>,
  ): Promise<LabView> {
    // 深度の扱いはゲーム本体(src/render/scene.ts)と揃える。ここが違うと、深度の分解能と
    // 描画順の並べ替えが本番と別物になる。
    const renderer = new WebGPURenderer({
      canvas, trackTimestamp: true, reversedDepthBuffer: true,
    });
    renderer.setOpaqueSort(reversedOpaqueSort);
    renderer.setTransparentSort(reversedTransparentSort);
    renderer.setSize(VIEW_WIDTH, VIEW_HEIGHT);
    await renderer.init();
    const gpu = new GpuTimings(renderer);
    gpu.enabled = true;
    const pipeline = new RenderPipeline(renderer, graphics.current, gpu);
    return new LabView(renderer, pipeline, gpu, graphics);
  }

  // ケースを差し替え、観察の向きをそのケースの既定へ戻して描く。
  public show(name: CaseName): void {
    this.build(name);
    this.resetView();
    this.render();
  }

  // 表示スタイルを差し替え、いま出ているケースをそのスタイルで組み直す。観察の向きは保つ —
  // 写実と模式図を同じ構図で見比べるための切り替え。
  public setStyle(style: RenderStyle): void {
    this.style = style;
    if (this.currentName !== null) this.build(this.currentName);
    this.render();
  }

  // ケースをいまのスタイルで組み直してシーンへ載せ、それを現在のケースにする。前のケースは解放する。
  private build(name: CaseName): void {
    if (this.current !== null) {
      this.scene.remove(...this.current.objects);
      disposeCaseObjects(this.current);
    }
    const built = CASES[name](this.style, this.ringMaterials);
    // **1 つずつ足す** — 地球のほかに物体を持たないケースで空の引数を渡すと、three.js がエラーを出す。
    for (const object of built.objects) this.scene.add(object);
    this.current = built;
    this.currentName = name;
    // 地球はケースが置き方を宣言したときだけ出し、まずその既定の置き方へ置く。
    if (built.earth !== undefined) {
      this.scene.add(this.earth.object);
      this.earth.place(built.earth);
    } else {
      this.scene.remove(this.earth.object);
    }
    // **カメラの既定を引く前に一度同期する** — 環はここで姿勢が決まるので、同期する前に
    // 物体を包む箱を測ると注視点が原点へ寄る。
    built.sync?.(this.graphics.current, built.earth === undefined ? null : this.earth.center);
  }

  // 描画品質設定の新しい値をパイプラインへ配り、その場で描き直す。
  private applyGraphics(graphics: GraphicsSettingsData): void {
    this.pipeline.ambient.setFraction(ambientFraction(graphics));
    this.pipeline.rebuildForGraphics(graphics);
    this.render();
  }

  // 画面へ出す中間バッファを選び、その場で描き直す。
  public showDebugTarget(target: DebugTargetId): void {
    this.pipeline.syncDebugTarget(target);
    this.render();
  }

  // いま観察している向き。ケースを選び直すとそのケースの既定値へ戻る。
  public get viewAngles(): LabViewAngles { return this.angles; }

  // いまのケースが地球を置くか。置かないケースでは、観察の向きの地球のつまみは絵に効かない。
  public get showsEarth(): boolean { return this.current?.earth !== undefined; }

  // 現在のカメラ距離 [m]。cameraDistanceLog は倍率の対数なので、実寸はここから読む。
  public get cameraDistance(): number { return this.defaultCameraDistance * 10 ** this.angles.cameraDistanceLog; }

  // 現在の画角 [deg]。ズームは画角を倍率ぶん狭めるので、半画角の正接を割って求める。
  public get cameraFovDeg(): number {
    const halfTangent = Math.tan(THREE.MathUtils.degToRad(this.defaultCameraFovDeg / 2));
    return THREE.MathUtils.radToDeg(2 * Math.atan(halfTangent / 10 ** this.angles.cameraZoomLog));
  }

  // 現在の恒星までの距離 [m]。sunDistanceLogAu は天文単位の対数なので、実寸はここから読む。
  public get sunDistance(): number { return AU * 10 ** this.angles.sunDistanceLogAu; }

  // 観察の向きを部分的に差し替え、その場で描き直す。仰角は姿勢が決まる範囲へ丸める。
  public setViewAngles(changes: Partial<LabViewAngles>): void {
    const merged = { ...this.angles, ...changes };
    this.angles = {
      ...merged,
      cameraElevationDeg: THREE.MathUtils.clamp(
        merged.cameraElevationDeg, -MAX_CAMERA_ELEVATION_DEG, MAX_CAMERA_ELEVATION_DEG,
      ),
    };
    this.render();
  }

  // ケースのカメラと注視点から、観察の向きの既定値を引き直す。
  private resetView(): void {
    const built = this.current;
    if (built === null) return;
    // ケースのカメラから、周回の中心と既定の距離・画角を引く。**注視点はカメラの視線上へ落として
    // から使う** — 視線から外れた点を注視させると、向きへ触れていないのに絵が回る。
    const camera = built.camera;
    camera.updateMatrixWorld(true);
    camera.getWorldDirection(this.forward);
    const pivot = built.viewTarget ?? this.caseCenter(built);
    const depth = this.forward.dot(this.scratchVector.subVectors(pivot, camera.position));
    this.defaultCameraDistance = Math.max(depth, camera.near);
    this.defaultCameraFovDeg = camera.fov;
    this.pivot.copy(camera.position).addScaledVector(this.forward, this.defaultCameraDistance);
    // 恒星とカメラの向きを角度へ直す。地球を置かないケースでは、地球のつまみを前のケースの値のまま保つ。
    const sun = anglesFromDirection(built.sunDirection ?? SUN_DIR);
    const eye = anglesFromDirection(this.scratchVector.copy(this.forward).negate());
    this.defaultAngles = {
      ...this.angles,
      ...built.earth,
      sunAzimuthDeg: sun.azimuthDeg,
      sunElevationDeg: sun.elevationDeg,
      sunDistanceLogAu: 0,
      cameraAzimuthDeg: eye.azimuthDeg,
      cameraElevationDeg: eye.elevationDeg,
      cameraDistanceLog: 0,
      cameraZoomLog: 0,
    };
    this.angles = this.defaultAngles;
  }

  // ケースの物体をすべて包む箱の中心。箱が空ならカメラの視線上の点を返すので、先に forward を
  // 引いておくこと。
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

  // いまのケースを、観察の向きと描画品質設定の現在値で、表示時刻 displayTime [s] の 1 フレームとして描く。
  public render(displayTime = 0): void {
    if (this.current === null) return;
    const graphics = this.graphics.current;
    const sunDirection = directionFromAngles(
      this.angles.sunAzimuthDeg, this.angles.sunElevationDeg, SUN_DIRECTION,
    );
    const sunDistance = this.sunDistance;
    SUN_POSITION.copy(sunDirection).multiplyScalar(sunDistance);
    const sunIntensity = scaledRadiantIntensity(SUN.radiantIntensity);
    this.pipeline.sunLight.set(SUN_POSITION, R_SUN, SUN_LIGHT_COLOR, sunIntensity);
    // 順応の基準点は描画原点。**恒星の距離のつまみはここから恒星までの距離**なので、
    // 露出はその1つの数だけで決まり、ケースが物体をどこへ置いたかには引きずられない。
    this.pipeline.exposure.setReference(ORIGIN, SUN_POSITION, sunIntensity);
    const camera = this.current.camera;
    directionFromAngles(this.angles.cameraAzimuthDeg, this.angles.cameraElevationDeg, CAMERA_OFFSET);
    camera.position.copy(this.pivot).addScaledVector(CAMERA_OFFSET, this.cameraDistance);
    camera.lookAt(this.pivot);
    camera.updateMatrixWorld(true);
    // 画角と遠クリップ距離の書き換えは、投影行列を組み直すまで無言で効かない。遠クリップ距離は、
    // 周回の中心までの距離を注視距離としてゲーム本体と同じ式で引く。
    camera.fov = this.cameraFovDeg;
    camera.far = farClip(this.cameraDistance);
    camera.updateProjectionMatrix();
    // 地球とケースの部品は、このフレームのカメラを置いてから合わせる — 部品はそのカメラを読んでよい。
    // ケースの部品は地球の中心も読むので、地球を先に置く。
    const earth = this.current.earth === undefined ? null : this.earth;
    earth?.place(this.angles);
    earth?.sync(camera, graphics, this.style);
    this.current.sync?.(graphics, earth?.center ?? null);
    // 恒星の見た目は、光源と同じ位置から置き直す。**片方だけ動かさない** — 明るさの根拠と
    // 光点の位置が食い違うと、ちらつきの出どころを読み違える。詳細度の設定もゲーム本体と
    // 同じように掛ける(球と点像の切り替わる距離がここだけずれない)。
    this.star.sync(
      SUN_POSITION, R_SUN, sunDiameterPx(sunDistance, camera.fov) * graphics.lodBias, camera.quaternion,
      this.style,
    );
    // 天体照の光源は地球だけ、影・大気の源は地球のぶんとケースのぶんを合わせて渡す。
    this.pipeline.planetLight.set(earth === null ? [] : [earthLightValue(earth, sunIntensity, graphics.airglow)]);
    this.pipeline.bodyShadow.set([...(this.current.shadowBodies ?? []), ...(earth === null ? [] : [earth.shadowBody])]);
    const rings = this.current.rings;
    this.pipeline.ringShadow.set(rings?.center ?? ORIGIN, rings?.axis ?? UP, rings?.bands ?? []);
    this.pipeline.cumulusShadow.set(castsCumulusShadow(graphics) ? earth?.cumulus ?? null : null);
    earth?.bake(this.renderer, displayTime, this.gpu);
    // 大気へのサンプル点の配りは、いま置いたカメラの位置からゲーム本体と同じ関数で引き直す。
    this.pipeline.atmosphere.setDraws(atmosphereDraws(
      [...(earth === null ? [] : [earth.atmosphere]), ...(this.current.atmospheres ?? [])].map((body) => {
        const distance = camera.position.distanceTo(body.center);
        return {
          body: withAirglowSetting(body, graphics.airglow),
          distance,
          metersPerPixel: metersPerPixelAtDepth(camera.fov, distance, VIEW_HEIGHT),
        };
      }),
      graphics.atmosphere,
    ));
    const startedAt = performance.now();
    this.pipeline.render(this.scene, camera, this.style);
    this.lastRenderCpuMs = performance.now() - startedAt;
    this.gpu.resolve();
  }

  // ケースを表示して測る。angles を渡すと、ケース既定の観察の向きへそれを重ねてから測る。
  public async measure(
    name: CaseName, angles: Partial<LabViewAngles> = {}, warmupFrames = 6, sampleFrames = 30,
  ): Promise<LabMeasurement> {
    this.show(name);
    this.setViewAngles(angles);
    await this.gpu.waitForResolve();
    this.gpu.reset();

    // 暖機。計測に入れないフレームを回して、シェーダのコンパイルや初回の転送を済ませる。
    // 表示時刻は 60fps で進める — 雲場は表示時刻が変わったフレームにだけ焼くので、止めると生成を測れない。
    for (let frame = 0; frame < warmupFrames; frame++) {
      const displayTime = (frame + 1) / 60;
      this.current?.updateProteinMotion?.(displayTime);
      this.render(displayTime);
      await this.gpu.waitForResolve();
    }
    this.gpu.reset();

    // 本計測。フレームごとに CPU 時間・GPU のパス時間・残基 motion の計測値を集める。
    const cpuSamples: number[] = [];
    const gpuSamples = Array.from({ length: GPU_PASS_COUNT }, () => [] as number[]);
    const motion = new ProteinMotionMetricsRecorder();
    for (let frame = 0; frame < sampleFrames; frame++) {
      const displayTime = (warmupFrames + frame + 1) / 60;
      const motionSample = this.current?.updateProteinMotion?.(displayTime);
      this.render(displayTime);
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

  // いまのケースの撮影。ケースが宣言していなければ、ケース名で既定の向きを 1 枚撮る。
  private get shots(): Readonly<Record<string, LabShot>> {
    if (this.current === null || this.currentName === null) return {};
    return this.current.shots ?? { [this.currentName]: { view: {} } };
  }

  // いまのケースの撮影名。
  public get shotNames(): readonly string[] { return Object.keys(this.shots); }

  // いまのケースの撮影 name を当てて描き直す。描画品質設定は起動時の値へ graphics と撮影の差分を
  // この順に重ねた値に、観察の向きはケース既定へ撮影の差分を重ねた値になる。name が撮影に無ければ投げる。
  public applyShot(name: string, graphics: Partial<GraphicsSettingsData> = {}): void {
    const shot = this.shots[name];
    if (shot === undefined) throw new Error(`render-lab: the current case has no shot "${name}"`);
    this.syncGraphics({ ...this.startupGraphics, ...graphics, ...shot.graphics });
    this.setViewAngles({ ...this.defaultAngles, ...shot.view });
  }

  // 描画品質設定を next にする。**設定の器は同値でも購読者へ配り、パイプラインを組み直す**ので、
  // いまの値と 1 項目でも違うときだけ書く。
  private syncGraphics(next: GraphicsSettingsData): void {
    const current = this.graphics.current;
    const changed = (Object.keys(next) as GraphicsOptionKey[]).some((key) => next[key] !== current[key]);
    if (changed) this.graphics.set(next);
  }

  // ケースを表示し、ケースが宣言した撮影ごとに applyShot を当てて、キャンバスへ出るのと同じ絵
  // (トーンマッピングと sRGB 変換込み)を撮る。graphics は起動時の描画品質設定と撮影の差分のあいだへ
  // 重ねる差分。返り値は撮影名から PNG のデータ URL への表。ケースの部品と地球が揃うまで待ってから
  // 撮る。絵が落ち着かない撮影があれば投げる。観察の向きと描画品質設定は最後の撮影のまま残る。
  public async shoot(
    name: CaseName, graphics: Partial<GraphicsSettingsData> = {},
  ): Promise<Readonly<Record<string, string>>> {
    // **ケースは起動時の値へ graphics を重ねた設定で組んで待つ** — 描画設定が有効な間にしか読み込まない
    // 部品(雲など)があり、前の撮影の設定のまま待つと、読み込み前の姿を撮る。
    this.syncGraphics({ ...this.startupGraphics, ...graphics });
    this.show(name);
    this.current?.updateProteinMotion?.(1);
    await this.waitUntilReady();
    const pngs: Record<string, string> = {};
    for (const shotName of this.shotNames) {
      this.applyShot(shotName, graphics);
      pngs[shotName] = await this.captureSettled(shotName);
    }
    return pngs;
  }

  // 連続する 2 回の capture が一致するまで撮り直し、一致した絵を返す。MAX_SETTLE_CAPTURES 回撮っても
  // 一致しなければ、撮影名 shotName を添えて投げる。
  private async captureSettled(shotName: string): Promise<string> {
    // **一致を「絵が落ち着いた」ことの判定にする** — 同じセッションの中では、落ち着いたあとのフレームは
    // 完全に決定的。雲場は焼いたフレームの次から載り、パイプラインを組み直した直後のフレームは崩れる。
    let previous = await this.capture();
    for (let count = 2; count <= MAX_SETTLE_CAPTURES; count++) {
      const next = await this.capture();
      if (next === previous) return next;
      previous = next;
    }
    throw new Error(`render-lab: shot "${shotName}" did not settle within ${MAX_SETTLE_CAPTURES} captures`);
  }

  // いまのケースの部品と、地球を置くなら地球が揃い、絵として比べられる状態になったか。
  private get ready(): boolean {
    const built = this.current;
    if (built === null) return true;
    return (built.ready?.() ?? true) && (built.earth === undefined || this.earth.ready);
  }

  // ready が真になるまで、1 フレームずつ描いて待つ。上限を過ぎたらそのまま戻る。
  private async waitUntilReady(): Promise<void> {
    const deadline = performance.now() + READY_TIMEOUT_MS;
    while (!this.ready && performance.now() < deadline) {
      // **描かずに待っても進まない** — テクスチャの GPU 投入は 1 回の描画につき 1 枚しか進まない。
      this.render();
      // **次を描く前に前のフレームの GPU 完了を待つ** — 待たずに回すと重いケースで命令が溜まり、
      // デバイスごと落ちる。
      await this.gpu.waitForResolve();
      await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
    }
  }

  // いま画面に出ているものを、ケースも観察の向きも変えずに撮る。
  public async capture(): Promise<string> {
    this.renderer.setOutputRenderTarget(this.captureTarget);
    try {
      this.render();
    } finally {
      // 戻し忘れると以後キャンバスに何も出なくなる(撮影だけは通るので気付きにくい)。
      this.renderer.setOutputRenderTarget(null);
    }
    const pixels = await this.renderer.readRenderTargetPixelsAsync(this.captureTarget, 0, 0, VIEW_WIDTH, VIEW_HEIGHT);
    return pixelsToPngDataUrl(new Uint8Array(pixels.buffer), VIEW_WIDTH, VIEW_HEIGHT);
  }
}

// 大気 body を、描画設定の大気光の有無 airglow へ合わせた写し。**雲は写した時点で固定せず、読む
// たびに body から引く** — 雲の有無は、地球が描画設定を押し込むたびに置き直される。
function withAirglowSetting(body: AtmosphereBody, airglow: boolean): AtmosphereBody {
  return { ...body, optics: withAirglowEnabled(body.optics, airglow), get clouds() { return body.clouds; } };
}

// 地球 earth を天体照の光源とした値。放射照度は恒星の位置 SUN_POSITION と放射強度 sunIntensity から、
// 大気は描画設定の大気光の有無 airglow へ合わせて渡す。
function earthLightValue(earth: LabEarth, sunIntensity: number, airglow: boolean): PlanetLightValue {
  const sunIrradiance = irradianceAtDistance(sunIntensity, SUN_POSITION.distanceTo(earth.center));
  const map = earth.lightSourceMap;
  return {
    center: earth.center,
    radius: R_EARTH,
    radiance: planetRadiance(EARTH_LIGHT_ALBEDO, sunIrradiance),
    appearance: {
      map: map?.texture ?? null,
      // 写しが届くまでは読まれないので、色をそのまま通す倍率を置く。
      albedoScale: map?.albedoScale ?? 1,
      albedo: EARTH_LIGHT_ALBEDO,
      sunIrradiance,
      starDirection: EARTH_STAR_DIRECTION.subVectors(SUN_POSITION, earth.center).normalize(),
      bodyFromWorld: earth.bodyFromWorld,
      atmosphere: withAirglowSetting(earth.atmosphere, airglow),
    },
  };
}

// ケースが握る資源を解放する。ジオメトリとマテリアルは、userData の ownsGeometry / ownsMaterial を
// 立てた物体のものを捨てる。
function disposeCaseObjects(built: LabCase): void {
  built.disposeProteinMotion?.();
  // 所有を立てていない資源は残す — 球の単位ジオメトリは LOD 段ごとに全利用元で共有されていて、
  // 捨てると次のケースが壊れる。
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

// 昇順に並んだ sorted の、割合 ratio(0..1)の位置にある値。空なら 0。
function percentile(sorted: readonly number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index] ?? 0;
}

// 標本の平均・中央値・95 パーセンタイル・最大。空なら全部 0。
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
