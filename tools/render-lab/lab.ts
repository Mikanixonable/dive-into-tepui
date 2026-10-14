// 描画テスト環境の 1 ビュー。ケースを組み、ゲーム本体と同じ RenderPipeline でキャンバスへ描く。
// 絵の撮影(PNG)と中間ターゲットの読み戻し、CPU / GPU それぞれの所要時間の計測もここが担う。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { getViewPosition, ivec2, mrt, screenCoordinate, screenUV, select, textureLoad, uniform, vec2, vec4 } from 'three/tsl';
import { GPU_PASS, GPU_PASS_COUNT, GPU_PASS_LABELS, GpuTimings } from '../../src/render/gpu-timings';
import { projectedRadius } from '../../src/render/pipeline/screen-space/hemisphere-scan';
import {
  ProteinMotionMetricsRecorder, type ProteinMotionMetricSummary,
} from '../../src/game/protein/protein-motion-metrics';
import { RenderPipeline } from '../../src/render/pipeline/render-pipeline';
import { R_SUN, SUN_LIGHT_COLOR } from '../../src/game/celestial/solar-system/sun';
import { farClip } from '../../src/render/camera/camera-view';
import { planetRadiance, type PlanetLightValue } from '../../src/render/pipeline/lighting/planet-light-source';
import { ambientFraction } from '../../src/render/pipeline/lighting/ambient-source';
import { reversedOpaqueSort, reversedTransparentSort } from '../../src/render/pipeline/reversed-sort';
import { castsCumulusShadow } from '../../src/render/pipeline/shadow/shadow-select';
import { atmosphereDraws, withAirglowEnabled, type AtmosphereBody } from '../../src/render/atmosphere';
import { RingMaterials } from '../../src/render/celestial/ring';
import { disposeOwnedRenderResources } from '../../src/render/dispose-owned-render-resources';
import { metersPerPixelAtDepth } from '../../src/math/projection';
import { distributionOf, type SampleDistribution } from '../../src/math/sample-distribution';
import { R_EARTH } from '../../src/game/celestial/solar-system/earth-system';
import { SCREEN_SPACE_DIFFUSE, screenSpaceDiffuseOf } from '../../src/render/pipeline/screen-space/screen-space-pass';
import { stageMaterial } from '../../src/render/pipeline/screen-space/screen-space-stage';
import { resolveGraphics, selectionOfGraphics, type GraphicsSelection } from '../../src/render/graphics-selection';
import { CASES, type CaseName } from './cases';
import { type LabCase, type LabShot, SUN_DIR, VIEW_HEIGHT, VIEW_WIDTH } from './lab-case';
import { EARTH_LIGHT_ALBEDO, LabEarth } from './lab-earth';
import { LabSun } from './lab-sun';
import { PassAccumulator } from './pass-accumulator';
import { PRODUCTION_PHASE, type CorrectionPhase } from './phase-sequence';
import { anglesFromDirection, directionFromAngles, type LabViewAngles } from './view-angles';
import { pixelsToPngDataUrl } from '../lab-png';
import type { GraphicsKey, GraphicsSettingsData } from '../../src/render/graphics-settings';
import type { JitterSource, ScanJitter } from '../../src/render/pipeline/screen-space/frame-jitter';
import type { StoredSetting } from '../../src/settings/stored-setting';
import type { DebugTargetId } from '../../src/render/pipeline/debug-target';
import type { RenderStyle } from '../../src/render/render-style';
import type {
  ScanTier, ScreenSpaceExperimentVariant, ScreenSpaceStageRange,
} from '../../src/render/pipeline/screen-space/screen-space-pass';
import type { Mat4Uniform } from '../../src/render/tsl-types';

// 近傍拡散補正の、帯を詰めた描画先の i 枚目のテクスチャの読み戻しの名前。'packed-bands-i' は走査(段 0)、'reduced-m-i'
// は帯の縮小の段 m。枚数は WebGPU の既定の上限で書ける帯の数 5 の分だけ並べる。
type PackedBandsName = `packed-bands-${0 | 1 | 2 | 3}` | `reduced-${1 | 2 | 3 | 4}-${0 | 1 | 2}`;
const PACKED_BANDS_NAME_PATTERN = /^(?:packed-bands|reduced-(\d))-(\d)$/;
// 近傍拡散補正の拡大と合流の段 k の出力の読み戻しの名前。
type MergedName = `merged-${0 | 1 | 2 | 3}`;
const MERGED_NAME_PATTERN = /^merged-(\d)$/;

// 読み戻せる浮動小数の中間ターゲット。PackedBandsName は、いまの段の帯の数の段 m の描画先が帯 m〜帯の数 − 1 を詰めた
// i 枚目のテクスチャ(段の帯 b の rgb は、テクスチャを並べた通しのチャンネル 3(b − m)..3(b − m) + 2。帯の数 1 では
// 'packed-bands-0' の rgb が帯に分けない補正)。MergedName は、いまの段の帯の数の拡大と合流の段 k の出力(rgb は C_k)。
// 'band-sum' は走査の帯の和(rgb、α は 0)。'scan-correction' は走査の解像度の、最後の拡大の前の補正(rgb。帯の数 1 では
// 帯 0、2 以上では 'merged-0' と同じ)。'surface-radiance' は照り返しの源(走査の解像度の rgb)、'representative-ℓ' は代表の
// 段 ℓ の G バッファの画素の整数座標と素の深度(rgb、a は 0)。'scan-surface-0' は走査の面の写しの (G バッファの画素の x, y,
// 素の深度, 0)、'scan-surface-1' はその法線の rg(ba は 0)。'hdr' は合成が読む線形の絵、'projected-radius' は受け手の近傍の
// 半径が写る描画バッファの画素数で、面の無い画素は 0。'depth' は G バッファの素の深度(r、gba は 0。面の無い画素は 0)。
// 'upsampled-correction' は蓄積前の補正、'correction-history' は前フレームの補正履歴、
// 'previous-depth' は前フレームの素の深度。
export type FloatTargetName = PackedBandsName | MergedName | 'band-sum' | 'scan-correction' | 'upsampled-correction'
  | 'correction-history' | 'previous-depth' | 'correction' | 'diffuse'
  | 'surface-radiance' | `representative-${1 | 2 | 3}` | `scan-surface-${0 | 1}` | 'hdr' | 'projected-radius' | 'depth' | 'motion';
const REPRESENTATIVE_NAME_PATTERN = /^representative-(\d)$/;
const SCAN_SURFACE_NAME_PATTERN = /^scan-surface-([01])$/;

// 描画先の形式ごとの、画素あたりの成分の数。
const CHANNELS_OF_FORMAT: Readonly<Partial<Record<THREE.AnyPixelFormat, number>>> = {
  [THREE.RedFormat]: 1, [THREE.RGFormat]: 2, [THREE.RGBAFormat]: 4,
};

