// フレーム全体のレンダリングパイプライン構成 — 各パスの実行順序、描画先レンダーターゲット、合成フロー — を管理する。
// composite パスは通常表示では HDR ターゲットをトーンマッピングして合成し、デバッグ表示を
// 選ぶと中間ターゲットの中身を画面いっぱいに映す。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { screenUV, texture, uniform, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { ATMOSPHERE_QUALITY } from '../atmosphere';
import { CUMULUS_DETAIL } from '../opaque-cloud-surface-renderer';
import type { GraphicsSettingsData } from '../graphics-settings';
import type { RenderStyle } from '../render-style';
import type { Mat4Uniform, Vec3Node, Vec4Node } from '../tsl-types';
import type { DebugTargetId } from './debug-target';
import { GBufferPass } from './gbuffer';
import { compositeMaterial } from './composite-material';
import { DebugComposites } from './debug-composites';
import { AtmospherePass } from './atmosphere-pass';
import { LightPrepass } from './light-prepass';
import { AmbientSource } from './lighting/ambient-source';
import { DiffuseCorrectionSource } from './lighting/diffuse-correction-source';
import { PlanetLightSource } from './lighting/planet-light-source';
import { SphereSpecular } from './lighting/sphere-light';
import { SunSource } from './lighting/sun-source';
import { MaterialPass } from './material-pass';
import { ShadowPass } from './shadow/shadow-pass';
import { SCREEN_SPACE_DIFFUSE, ScreenSpacePass } from './screen-space/screen-space-pass';
import { DiffuseCorrection } from './screen-space/diffuse-correction';
import { BodyShadow } from './shadow/body-shadow';
import { RingShadow } from './shadow/ring-shadow';
import { CloudShadowRenderer } from './shadow/cloud-shadow-renderer';
import { MeshShadow } from './shadow/mesh-shadow';
import { OverlayPass } from './overlay-pass';
import { AntialiasPass } from './antialias-pass';
import { SchematicComposite } from './schematic-composite';
import { LensPass } from './lens-pass';
import { Exposure } from './exposure';
import { SunLight } from './sun-light';
import { ShadowMaps } from './shadow/shadow-maps';
import { flushProteinMotionComputes, registerProteinMotionRenderer } from '../protein/protein-motion-material';
import { FilmLut } from './film-lut';
import { VisualEffectLut } from './visual-effect-lut';
import { compileInto, compileIntoOutput } from './compile-into';
import { DeferredTexture } from '../deferred-texture';
import { setCelestialSurfaceViewport } from '../celestial/celestial-surface';

export class RenderPipeline {
  private readonly _gbuffer: GBufferPass;
  private readonly shadowPass: ShadowPass;
  private readonly _bodyShadow: BodyShadow;
  private readonly _ringShadow: RingShadow;
  private readonly _cumulusShadow: CloudShadowRenderer;
  private readonly meshShadow: MeshShadow;
  private readonly shadowMaps: ShadowMaps;
  private readonly screenSpacePass: ScreenSpacePass;
  // 遮蔽と照り返しのパスが書く符号付き拡散照度補正。補正光源とデバッグ表示が読む。
  private readonly _diffuseCorrection: DiffuseCorrection;
  private readonly lightPrepass: LightPrepass;
  // 球光源の鏡面が引く係数表。太陽と天体照で 1 つを共有する。
  private readonly sphereSpecular: SphereSpecular;
  // 光源モデルの設定を受けるため、光源の列とは別に太陽光源だけ手元にも持つ。
  private readonly sunSource: SunSource;
  private readonly _planetLight: PlanetLightSource;
  private readonly _ambient: AmbientSource;
  private readonly correctionSource: DiffuseCorrectionSource;
  private readonly materialPass: MaterialPass;
  private readonly atmospherePass: AtmospherePass;
  private readonly overlayPass: OverlayPass;
  private readonly antialiasPass: AntialiasPass;
  private readonly lensPass: LensPass;
  private readonly _sunLight: SunLight;
  private readonly _exposure: Exposure;
  private readonly target: THREE.RenderTarget;
  // composite パスと 3D UI パスの描画先。トーンマッピングと表示用色空間への変換を終えた絵が入る。
  private readonly displayTarget: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  // 合成段の色へ当てるフィルムのルック。通常表示の2枚(compositeMaterial と lensCompositeMaterial)が組み込む。
  private readonly filmLut = new FilmLut();
  private readonly visualEffectLut = new VisualEffectLut();
  // 通常表示と、レンズ効果を掛けた通常表示。後者はデバッグ表示の選択肢ではなく、描画品質設定でオン/オフする
  // 通常表示の別版である。
  private readonly compositeMaterial: THREE.MeshBasicNodeMaterial;
  private readonly lensCompositeMaterial: THREE.MeshBasicNodeMaterial;
  private lensEnabled: boolean;
  private readonly debugComposites: DebugComposites;
  private readonly schematicComposite: SchematicComposite;
  private readonly schematicMaterial: THREE.MeshBasicNodeMaterial;
  // 合成パスの表示が深度から位置を戻す、実カメラの逆射影行列。合成パスは QuadMesh 自前の固定直交カメラで描かれる
  // ため、TSL の組み込みノードはここでは実カメラの値を返さない — 毎フレーム書き込む。
  private readonly cameraProjectionInverse: Mat4Uniform = uniform(new THREE.Matrix4());
  // getDrawingBufferSize の書き込み先。フレームごとに確保しない使い回し領域。
  private readonly drawingBufferSize = new THREE.Vector2();
  // 天体照の写しの基準点(カメラの描画座標)の書き込み先。同じく使い回し領域。
  private readonly cameraPosition = new THREE.Vector3();
  private readonly unregisterProteinMotionRenderer: () => void;