// accumulateWhitePasses が GPU の終わりを待つ間隔 [パス]。
const WHITE_PASSES_PER_WAIT = 256;
// averageCorrection が GPU の終わりを待つ間隔 [seed]。1 つの seed で近傍拡散補正の全段を描くので、走査だけを描く
// accumulateWhitePasses より短く取る。
const CORRECTION_PASSES_PER_WAIT = 16;

// 単精度の値 v に最も近い半精度のビット列(DataUtils.toHalfFloat は切り捨てる)。
function nearestHalfOf(v: number): number {
  const truncated = THREE.DataUtils.toHalfFloat(v);
  const away = truncated + 1;
  const error = (bits: number): number => Math.abs(THREE.DataUtils.fromHalfFloat(bits) - v);
  return error(away) < error(truncated) ? away : truncated;
}

// 読み戻した画像。rgba は画素ごとに 4 つの値で、行は上から。
export interface FloatImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Float32Array;
}

// 1 ケースの計測結果。所要時間は [ms] の分布で、gpuPassMs はパスのラベルごと。
export interface LabMeasurement {
  readonly caseName: CaseName;
  readonly frames: number;
  readonly cpuRenderMs: SampleDistribution;
  readonly gpuSupported: boolean;
  readonly gpuPassMs: Readonly<Record<string, SampleDistribution>>;
  readonly gpuPassMsById: Readonly<Record<string, SampleDistribution>>;
  readonly proteinMotion: ProteinMotionMetricSummary;
  readonly proteinCase?: LabCase['proteinMotion'];
}

const ORIGIN = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

// カメラ位置を毎フレーム組み立てる書き込み先。
const CAMERA_OFFSET = new THREE.Vector3();
// 姿勢を重ねたカメラの行列を分解するときの、縮尺の書き込み先。
const SHIFTED_CAMERA_SCALE = new THREE.Vector3();

// 地球の天体照へ渡す恒星の向きの置き場。毎フレーム書き換えて使い回す。
const EARTH_STAR_DIRECTION = new THREE.Vector3();