  // 通常表示に代えて画面いっぱいに映す中間ターゲットの選択。
  private debugTarget: DebugTargetId = 'off';

  // 以下は、毎フレームの値(恒星の位置・順応の基準点・影を落とすもの・光源になる天体・環境光の割合・
  // 大気を持つ天体)の書き込み先。
  public get sunLight(): SunLight { return this._sunLight; }
  public get exposure(): Exposure { return this._exposure; }
  public get bodyShadow(): BodyShadow { return this._bodyShadow; }
  public get ringShadow(): RingShadow { return this._ringShadow; }
  public get cumulusShadow(): CloudShadowRenderer { return this._cumulusShadow; }
  public get planetLight(): PlanetLightSource { return this._planetLight; }
  public get ambient(): AmbientSource { return this._ambient; }
  public get atmosphere(): AtmospherePass { return this.atmospherePass; }

  // 以下は、近傍拡散補正の段と seed の書き込み先と、読み戻せる中間ターゲットの持ち主。
  public get screenSpace(): ScreenSpacePass { return this.screenSpacePass; }
  public get diffuseCorrection(): DiffuseCorrection { return this._diffuseCorrection; }
  public get lighting(): LightPrepass { return this.lightPrepass; }
  public get gbuffer(): GBufferPass { return this._gbuffer; }
  // 直前のフレームの、合成が読む HDR の絵(線形、半精度)。
  public get hdrTexture(): THREE.Texture { return this.target.texture; }