// カメラの仰角の限界 [deg]。真上・真下では上方向と視線が平行になり、姿勢が決まらない。
export const MAX_CAMERA_ELEVATION_DEG = 89;

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
  // ケースへ渡す論理フレーム。同じ番号で描き直しても、ケースの状態は進まない。
  private frame = 0;
  // 前の論理フレームから、動きベクトルでは追えない変化の量 (0 = 変化なし、Infinity = 切り替え)。
  private change = 0;
  private selectedDebugTarget: DebugTargetId = 'off';
  // 画面全体の見せ方。起動のたびに写実から始める。
  private style: RenderStyle = 'realistic';
  // 直前の render がパイプラインの描画に費やした CPU 時間 [ms]。
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
  // 全ケースの環の帯が共有するマテリアル。
  private readonly ringMaterials: RingMaterials;
  // 恒星。ケースによらず、観察のつまみの置き方へ描くたびに置き直す。
  private readonly sun = new LabSun();
  // 地球。実写の画像と雲場をケースの切り替えのたびに読み直さないよう 1 つだけ組み、地球を置く
  // ケースのあいだだけシーンへ出して、観察のつまみの置き方へ描くたびに置き直す。
  private readonly earth = new LabEarth();

  // 起動時の描画品質設定の選び方を解いた平らな値一式。撮影はこれへ差分を重ねる。
  private readonly startupGraphics: GraphicsSettingsData;
  // 描画が読む、いまの選び方を解いた平らな値一式。
  private resolvedGraphics: GraphicsSettingsData;

  // 受け手の近傍の半径が写る画素数を描く先と、その描画命令。深度から位置を戻す実カメラの行列は描くたびに書き込む。
  private readonly radiusTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  private readonly radiusQuad = new QuadMesh();
  private readonly radiusProjection: Mat4Uniform = uniform(new THREE.Matrix4());
  private readonly radiusProjectionInverse: Mat4Uniform = uniform(new THREE.Matrix4());
  // accumulateWhitePasses が走査の帯を足し込む器。初めて足すとき、または帯の描画先が変わったときに作り直す。
  private passAccumulator: PassAccumulator | null = null;
  // averageCorrection が最後の拡大の出力を足し込む器。初めて足すときに作る。
  private correctionAccumulator: PassAccumulator | null = null;
  // G バッファの素の深度を写す先と、その描画命令。
  private readonly depthTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  private readonly depthQuad = new QuadMesh();
  // 観察の向きで置いたカメラへ、カメラの座標で重ねる姿勢(setCameraShift)。null なら重ねない。
  private cameraShift: THREE.Matrix4 | null = null;
  // カメラの射影のずれ [描画バッファの画素](setRasterJitter)。null ならずらさない。
  private rasterJitterPx: readonly [number, number] | null = null;
  // 与えた HDR を合成した表示を、8 bit へ丸めずに受ける先。合成は深度も写すので深度を持たせる。
  private readonly compositeTarget = new THREE.RenderTarget(VIEW_WIDTH, VIEW_HEIGHT, {
    type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true,
  });

  // graphics は描く描画品質設定の選び方の器。
  private constructor(
    private readonly renderer: WebGPURenderer,
    private readonly pipeline: RenderPipeline,
    private readonly gpu: GpuTimings,
    private readonly graphics: StoredSetting<GraphicsSelection>,
  ) {
    this.pipeline.screenSpace.setJitterSources(null);
    // RenderPipeline はカメラのチャンネルを一時的に絞る。シーンルートが既定の 0 だけだと
    // その時点で子要素の走査が止まるため、コンテナとして全チャンネルを受ける。
    this.scene.layers.enableAll();
    this.ringMaterials = new RingMaterials(pipeline.bodyShadow, pipeline.sunLight);
    this.sun.addTo(this.scene);
    this.startupGraphics = resolveGraphics(graphics.current);
    this.resolvedGraphics = this.startupGraphics;
    graphics.subscribe((selection) => this.rebuildForGraphics(resolveGraphics(selection)));
    // 近傍の半径は、近傍拡散補正の走査と同じ式で、描画バッファの画素で測る。
    const radius = new THREE.MeshBasicNodeMaterial({
      depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending,
    });
    const depth = textureLoad(pipeline.gbuffer.depthTexture, ivec2(screenCoordinate.xy)).r;
    const position = getViewPosition(screenUV, depth, this.radiusProjectionInverse);
    const pixels = projectedRadius(position, this.radiusProjection, vec2(VIEW_WIDTH, VIEW_HEIGHT));
    radius.colorNode = vec4(select(depth.greaterThan(0), pixels, 0), 0, 0, 1);
    this.radiusQuad.material = radius;
    // 深度は色の経路を通さず MRT の出力で写す — 単精度の値をそのまま残す。
    this.depthTarget.texture.name = 'labDepth';
    const depthCopy = stageMaterial();
    depthCopy.mrtNode = mrt({ labDepth: vec4(depth, 0, 0, 0) });
    this.depthQuad.material = depthCopy;
  }

  // graphics は描く描画品質設定の選び方の器。この時点の選び方を起動時の設定として控え、以後はその変更を
  // 受けて描き直す。
  public static async create(
    canvas: HTMLCanvasElement, graphics: StoredSetting<GraphicsSelection>,
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
    const pipeline = new RenderPipeline(renderer, resolveGraphics(graphics.current), gpu);
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
      this.current.dispose?.();
      this.scene.remove(...this.current.objects);
      this.current.disposeProteinMotion?.();
      for (const root of this.current.objects) disposeOwnedRenderResources(root);
    }
    const built = CASES[name](this.style, this.ringMaterials);
    // **1 つずつ足す** — 地球のほかに物体を持たないケースで空の引数を渡すと、three.js がエラーを出す。
    for (const object of built.objects) this.scene.add(object);
    this.current = built;
    this.currentName = name;
    built.setFrame?.(this.frame);
    // 地球はケースが置き方を宣言したときだけ出し、まずその既定の置き方へ置く。
    if (built.earth !== undefined) {
      this.scene.add(this.earth.object);
      this.earth.place(built.earth);
    } else {
      this.scene.remove(this.earth.object);
    }
    // **カメラの既定を引く前に一度同期する** — 環はここで姿勢が決まるので、同期する前に
    // 物体を包む箱を測ると注視点が原点へ寄る。
    built.sync?.(this.resolvedGraphics, built.earth === undefined ? null : this.earth.center);
  }

  // 描画品質設定 graphics を以後の描画で読み、パイプラインを組み直して、その場で描き直す。
  private rebuildForGraphics(graphics: GraphicsSettingsData): void {
    this.resolvedGraphics = graphics;
    this.pipeline.ambient.setFraction(ambientFraction(graphics));
    this.pipeline.rebuildForGraphics(graphics);
    this.render();
  }

  // 画面へ出す中間バッファを選び、その場で描き直す。
  public showDebugTarget(target: DebugTargetId): void {
    this.selectedDebugTarget = target;
    this.pipeline.syncDebugTarget(target);
    this.render();
  }

  public get debugTarget(): DebugTargetId { return this.selectedDebugTarget; }

  // いま表示しているケース。ケースを表示していなければ null。
  public get currentCase(): LabCase | null { return this.current; }

  // 現在のケースで積み直しと前行列の CPU 標本を作る。
  public measurePoolRebuild(iterations: number): ReturnType<NonNullable<LabCase['measurePoolRebuild']>> {
    if (this.current?.measurePoolRebuild === undefined) {
      throw new Error('render-lab: the current case has no pool measurement');
    }
    const result = this.current.measurePoolRebuild(iterations);
    const gbuffer = this.pipeline.gbuffer as typeof this.pipeline.gbuffer & {
      writePoolMatrices?: (camera: THREE.Camera) => void;
    };
    const previousMatricesMs = Array.from({ length: iterations }, () => {
      if (gbuffer.writePoolMatrices === undefined) return 0;
      const started = performance.now();
      gbuffer.writePoolMatrices(this.current!.camera);
      return performance.now() - started;
    });
    return {
      ...result,
      previousMatricesMs,
    };
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

  // 論理フレーム frame と変化量 change を覚え、ケースをその番号の状態へ置いて描き直す。
  public setFrame(frame: number, change = 0): void {
    if (!Number.isInteger(frame) || frame < 0) throw new Error(`render-lab: invalid frame ${frame}`);
    this.frame = frame;
    this.change = change;
    this.current?.setFrame?.(frame);
    this.render();
  }

  // 現在のケース固有の値 name を value へ差し替えて描き直す。
  public setCaseValue(name: string, value: string | number | boolean): void {
    if (this.current?.setValue === undefined) throw new Error('render-lab: the current case has no configurable values');
    this.current.setValue(name, value);
    this.render();
  }

  // 次に描くフレームから、観察の向きで置いたカメラへ、カメラの座標の剛体の変換 shift を重ねる。null で外す。観察の
  // 向きでは表せない、カメラの軸に沿う並進と、カメラの位置を中心とする回転を与える口。
  public setCameraShift(shift: THREE.Matrix4 | null): void {
    this.cameraShift = shift;
  }

  // 次に描くフレームから、カメラの射影を描画バッファの画素で offsetPx(x は右、y は下)だけずらす — ラスタライズの
  // ジッター。null で外す。
  public setRasterJitter(offsetPx: readonly [number, number] | null): void {
    this.rasterJitterPx = offsetPx;
  }

  // 直前に描いたフレームのカメラ。ケースを表示していなければ投げる。
  public get camera(): THREE.PerspectiveCamera {
    if (this.current === null) throw new Error('render-lab: no case selected');
    return this.current.camera;
  }

  // ケースのカメラと注視点から、観察の向きの既定値を引き直す。
  private resetView(): void {
    const built = this.current;
    if (built === null) return;
    // ケースのカメラから、周回の中心と既定の距離・画角を引く。**注視点はカメラの視線上へ落として
    // から使う** — 視線から外れた点を注視させると、向きへ触れていないのに絵が回る。
    const camera = built.camera;
    camera.updateMatrixWorld(true);
    const forward = camera.getWorldDirection(new THREE.Vector3());
    const pivot = built.viewTarget ?? boundsCenterOf(built.objects) ?? camera.position.clone().add(forward);
    const depth = forward.dot(new THREE.Vector3().subVectors(pivot, camera.position));
    this.defaultCameraDistance = Math.max(depth, camera.near);
    this.defaultCameraFovDeg = camera.fov;
    this.pivot.copy(camera.position).addScaledVector(forward, this.defaultCameraDistance);
    // 恒星とカメラの向きを角度へ直す。地球を置かないケースでは、地球のつまみを前のケースの値のまま保つ。
    const sun = anglesFromDirection(built.sunDirection ?? SUN_DIR);
    const eye = anglesFromDirection(forward.clone().negate());
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

  // いまのケースを、観察の向きと描画品質設定の現在値で、表示時刻 displayTime [s] の 1 フレームとして描く。
  public render(displayTime = 0): void {
    if (this.current === null) return;
    const graphics = this.resolvedGraphics;
    // カメラを観察の向きへ置く。画角と遠クリップ距離の書き換えは、投影行列を組み直すまで無言で効かない。
    // 遠クリップ距離は、周回の中心までの距離を注視距離としてゲーム本体と同じ式で引く。
    const camera = this.current.camera;
    directionFromAngles(this.angles.cameraAzimuthDeg, this.angles.cameraElevationDeg, CAMERA_OFFSET);
    camera.position.copy(this.pivot).addScaledVector(CAMERA_OFFSET, this.cameraDistance);
    camera.lookAt(this.pivot);
    if (this.cameraShift !== null) {
      camera.updateMatrix();
      // 縮尺は捨てる — カメラの縮尺へ書き戻すと、描くたびに丸めの誤差が溜まる。
      camera.matrix.multiply(this.cameraShift).decompose(camera.position, camera.quaternion, SHIFTED_CAMERA_SCALE);
    }
    camera.updateMatrixWorld(true);
    camera.fov = this.cameraFovDeg;
    camera.far = farClip(this.cameraDistance);
    if (this.rasterJitterPx === null) camera.clearViewOffset();
    else camera.setViewOffset(VIEW_WIDTH, VIEW_HEIGHT, ...this.rasterJitterPx, VIEW_WIDTH, VIEW_HEIGHT);
    camera.updateProjectionMatrix();
    // 恒星・地球・ケースの部品は、このフレームのカメラを置いてから合わせる — 部品はそのカメラを読んでよい。
    // ケースの部品は地球の中心も読むので、地球を先に置く。
    this.sun.sync(this.angles, camera, graphics, this.style);
    const earth = this.current.earth === undefined ? null : this.earth;
    earth?.place(this.angles);
    earth?.sync(camera, graphics, this.style);
    this.current.sync?.(graphics, earth?.center ?? null);
    // 恒星の光と露出。順応の基準点は描画原点 — **恒星の距離のつまみはここから恒星までの距離**なので、
    // 露出はその1つの数だけで決まり、ケースが物体をどこへ置いたかには引きずられない。
    this.pipeline.sunLight.set(this.sun.position, R_SUN, SUN_LIGHT_COLOR, this.sun.intensity);
    this.pipeline.exposure.setReference(ORIGIN, this.sun.position, this.sun.intensity);
    // 天体照の光源は地球だけ、影・大気の源は地球のぶんとケースのぶんを合わせて渡す。
    this.pipeline.planetLight.set(earth === null ? [] : [earthLightValue(earth, this.sun, graphics.airglow)]);
    this.pipeline.sphereLights.set(this.current.sphereLights ?? []);
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
      graphics,
    ));
    const startedAt = performance.now();
    this.pipeline.render(this.scene, camera, this.style, this.frame, this.change);
    this.lastRenderCpuMs = performance.now() - startedAt;
    this.gpu.resolve();
  }

  // ケースを表示して測る。angles を渡すと、ケース既定の観察の向きへそれを重ねてから測る。
  public async measure(
    name: CaseName, angles: Partial<LabViewAngles> = {}, warmupFrames = 6, sampleFrames = 30,
  ): Promise<LabMeasurement> {
    this.show(name);
    this.setViewAngles(angles);
    return this.measureCurrent(warmupFrames, sampleFrames);
  }

  // 現在のケース・観察角・描画設定を保ったまま、CLI と同じ暖機と30標本で測る。
  public async measureCurrent(warmupFrames = 6, sampleFrames = 30): Promise<LabMeasurement> {
    if (this.currentName === null) throw new Error('render-lab: no case selected for measurement');
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
      const timings = this.gpu.snapshot();
      for (const [index, samples] of gpuSamples.entries()) samples.push(timings.elapsedMs[index] ?? 0);
      motion.record(motionSample ?? { cpuMs: 0, uploadBytes: 0, lodCounts: {} });
    }

    return {
      caseName: this.currentName,
      frames: sampleFrames,
      cpuRenderMs: distributionOf(cpuSamples),
      gpuSupported: this.gpu.snapshot().supported,
      gpuPassMs: Object.fromEntries(GPU_PASS_LABELS.map((label, index) => [label, distributionOf(gpuSamples[index]!)])),
      gpuPassMsById: Object.fromEntries(Object.entries(GPU_PASS).map(([id, index]) => [
        id, distributionOf(gpuSamples[index]!),
      ])),
      proteinMotion: motion.summary(),
      proteinCase: this.current?.proteinMotion,
    };
  }

  // いまのケース・観察の向き・描画設定のまま、近傍拡散補正の走査の段 tiers を rounds 巡(奇数巡目は逆順)交互に
  // 測る。返り値は [段][巡] の、GPU の行の名前から p50 [ms] への表で、GPU の計測に対応していなければ null。段は最後に
  // 測ったものが残る。
  public async measureTierRounds(
    tiers: readonly ScanTier[], rounds: number,
  ): Promise<readonly (readonly Readonly<Record<string, number>>[])[] | null> {
    const results = tiers.map((): Readonly<Record<string, number>>[] => []);
    // 巡ごとに順を入れ替えて、熱によるずれを段の差と取り違えないようにする。
    for (let round = 0; round < rounds; round++) {
      const order = round % 2 === 0 ? [...tiers.keys()] : [...tiers.keys()].reverse();
      for (const index of order) {
        this.pipeline.screenSpace.setTier(tiers[index]!);
        const result = await this.measureCurrent();
        if (!result.gpuSupported) return null;
        results[index]!.push(Object.fromEntries(GPU_PASS_LABELS.map((label) => [label, result.gpuPassMs[label]!.p50])));
      }
    }
    return results;
  }

  // measureTierRounds と同じく測り、段ごとの、GPU の行の名前から p50 [ms] の巡の中央値への表を返す。GPU の計測に
  // 対応していなければ値は null。
  public async measureTiers(
    tiers: readonly ScanTier[], rounds: number,
  ): Promise<readonly Readonly<Record<string, number | null>>[]> {
    const rows = await this.measureTierRounds(tiers, rounds);
    return tiers.map((_, index) => Object.fromEntries(GPU_PASS_LABELS.map((label) => [
      label, rows === null ? null : distributionOf(rows[index]!.map((row) => row[label]!)).p50,
    ])));
  }

  // いまのケースの、いまの方式と段の近傍拡散補正の描画命令の、実行順の GPU の行の名前とフラグメントシェーダの WGSL。
  public async screenSpaceShaders(): Promise<readonly { readonly label: string; readonly wgsl: string }[]> {
    if (this.current === null) throw new Error('render-lab: no case selected');
    const stages = await this.pipeline.screenSpace.stageShaders(this.current.camera, VIEW_WIDTH, VIEW_HEIGHT);
    return stages.map(({ gpuPass, wgsl }) => ({ label: GPU_PASS_LABELS[gpuPass]!, wgsl }));
  }

  // 近傍拡散補正の方式をオフにして 1 フレーム描き、その全描画先を空にする。方式は描画設定のものへ戻し、段は保つ。
  public clearScreenSpace(): void {
    const { screenSpace } = this.pipeline;
    screenSpace.setMode(SCREEN_SPACE_DIFFUSE.off);
    this.render();
    screenSpace.setMode(screenSpaceDiffuseOf(this.resolvedGraphics));
  }

  // 次に描くフレームから、近傍拡散補正を段 tier で走査する。描画品質設定が変わると精細さの段へ戻る。
  public setScanTier(tier: ScanTier): void {
    this.pipeline.screenSpace.setTier(tier);
  }

  // render-lab 専用の比較方式を切り替える。本番 graphics settings には露出しない。
  public setScreenSpaceExperiment(
    variant: ScreenSpaceExperimentVariant | null, tier: ScanTier, sparseTapCount = 8,
  ): void {
    this.pipeline.screenSpace.setTier(tier);
    this.pipeline.screenSpace.setExperiment(variant, sparseTapCount);
    if (variant !== null) this.pipeline.screenSpace.setMode(SCREEN_SPACE_DIFFUSE.indirect);
    else this.pipeline.screenSpace.setMode(screenSpaceDiffuseOf(this.resolvedGraphics));
  }

  // 完成した補正を独立パスごとに描き、その出力を平均する一候補の GPU 費用を測る。
  public async measureScreenSpacePaths(
    seeds: readonly (readonly [number, number])[], sampleCount = 8,
  ): Promise<{
    readonly gpuSupported: boolean;
    readonly gpuPassMsById: Readonly<Record<string, SampleDistribution>>;
  }> {
    if (this.current === null) throw new Error('render-lab: no case selected for screen-space timing');
    if (seeds.length < 1 || !Number.isInteger(sampleCount) || sampleCount < 1
      || seeds.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) {
      throw new RangeError('render-lab: path measurement needs positive integer counts');
    }
    const screenSpace = this.pipeline.screenSpace;
    const target = screenSpace.experimentOutputTarget;
    const accumulator = new PassAccumulator(this.renderer, target.textures, target.width, target.height);
    const samples = Object.fromEntries(Object.keys(GPU_PASS).map((id) => [id, [] as number[]]));
    try {
      for (let sample = 0; sample < sampleCount; sample++) {
        await this.gpu.waitForResolve();
        this.gpu.reset();
        accumulator.clear(() => this.gpu.beginPass(GPU_PASS.nearbyDiffuseAverage));
        for (const [path, seed] of seeds.entries()) {
          screenSpace.setWhiteNoisePass(null);
          screenSpace.setSeed(seed[0], seed[1]);
          screenSpace.renderExperimentPath(this.current.camera, VIEW_WIDTH, VIEW_HEIGHT, path === 0);
          accumulator.add((path % 2) as 0 | 1, () => this.gpu.beginPass(GPU_PASS.nearbyDiffuseAverage));
        }
        accumulator.writeAverage(target, seeds.length, () => this.gpu.beginPass(GPU_PASS.nearbyDiffuseAverage));
        await this.renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
        this.gpu.resolve();
        await this.gpu.waitForResolve();
        const timings = this.gpu.snapshot();
        for (const [id, index] of Object.entries(GPU_PASS)) samples[id]!.push(timings.elapsedMs[index] ?? 0);
      }
      return {
        gpuSupported: this.gpu.snapshot().supported,
        gpuPassMsById: Object.fromEntries(Object.entries(samples).map(([id, values]) => [id, distributionOf(values)])),
      };
    } finally {
      screenSpace.setWhiteNoisePass(null);
      accumulator.dispose();
    }
  }

  // 次に描くフレームから、近傍拡散補正の走査が読むブルーノイズを (x, y) [タイルの幅] だけずらす。
  public setScanSeed(x: number, y: number): void {
    this.pipeline.screenSpace.setSeed(x, y);
  }

  // 次に描くフレームから、近傍拡散補正の走査の代表を jitter で選ぶ。null はブロックの中心。
  public setScanJitter(jitter: ScanJitter | null): void {
    this.pipeline.screenSpace.setScanJitter(jitter);
  }

  // 次に描くフレームから、本番の番号由来ジッターに使う源を選ぶ。null は明示した走査値を保つ。
  public setJitterSources(sources: readonly JitterSource[] | null): void {
    this.pipeline.screenSpace.setJitterSources(sources);
  }

  // いまの段の走査の画素の幅 [描画バッファの画素]。
  public get scanCellSize(): number { return this.pipeline.screenSpace.scanCellSize; }

  // 位相 phase で近傍拡散補正を描き直す。射影のずれを使う(いま使っている)ならフレーム全体を、そうでなければ直前に描いた
  // フレームの G バッファなどを入力のまま近傍拡散補正だけを描く。
  public renderCorrection(phase: CorrectionPhase): void {
    if (this.current === null) throw new Error('render-lab: no case selected');
    const { screenSpace } = this.pipeline;
    screenSpace.setSeed(...phase.seed);
    screenSpace.setScanJitter(phase.scanJitter);
    // 射影のずれを外すときも、ずれた G バッファを捨てるためにフレーム全体を描き直す。
    if (phase.rasterJitter !== null || this.rasterJitterPx !== null) {
      this.setRasterJitter(phase.rasterJitter);
      this.render();
    } else {
      screenSpace.render(this.current.camera, VIEW_WIDTH, VIEW_HEIGHT);
    }
  }

  // 次に描くフレームから、近傍拡散補正の段の範囲 range だけを描く('chain' は帯を詰めた描画先に置いた値から鎖を描く)。
  public setScanStageRange(range: ScreenSpaceStageRange): void {
    this.pipeline.screenSpace.setStageRange(range);
  }

  // render-lab の参照撮影で、最後の拡大の A だけを 1 に固定する。通常経路へ戻すときは false を渡す。
  public setUpsampleAlphaOne(enabled: boolean): void {
    this.pipeline.screenSpace.setUpsampleAlphaOne(enabled);
  }

  // 次に描くフレームから、近傍拡散補正の走査のずれを、pass が null ならブルーノイズから、整数ならパスの番号 pass の
  // ホワイトノイズから引く。
  public setScanWhiteNoisePass(pass: number | null): void {
    this.pipeline.screenSpace.setWhiteNoisePass(pass);
  }

  // 直前に描いたフレームの G バッファなどを入力のまま、近傍拡散補正の照り返しの源と走査だけを、ホワイトノイズのパスの番号
  // first〜first + count − 1 で描き直し、走査が帯を詰めたテクスチャを偶数番目と奇数番目のパスに分けて和へ足す。和は
  // takePassSums で受け取る。終わると段の範囲とノイズは本番のものへ戻る。
  public async accumulateWhitePasses(first: number, count: number): Promise<void> {
    if (this.current === null) throw new Error('render-lab: no case selected');
    const { screenSpace, diffuseCorrection } = this.pipeline;
    const target = diffuseCorrection.bandTarget(screenSpace.bandCount, 0);
    if (this.passAccumulator?.sources !== target.textures) {
      this.passAccumulator?.dispose();
      this.passAccumulator = new PassAccumulator(this.renderer, target.textures, target.width, target.height);
    }
    screenSpace.setStageRange('scan');
    try {
      for (let k = first; k < first + count; k++) {
        screenSpace.setWhiteNoisePass(k);
        screenSpace.render(this.current.camera, VIEW_WIDTH, VIEW_HEIGHT);
        this.passAccumulator.add(k % 2 === 0 ? 0 : 1);
        // GPU の待ち行列が際限なく伸びないよう、ときどき終わりを待つ。時刻印の器も空ける。
        if ((k - first) % WHITE_PASSES_PER_WAIT === WHITE_PASSES_PER_WAIT - 1) {
          await this.renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
          this.gpu.resolve();
        }
      }
    } finally {
      screenSpace.setStageRange('all');
      screenSpace.setWhiteNoisePass(null);
    }
  }

  // accumulateWhitePasses で足した値の和 sums と成分ごとの二乗の和 squares(どちらも [偶数番目, 奇数番目] の、帯を詰めた
  // テクスチャごと)を読み戻し、和を 0 に戻す。
  public async takePassSums(includeSquares = true): Promise<{
    readonly sums: readonly (readonly FloatImage[])[]; readonly squares: readonly (readonly FloatImage[])[];
  }> {
    const accumulator = this.passAccumulator;
    if (accumulator === null) throw new Error('render-lab: no passes accumulated');
    // 偶奇ごと・テクスチャごとに読み戻す。
    const readBackHalves = async (halves: readonly (readonly THREE.Texture[])[]): Promise<FloatImage[][]> => {
      const images: FloatImage[][] = [];
      for (const textures of halves) {
        const half: FloatImage[] = [];
        for (const texture of textures) half.push(await this.readBack(texture));
        images.push(half);
      }
      return images;
    };
    const sums = await readBackHalves(accumulator.sumTextures);
    const squares = includeSquares ? await readBackHalves(accumulator.squareTextures) : [];
    accumulator.clear();
    return { sums, squares };
  }

  // 直前に描いたフレームを位相の列 phases で描き直し(renderCorrection)、最後の拡大の出力(rgba)の平均を返す。終わると
  // 位相は本番の静止画のものへ戻り、'correction' はその出力になる。
  public async averageCorrection(phases: readonly CorrectionPhase[]): Promise<FloatImage> {
    if (phases.length === 0) throw new RangeError('render-lab: averaging needs at least one phase');
    const target = this.pipeline.diffuseCorrection.upsampledTarget;
    this.correctionAccumulator ??= new PassAccumulator(this.renderer, [target.texture], target.width, target.height);
    for (const [k, phase] of phases.entries()) {
      this.renderCorrection(phase);
      this.correctionAccumulator.add(0);
      // GPU の待ち行列が際限なく伸びないよう、ときどき終わりを待つ。時刻印の器も空ける。
      if (k % CORRECTION_PASSES_PER_WAIT === CORRECTION_PASSES_PER_WAIT - 1) {
        await this.renderer.readRenderTargetPixelsAsync(target, 0, 0, 1, 1);
        this.gpu.resolve();
      }
    }
    const sum = await this.readBack(this.correctionAccumulator.sumTextures[0]![0]!);
    this.correctionAccumulator.clear();
    this.renderCorrection(PRODUCTION_PHASE);
    return { ...sum, rgba: sum.rgba.map((v) => v / phases.length) };
  }

  // いまの段の帯の数の、走査の帯を詰めた描画先の index 枚目('packed-bands-<index>')へ、走査の解像度の画素ごとの RGBA の
  // 値 rgba(行は上から)を半精度へ丸めて書く。いまの段で 1 度描いて描画先の寸法を合わせてから呼ぶ。段の範囲
  // 'chain' のフレーム(setScanStageRange)が鎖の入力として読む。
  public writePackedBands(index: number, rgba: Float32Array): void {
    const target = this.pipeline.diffuseCorrection.bandTarget(this.pipeline.screenSpace.bandCount, 0);
    const destination = target.textures[index];
    if (destination === undefined) throw new Error(`render-lab: the scan has no packed band texture ${index}`);
    const { width, height } = target;
    if (rgba.length !== width * height * 4) throw new Error(`render-lab: packed bands are ${width}×${height} RGBA`);
    // 走査の出力と同じ形式(rgba16float)の板を作り、描画先へ写す。
    const source = new THREE.DataTexture(
      Uint16Array.from(rgba, nearestHalfOf), width, height, THREE.RGBAFormat, THREE.HalfFloatType);
    source.needsUpdate = true;
    this.renderer.copyTextureToTexture(source, destination);
    source.dispose();
  }

  // 直前に描いたフレームの露出係数。
  public get exposureFactor(): number { return this.pipeline.exposure.factorValue; }

  // 直前に描いたフレームの中間ターゲット name を読み戻す。
  public async readFloat(name: FloatTargetName): Promise<FloatImage> {
    if (name === 'band-sum') return this.readBandSum();
    if (name === 'projected-radius') return this.readBack(this.drawProjectedRadius());
    if (name === 'depth') return this.readBack(this.drawDepth());
    return this.readBack(this.floatTextureOf(name));
  }

  // 直前に描いたフレームの、いまの段の帯の数の走査の帯の和(rgb、α は 0)。帯の並びは packedBands の通しのチャンネル。
  private async readBandSum(): Promise<FloatImage> {
    const count = this.pipeline.screenSpace.bandCount;
    const packed: FloatImage[] = [];
    for (const texture of this.pipeline.diffuseCorrection.bandTarget(count, 0).textures) {
      packed.push(await this.readBack(texture));
    }
    const { width, height } = packed[0]!;
    const rgba = new Float32Array(width * height * 4);
    // 帯 b の成分 c は通しのチャンネル 3b + c。
    for (let channel = 0; channel < 3 * count; channel++) {
      const source = packed[Math.floor(channel / 4)]!.rgba;
      for (let p = 0; p < width * height; p++) {
        const sum = 4 * p + channel % 3;
        rgba[sum] = rgba[sum]! + source[4 * p + channel % 4]!;
      }
    }
    return { width, height, rgba };
  }

  // HDR の絵 hdr(線形、描画バッファと同じ寸法)を、直前に描いたフレームと同じ通常表示の合成で描いて読み戻す。値は
  // 表示用の色空間(sRGB)へ変換済みで、8 bit へ丸める前のもの。同じケースを描いた直後に呼ぶ。
  public async composite(hdr: FloatImage): Promise<FloatImage> {
    const texture = new THREE.DataTexture(hdr.rgba, hdr.width, hdr.height, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    this.pipeline.renderComposite(texture, this.compositeTarget);
    const display = await this.readBack(this.compositeTarget.texture);
    texture.dispose();
    return display;
  }

  public signedCorrectionDisplay(hdr: FloatImage, exposure = this.pipeline.exposure.factorValue): FloatImage {
    if (hdr.rgba.length !== hdr.width * hdr.height * 4) throw new RangeError('render-lab: invalid RGBA image');
    const output = new Float32Array(hdr.rgba.length);
    const oetf = (value: number): number => value <= 0.0031308
      ? 12.92 * value : 1.055 * value ** (1 / 2.4) - 0.055;
    for (let i = 0; i < hdr.rgba.length; i += 4) {
      if (hdr.rgba[i + 3] === 0) continue;
      const value = [0, 1, 2].map((c) => Math.abs(hdr.rgba[i + c]!) * exposure);
      const minimum = Math.min(...value);
      const offset = minimum < 0.08 ? minimum - 6.25 * minimum * minimum : 0.04;
      const color = value.map((channel) => channel - offset);
      const peak = Math.max(...color);
      if (peak >= 0.76) {
        const newPeak = 1 - 0.24 * 0.24 / (peak + 0.24 - 0.76);
        const desaturation = 1 - 1 / (0.15 * (peak - newPeak) + 1);
        for (let c = 0; c < 3; c++) {
          color[c] = color[c]! * (newPeak / peak) * (1 - desaturation) + newPeak * desaturation;
        }
      }
      for (let c = 0; c < 3; c++) {
        const magnitude = oetf(Math.max(0, color[c]!));
        const signedCode = 0.5 + Math.sign(hdr.rgba[i + c]!) * magnitude * 0.5;
        output[i + c] = signedCode;
      }
      output[i + 3] = 1;
    }
    return { width: hdr.width, height: hdr.height, rgba: output };
  }

  public async signedCorrectionPng(hdr: FloatImage): Promise<string> {
    if (hdr.rgba.length !== hdr.width * hdr.height * 4) throw new RangeError('render-lab: invalid RGBA image');
    if (hdr.width !== VIEW_WIDTH || hdr.height !== VIEW_HEIGHT) throw new RangeError('render-lab: signed PNG needs the viewport size');
    const texture = new THREE.DataTexture(hdr.rgba, hdr.width, hdr.height, THREE.RGBAFormat, THREE.FloatType);
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
    try {
      this.pipeline.renderSignedCorrectionComposite(texture, this.captureTarget);
      const pixels = await this.renderer.readRenderTargetPixelsAsync(this.captureTarget, 0, 0, VIEW_WIDTH, VIEW_HEIGHT);
      return pixelsToPngDataUrl(new Uint8Array(pixels.buffer), VIEW_WIDTH, VIEW_HEIGHT);
    } finally {
      texture.dispose();
    }
  }

  // 描画先のテクスチャ texture を浮動小数で読み戻す。成分が 4 つに満たない形式では、無い成分を 0 にする。
  private async readBack(texture: THREE.Texture): Promise<FloatImage> {
    const target = texture.renderTarget;
    if (target === null) throw new Error(`render-lab: "${texture.name}" is not a render target`);
    const channels = CHANNELS_OF_FORMAT[texture.format];
    if (channels === undefined) throw new Error(`render-lab: "${texture.name}" has an unreadable format`);
    const { width, height } = target;
    const data = await this.renderer.readRenderTargetPixelsAsync(
      target, 0, 0, width, height, target.textures.indexOf(texture),
    );
    // 行の終わりは 256 byte の境まで詰め物が入る。最後の行には入らない。
    const rowStride = height > 1 ? (data.length - width * channels) / (height - 1) : width * channels;
    const toFloat = data instanceof Uint16Array ? THREE.DataUtils.fromHalfFloat : (v: number) => v;
    const rgba = new Float32Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const [from, to] = [y * rowStride + x * channels, (y * width + x) * 4];
        for (let c = 0; c < channels; c++) rgba[to + c] = toFloat(data[from + c]!);
      }
    }
    return { width, height, rgba };
  }

  // 本番のパイプラインが持つ中間ターゲット name のテクスチャ。いまの段の帯の数の鎖に無い段か枚数なら投げる。
  private floatTextureOf(name: Exclude<FloatTargetName, 'band-sum' | 'projected-radius' | 'depth'>): THREE.Texture {
    const { screenSpace, diffuseCorrection } = this.pipeline;
    switch (name) {
      case 'scan-correction': return diffuseCorrection.mergedTexture(screenSpace.bandCount, 0);
      case 'upsampled-correction': return diffuseCorrection.upsampledTarget.texture;
      case 'correction-history': return screenSpace.temporalHistoryTexture;
      case 'previous-depth': return screenSpace.previousDepthTexture;
      case 'correction': return diffuseCorrection.texture;
      case 'diffuse': return this.pipeline.lighting.diffuseTexture;
      case 'surface-radiance': return screenSpace.surfaceRadianceTexture;
      case 'hdr': return this.pipeline.hdrTexture;
      case 'motion': return this.pipeline.gbuffer.motionTexture;
      default: {
        const count = screenSpace.bandCount;
        const [, scanSurfaceIndex] = SCAN_SURFACE_NAME_PATTERN.exec(name) ?? [];
        if (scanSurfaceIndex !== undefined) {
          return screenSpace.inputPyramid.scanSurfaceTexture(Number(scanSurfaceIndex) as 0 | 1);
        }
        // 代表の段は、いまの段の帯の数の鎖が読む段 1..帯の数 − 1。
        const [, representativeLevel] = REPRESENTATIVE_NAME_PATTERN.exec(name) ?? [];
        if (representativeLevel !== undefined) {
          if (Number(representativeLevel) >= count) throw new Error(`render-lab: ${count} bands have no "${name}"`);
          return screenSpace.inputPyramid.representativeTexture(Number(representativeLevel));
        }
        const [, mergedLevel] = MERGED_NAME_PATTERN.exec(name) ?? [];
        if (mergedLevel !== undefined) {
          if (Number(mergedLevel) >= count - 1) throw new Error(`render-lab: ${count} bands have no "${name}"`);
          return diffuseCorrection.mergedTarget(count, Number(mergedLevel)).texture;
        }
        // 帯を詰めたテクスチャは、いまの段の帯の数の、名前の段(無ければ走査の段 0)の描画先から引く。
        const [, level = '0', index] = PACKED_BANDS_NAME_PATTERN.exec(name)!;
        const texture = Number(level) < count
          ? diffuseCorrection.bandTarget(count, Number(level)).textures[Number(index)] : undefined;
        if (texture === undefined) throw new Error(`render-lab: ${count} bands have no "${name}"`);
        return texture;
      }
    }
  }

  // 直前に描いたフレームの G バッファの深度から、受け手の近傍の半径が写る画素数を描き、そのテクスチャを返す。
  private drawProjectedRadius(): THREE.Texture {
    if (this.current === null) throw new Error('render-lab: no case selected');
    const camera = this.current.camera;
    this.radiusProjection.value.copy(camera.projectionMatrix);
    this.radiusProjectionInverse.value.copy(camera.projectionMatrixInverse);
    this.renderer.setRenderTarget(this.radiusTarget);
    this.radiusQuad.render(this.renderer);
    this.renderer.setRenderTarget(null);
    return this.radiusTarget.texture;
  }

  // 直前に描いたフレームの G バッファの深度を写し、そのテクスチャを返す。
  private drawDepth(): THREE.Texture {
    this.renderer.setRenderTarget(this.depthTarget);
    this.depthQuad.render(this.renderer);
    this.renderer.setRenderTarget(null);
    return this.depthTarget.texture;
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
    this.pipeline.setReflectionNoiseOffset(...(shot.reflectionNoiseOffset ?? [0, 0]));
    this.setGraphics({ ...this.startupGraphics, ...graphics, ...shot.graphics });
    this.setViewAngles({ ...this.defaultAngles, ...shot.view });
    const target = shot.debugTarget ?? 'off';
    this.showDebugTarget(target);
  }

  // 描画品質設定を、平らな値一式 next と同じ絵になる選び方にする。**設定の器は同値でも購読者へ配り、
  // パイプラインを組み直す**ので、解いた値がいまの値と 1 項目でも違うときだけ書く。
  private setGraphics(next: GraphicsSettingsData): void {
    const selection = selectionOfGraphics(next);
    // **解いた値どうしで比べる** — オフの分野のノブへ書いた値は選び方に残らないので、next と比べると毎回
    // 変わったと読む。
    const resolved = resolveGraphics(selection);
    const current = this.resolvedGraphics;
    const changed = (Object.keys(resolved) as GraphicsKey[]).some((key) => resolved[key] !== current[key]);
    if (changed) this.graphics.set(selection);
  }

  // ケースを表示し、ケースが宣言した撮影ごとに applyShot を当てて、キャンバスへ出るのと同じ絵
  // (トーンマッピングと sRGB 変換込み)を撮る。graphics は起動時の描画品質設定と撮影の差分のあいだへ
  // 重ねる差分。返り値は撮影名から PNG のデータ URL への表。ケースの部品と地球が揃うまで待ってから
  // 撮る。絵が落ち着かない撮影があれば投げる。観察の向きと描画品質設定は最後の撮影のまま残る。
  public async shoot(
    name: CaseName, graphics: Partial<GraphicsSettingsData> = {},
  ): Promise<Readonly<Record<string, string>>> {
    await this.showReady(name, graphics);
    const pngs: Record<string, string> = {};
    for (const shotName of this.shotNames) {
      this.applyShot(shotName, graphics);
      pngs[shotName] = await this.captureSettled(shotName);
    }
    return pngs;
  }

  // ケース name を表示して部品と地球が揃うのを待ち、撮影 shotName を applyShot で当てる。graphics は shoot と同じ。
  public async showShot(
    name: CaseName, shotName: string, graphics: Partial<GraphicsSettingsData> = {},
  ): Promise<void> {
    await this.showReady(name, graphics);
    this.applyShot(shotName, graphics);
  }

  // ケース name を表示し、部品と地球が揃うまで待つ。**ケースは起動時の値へ graphics を重ねた設定で組んで待つ** —
  // 描画設定が有効な間にしか読み込まない部品(雲など)があり、前の撮影の設定のまま待つと、読み込み前の姿を撮る。
  private async showReady(name: CaseName, graphics: Partial<GraphicsSettingsData>): Promise<void> {
    this.setGraphics({ ...this.startupGraphics, ...graphics });
    this.show(name);
    this.current?.updateProteinMotion?.(1);
    await this.waitUntilReady();
  }

  // 連続する 2 回の capture が一致するまで撮り直し、一致した絵を返す。MAX_SETTLE_CAPTURES 回撮っても
  // 一致しなければ、撮ったものの名前 shotName を添えて投げる。
  public async captureSettled(shotName: string): Promise<string> {
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

  public async captureCorrectionProbe(): Promise<{
    readonly capture: string; readonly signed: string; readonly exposureFactor: number;
    readonly meanAbsoluteError: number; readonly maxAbsoluteError: number;
  }> {
    this.renderer.setOutputRenderTarget(this.captureTarget);
    let capturePixelsPromise: ReturnType<typeof this.renderer.readRenderTargetPixelsAsync>;
    let hdrPromise: Promise<FloatImage>;
    let exposureFactor: number;
    try {
      this.render();
      exposureFactor = this.exposureFactor;
      capturePixelsPromise = this.renderer.readRenderTargetPixelsAsync(
        this.captureTarget, 0, 0, VIEW_WIDTH, VIEW_HEIGHT,
      );
      hdrPromise = this.readBack(this.floatTextureOf('correction'));
    } finally {
      this.renderer.setOutputRenderTarget(null);
    }
    const [capturePixels, hdr] = await Promise.all([capturePixelsPromise!, hdrPromise!]);
    const signedDisplay = this.signedCorrectionDisplay(hdr, exposureFactor!);
    const signedPixels = Uint8Array.from(signedDisplay.rgba, (value) => Math.round(Math.max(0, Math.min(1, value)) * 255));
    let sum = 0;
    let maximum = 0;
    for (let i = 0; i < capturePixels.length; i++) {
      const difference = Math.abs(capturePixels[i]! - signedPixels[i]!);
      sum += difference;
      maximum = Math.max(maximum, difference);
    }
    return {
      capture: pixelsToPngDataUrl(new Uint8Array(capturePixels.buffer), VIEW_WIDTH, VIEW_HEIGHT),
      signed: pixelsToPngDataUrl(signedPixels, VIEW_WIDTH, VIEW_HEIGHT),
      exposureFactor: exposureFactor!,
      meanAbsoluteError: sum / capturePixels.length / 255,
      maxAbsoluteError: maximum / 255,
    };
  }
}