  // graphics は構築時点の描画品質設定。以後の変更は rebuildForGraphics() で受ける。
  public constructor(
    private readonly renderer: WebGPURenderer, graphics: GraphicsSettingsData, private readonly gpu: GpuTimings,
  ) {
    this.unregisterProteinMotionRenderer = registerProteinMotionRenderer(renderer);
    this._gbuffer = new GBufferPass(renderer, gpu);
    this._sunLight = new SunLight();
    this._exposure = new Exposure();
    this.shadowMaps = new ShadowMaps(
      renderer, gpu, graphics.meshShadow,
      graphics.shadowSlotCount, graphics.shadowSlotSize, graphics.shadowTexelsPerPixel,
    );
    this._bodyShadow = new BodyShadow(this._sunLight);
    this._ringShadow = new RingShadow(this._sunLight);
    this._cumulusShadow = new CloudShadowRenderer(this._sunLight);
    this.meshShadow = new MeshShadow(this._sunLight, this.shadowMaps);
    this.shadowPass = new ShadowPass(
      renderer, this._gbuffer,
      this._bodyShadow, this._ringShadow, this._cumulusShadow, this.meshShadow, gpu,
    );
    this.sphereSpecular = new SphereSpecular();
    this.sunSource = new SunSource(
      this._sunLight, this.shadowPass, this.sphereSpecular, graphics.sunLightModel);
    this._planetLight = new PlanetLightSource(
      this._sunLight, this._bodyShadow, this.sphereSpecular,
      graphics.planetLightCount, graphics.planetLightModel,
    );
    this._ambient = new AmbientSource(this._sunLight);
    this._diffuseCorrection = new DiffuseCorrection();
    this.screenSpacePass = new ScreenSpacePass(
      renderer, this._gbuffer, this.sunSource, this._planetLight, this._ambient, this._diffuseCorrection, gpu,
      graphics.screenSpaceDiffuse, graphics.screenSpaceQuality,
    );
    this.correctionSource = new DiffuseCorrectionSource(this._diffuseCorrection);
    this.lightPrepass = new LightPrepass(renderer, this._gbuffer, [
      this.sunSource, ...this._planetLight.lightSources, this._ambient, this.correctionSource,
    ], gpu);
    this.materialPass = new MaterialPass(renderer, this.lightPrepass, this._gbuffer, gpu);

    // マテリアルパス以降が共有する描画先。**大気パスの生成より先に作る** — 大気パスは自身が
    // 読み書きする先としてこれを受け取る。
    this.target = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
    });
    // 深度を 32bit 浮動小数点にするには明示が要る — 省くと depth24plus のまま精度だけ落ちる。
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);

    this.atmospherePass = new AtmospherePass(
      renderer, this._gbuffer, this.target, this._sunLight, this._bodyShadow, gpu,
    );
    this.overlayPass = new OverlayPass(renderer, gpu, this._gbuffer.depthTexture);

    // 表示用の絵は 8bit で足りる。**素の RGBA8 で受ける** — `-srgb` のフォーマットにすると、
    // 表示用色空間への変換が二重に掛かって画面全体が白く浮く。深度を持たせるのは、composite
    // パスが写した G バッファ深度に対して 3D UI パスが深度テストするため。
    this.displayTarget = new THREE.RenderTarget(1, 1, {
      format: THREE.RGBAFormat,
      type: THREE.UnsignedByteType,
      depthBuffer: true,
    });
    this.antialiasPass = new AntialiasPass(renderer, this.displayTarget.texture, gpu, graphics.antialias);

    this.lensPass = new LensPass(renderer, this.target.texture, gpu);
    this.lensEnabled = graphics.lens;

    this.compositeMaterial = compositeMaterial(
      this.displayColorOf(texture(this.target.texture, screenUV).rgb), this._gbuffer.depthTexture,
    );
    this.lensCompositeMaterial = compositeMaterial(
      this.displayColorOf(this.lensPass.blendedWith(texture(this.target.texture, screenUV).rgb)),
      this._gbuffer.depthTexture,
    );
    this.debugComposites = new DebugComposites(
      this._gbuffer, this._exposure, this.cameraProjectionInverse, this.shadowMaps, this.meshShadow, this.shadowPass,
      this.lightPrepass, this.screenSpacePass, this._diffuseCorrection, this._planetLight, this.atmospherePass,
      this.lensPass,
    );
    // 模式図用の合成マテリアル。表示スタイルの切り替えなので、デバッグ表示の選択肢とは別に持つ。
    this.schematicComposite = new SchematicComposite(this._gbuffer, this.cameraProjectionInverse);
    this.schematicMaterial = compositeMaterial(this.schematicComposite.colorNode, this._gbuffer.depthTexture);

    this.quad = new QuadMesh(this.compositeMaterial);
    this.syncTargetSize();
    // 構築で渡さなかった値も含めて、構築時点の設定をすべてのパスへ配る。
    this.rebuildForGraphics(graphics);
  }

  // 通常表示の合成の色: HDR の色 hdr へ露出・トーンマップ・フィルムのルック・視覚効果の LUT を掛けたもの。
  private displayColorOf(hdr: Vec3Node): Vec4Node {
    return vec4(this.visualEffectLut.apply(this.filmLut.apply(this._exposure.toneMapped(hdr))), 1);
  }

  // フレームの外で作った HDR の絵 hdr(複数フレームの HDR の平均など。線形で、描画バッファと同じ寸法)を、直前の
  // render と同じ通常表示の合成で target へ描く。露出・色の LUT の状態と写す深度は直前の render のものなので、同じ
  // 場面を render した直後に呼ぶ。target は hdr と同じ寸法で深度を持ち、値は表示用の色空間へ変換済みになる。
  public renderComposite(hdr: THREE.Texture, target: THREE.RenderTarget): void {
    const material = compositeMaterial(this.displayColorOf(texture(hdr, screenUV).rgb), this._gbuffer.depthTexture);
    const outputTarget = this.renderer.getOutputRenderTarget();
    this.renderer.setOutputRenderTarget(target);
    this.renderer.setRenderTarget(null);
    new QuadMesh(material).render(this.renderer);
    this.renderer.setOutputRenderTarget(outputTarget);
    material.dispose();
  }

  public renderSignedCorrectionComposite(hdr: THREE.Texture, target: THREE.RenderTarget): void {
    const material = this.debugComposites.signedCorrectionMaterial(hdr);
    const outputTarget = this.renderer.getOutputRenderTarget();
    try {
      this.renderer.setOutputRenderTarget(target);
      this.renderer.setRenderTarget(null);
      new QuadMesh(material).render(this.renderer);
    } finally {
      this.renderer.setOutputRenderTarget(outputTarget);
      material.dispose();
    }
  }

  // 共有ターゲットと表示用ターゲットを描画バッファの寸法へ合わせ、その寸法を返す。
  private syncTargetSize(): THREE.Vector2 {
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    const { x: width, y: height } = this.drawingBufferSize;
    setCelestialSurfaceViewport(width, height);
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    if (this.displayTarget.width !== width || this.displayTarget.height !== height) {
      this.displayTarget.setSize(width, height);
    }
    return this.drawingBufferSize;
  }

  // 合成パスの表示が深度から位置と距離を引き直すための、実カメラの値を書き込む。
  private syncCompositeCamera(camera: THREE.Camera): void {
    this.cameraProjectionInverse.value.copy(camera.projectionMatrixInverse);
    this.debugComposites.syncCamera(camera);
  }

  // このフレームに画面いっぱいへ映す中間ターゲット。'off' なら通常表示。
  public syncDebugTarget(target: DebugTargetId): void {
    this.debugTarget = target;
  }

  // 描画品質設定を各パスへ配る。影マップなどの GPU 資源は、値が変わったものだけを組み直す。
  public rebuildForGraphics(graphics: GraphicsSettingsData): void {
    // 描く段と影マップの品質。
    this.lensEnabled = graphics.lens;
    this.screenSpacePass.setMode(graphics.screenSpaceDiffuse);
    this.screenSpacePass.setQuality(graphics.screenSpaceQuality);
    this.correctionSource.setEnabled(graphics.screenSpaceDiffuse !== SCREEN_SPACE_DIFFUSE.off);
    this.shadowMaps.setQuality(
      graphics.meshShadow,
      graphics.shadowSlotCount, graphics.shadowSlotSize, graphics.shadowTexelsPerPixel,
    );
    // 露出と光源、仕上げの見た目。
    this._exposure.setCompensation(graphics.exposureCompensation);
    this.sunSource.setModel(graphics.sunLightModel);
    this._planetLight.setCount(graphics.planetLightCount);
    this._planetLight.setModel(graphics.planetLightModel);
    this.antialiasPass.setMethod(graphics.antialias);
    this.atmospherePass.setCloudShellEnabled('cirrus', graphics.cirrus);
    this.atmospherePass.setCloudShellEnabled('cumulus', graphics.translucentCumulus);
    // 天体照の写しは、その天体の描画設定で見えている雲と大気を写す。
    this._planetLight.setAtmosphereEnabled(graphics.atmosphere !== ATMOSPHERE_QUALITY.off);
    this._planetLight.setCumulusEnabled(graphics.cumulusDetail !== CUMULUS_DETAIL.off);
    this._planetLight.setCloudShellEnabled('cirrus', graphics.cirrus);
    this._planetLight.setCloudShellEnabled('cumulus', graphics.translucentCumulus);
    this.filmLut.select(graphics.filmLut);
  }

  // 初回描画で使うパイプラインをパス単位で構築し、完了数を通知する。
  public async compile(
    scene: THREE.Scene,
    camera: THREE.Camera,
    style: RenderStyle,
    onPass: (name: string, done: number, total: number) => void,
  ): Promise<void> {
    const { x: width, y: height } = this.syncTargetSize();

    this.syncCompositeCamera(camera);

    // 描画順に並べる。スタイルによらず通る段。
    const passes: [string, () => Promise<void>][] = [
      ['影マップ', () => this.shadowMaps.compile(scene, camera, height, this._sunLight)],
      ['G バッファ', () => this._gbuffer.compile(scene, camera, width, height)],
      ['影', () => this.shadowPass.compile(camera, width, height)],
      ['遮蔽と照り返し', () => this.screenSpacePass.compile(camera, width, height)],
      ['照明', () => this.lightPrepass.compile(camera, width, height)],
    ];

    // 合成板は描画時と同じものを載せてから組む。模式図は物理量の段を通らない。
    if (style === 'schematic') {
      this.schematicComposite.update(width, height);
      this.quad.material = this.schematicMaterial;
    } else {
      this.quad.material = this.lensEnabled ? this.lensCompositeMaterial : this.compositeMaterial;
      passes.push(
        ['マテリアル', () => this.materialPass.compile(scene, camera, this.target)],
        ['大気', () => this.atmospherePass.compile(camera)],
        ['ワールド', () => compileInto(this.renderer, this.target, scene, camera)],
      );
      if (this.lensEnabled) passes.push(['レンズ', () => this.lensPass.compile(width, height)]);
    }

    passes.push(
      ['合成', () => compileIntoOutput(this.renderer, this.displayTarget, this.quad, this.quad.camera)],
      ['オーバーレイ', () => this.overlayPass.compile(scene, camera, style, this.displayTarget)],
      ['アンチエイリアス', () => this.antialiasPass.compile()],
    );

    // 段の切れ目でブラウザへ制御を返す。テクスチャの GPU 投入もここへ 1 フレーム 1 枚ずつ挟む。
    for (const [index, [name, compile]] of passes.entries()) {
      onPass(name, index, passes.length);
      await DeferredTexture.publishOneNextFrame(this.renderer);
      await compile();
    }
    onPass('完了', passes.length, passes.length);
  }

  // 1 フレームぶんの描画を、影マップ → G バッファ → 影 → 遮蔽と照り返し → ライティング → マテリアル →
  // 大気 → world → レンズ → 合成 → 3D UI → アンチエイリアスの順に発行する。模式図スタイルでは
  // マテリアル・大気・world・レンズの4つのパスをスキップする。デバッグ表示を選んでいてもパスは省略しない —
  // 設定で切られているパス(影マップ・遮蔽と照り返し・レンズ)を選べば、そのフレームが何も作っていないことがそのまま
  // 空として見える。例外はスナップショットのブリットで、「マテリアル」表示の間は大気の写らない
  // フレームでも撮る。
  public render(scene: THREE.Scene, camera: THREE.Camera, style: RenderStyle): void {
    DeferredTexture.publishOne(this.renderer);
    const { x: width, y: height } = this.syncTargetSize();

    // 物理環境光の有効状態を、そのフレームの通常合成だけへ伝える。模式図と3D UIは別経路。
    this.visualEffectLut.setEnabled(this._ambient.hasContribution());

    // 影マップパスと本体パスが同じフレームの残基配置を読むよう、両方より前に一度だけ合成する。
    flushProteinMotionComputes(this.renderer);

    // 太陽光の影マップパス。G バッファを必要としないので、その前に置く。
    this.shadowMaps.render(scene, camera, height, this._sunLight);

    // G バッファパス。
    this._gbuffer.render(scene, camera, width, height);

    // 影パス。G バッファの深度を読む。
    this.shadowPass.render(camera, width, height);

    // 天体照の写し。近傍の照り返し源とライティングパスが同じフレームの値を読む。
    this._planetLight.bake(this.renderer, camera.getWorldPosition(this.cameraPosition), this.gpu);

    // 遮蔽と照り返しのパス。G バッファと影の透過率を読む。
    this.screenSpacePass.render(camera, width, height);

    // ライティングパス。G バッファと影の透過率を読む。
    this.lightPrepass.render(camera, width, height);

    // 模式図は G バッファの深度・法線だけから輪郭を出すため、マテリアルパス・大気パス・world
    // パスを経ない — 星野・大気・環・点群・ビルボードはこの3つのパスが描くものなので、画面から消える。
    if (style === 'schematic') {
      this.schematicComposite.update(width, height);
      this.quad.material = this.schematicMaterial;
    } else {
      // マテリアルパス。背景専用レイヤーと陰影を this.target(このあとの world パスと共有 —
      // 最初の書き込みなのでクリアする)へ描く。
      this.materialPass.render(scene, camera, this.target);

      // 大気パス。デバッグ表示が選ばれている間は、そこへ映す1枚も大気パスに描かせる
      // (「マテリアル」は重ねる前の下地なので、大気を描く前に控える)。
      if (this.debugTarget === 'material') this.atmospherePass.inspectBackdrop();
      this.atmospherePass.render(camera);
      if (this.debugTarget === 'atmosphere') this.atmospherePass.inspectScattered(camera);

      // world パス。LIT_OPAQUE_LAYER・雲殻の層・背景専用レイヤーはチャンネル0から外れているので、既定の
      // カメラマスクで描く限り重複しない。autoClear を落としてマテリアルパスの描画(色・深度とも)
      // を残したまま重ね描きする — world パスは透明物(オービットライン・プルーム・ビルボード)を
      // 描画順の最後に描くため、不透明な自艦の深度が先に無いと、自艦の手前の透明物が上書きされる。
      this.renderer.setRenderTarget(this.target);
      this.renderer.autoClear = false;
      this.gpu.beginPass(GPU_PASS.world);
      this.renderer.render(scene, camera);
      this.renderer.autoClear = true;
      this.renderer.setRenderTarget(null);

      // レンズ効果パス。world パスまでの絵を読む。設定で切られているフレームは出力を空にする
      // — 「レンズ」デバッグ表示に、そのフレームが実際に何も作っていないことがそのまま出る。
      if (this.lensEnabled) this.lensPass.render(width, height);
      else this.lensPass.clear(width, height);

      if (this.debugTarget !== 'off') this.quad.material = this.debugComposites.material(this.debugTarget);
      else this.quad.material = this.lensEnabled ? this.lensCompositeMaterial : this.compositeMaterial;
    }

    // composite パス。
    this.syncCompositeCamera(camera);
    // 出力先を差し替えると、描画先を指定しない2つのパスが表示用ターゲットへ向く。撮影のために
    // 呼び出し側が張った出力先を潰さないよう、退避してから戻す。
    const outputTarget = this.renderer.getOutputRenderTarget();
    this.renderer.setOutputRenderTarget(this.displayTarget);
    this.gpu.beginPass(GPU_PASS.composite);
    this.quad.render(this.renderer);

    // 3D UI パス。合成パスが複製した深度に対して深度テストしながら重ね描きする。
    this.overlayPass.render(scene, camera, style);
    this.renderer.setOutputRenderTarget(outputTarget);

    // アンチエイリアスパス。表示用ターゲットの絵を読む。
    this.antialiasPass.render();
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    this.unregisterProteinMotionRenderer();
    this._gbuffer.dispose();
    this.shadowPass.dispose();
    this.shadowMaps.dispose();
    this.screenSpacePass.dispose();
    this._diffuseCorrection.dispose();
    this.lightPrepass.dispose();
    this.sphereSpecular.dispose();
    this.materialPass.dispose();
    this.atmospherePass.dispose();
    this.overlayPass.dispose();
    this.antialiasPass.dispose();
    this.lensPass.dispose();
    this.lensCompositeMaterial.dispose();
    this.target.dispose();
    this.displayTarget.dispose();
    this.compositeMaterial.dispose();
    this.debugComposites.dispose();
    this.schematicMaterial.dispose();
    this.filmLut.dispose();
  }
}