// 物体 objects をすべて包む箱の中心(描画座標)。箱が空なら null。
function boundsCenterOf(objects: readonly THREE.Object3D[]): THREE.Vector3 | null {
  const box = new THREE.Box3();
  for (const root of objects) {
    root.updateWorldMatrix(true, true);
    box.expandByObject(root);
  }
  return box.isEmpty() ? null : box.getCenter(new THREE.Vector3());
}

// 大気 body を、描画設定の大気光の有無 airglow へ合わせた写し。**雲は写した時点で固定せず、読む
// たびに body から引く** — 雲の有無は、地球が描画設定を押し込むたびに置き直される。
function withAirglowSetting(body: AtmosphereBody, airglow: boolean): AtmosphereBody {
  return { ...body, optics: withAirglowEnabled(body.optics, airglow), get clouds() { return body.clouds; } };
}

// 地球 earth を、恒星 sun に照らされた天体照の光源とした値。大気は描画設定の大気光の有無 airglow へ
// 合わせて渡す。
function earthLightValue(earth: LabEarth, sun: LabSun, airglow: boolean): PlanetLightValue {
  const sunIrradiance = sun.irradianceAt(earth.center);
  return {
    center: earth.center,
    radius: R_EARTH,
    radiance: planetRadiance(EARTH_LIGHT_ALBEDO, sunIrradiance),
    appearance: {
      map: earth.lightSourceMap,
      albedo: EARTH_LIGHT_ALBEDO,
      sunIrradiance,
      starDirection: EARTH_STAR_DIRECTION.subVectors(sun.position, earth.center).normalize(),
      bodyFromWorld: earth.bodyFromWorld,
      atmosphere: withAirglowSetting(earth.atmosphere, airglow),
    },
  };
}
