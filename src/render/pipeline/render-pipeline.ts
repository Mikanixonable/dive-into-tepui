// フレーム全体のレンダリングパイプライン構成 — 各パスの実行順序、描画先レンダーターゲット、合成フロー — を管理する。
// composite パスは通常表示では HDR ターゲットをトーンマッピングして合成し、デバッグ表示を
// 選ぶと中間ターゲットの中身を画面いっぱいに映す。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { screenUV, texture, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { ATMOSPHERE_QUALITY } from '../atmosphere';
import type { GraphicsSettingsData } from '../graphics-settings';
import type { RenderStyle } from '../render-style';
import type { DebugTargetId } from './debug-target';
import { buildCompositeMaterial, filmLooked, toneMapped } from './composite';
import { DebugComposites } from './debug-composites';
import { GBufferPass } from './gbuffer';
import { AtmospherePass } from './atmosphere-pass';
import { LightPrepass } from './light-prepass';
import { AmbientSource } from './lighting/ambient-source';
import { PlanetLightSource } from './lighting/planet-light-source';
import { SkyLightSource } from './lighting/sky-source';
import { SphereSpecular } from './lighting/sphere-light';
import { SunSource } from './lighting/sun-source';
import { SunExtinction } from './sun-extinction';
import { SunTransmittanceTables } from './sun-transmittance-tables';
import { SkyIrradianceTables } from './sky-irradiance-tables';
import { WorkLightSource } from './lighting/work-light-source';
import { MaterialPass } from './material-pass';
import { ShadowPass } from './shadow/shadow-pass';
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
import { FilmLut } from './film-lut';
import { compileInto, compileIntoOutput } from './compile-into';
import { DeferredTexture } from '../deferred-texture';
import { setCelestialSurfaceViewport } from '../celestial/celestial-surface';

export class RenderPipeline {
  private readonly gbuffer: GBufferPass;
  private readonly shadowPass: ShadowPass;
  private readonly _bodyShadow: BodyShadow;
  private readonly _ringShadow: RingShadow;
  private readonly _cloudShadow: CloudShadowRenderer;
  private readonly meshShadow: MeshShadow;
  private readonly shadowMaps: ShadowMaps;
  private readonly lightPrepass: LightPrepass;
  // 球光源の鏡面が引く係数表。太陽と天体照で 1 つを共有する。
  private readonly sphereSpecular: SphereSpecular;
  // 光源モデルの設定を受けるため、光源の列とは別に太陽光源だけ手元にも持つ。
  private readonly sunSource: SunSource;
  private readonly _planetLight: PlanetLightSource;
  private readonly _ambient: AmbientSource;
  private readonly _workLight: WorkLightSource;
  private readonly materialPass: MaterialPass;
  private readonly atmospherePass: AtmospherePass;
  private readonly overlayPass: OverlayPass;
  private readonly antialiasPass: AntialiasPass;
  private readonly lensPass: LensPass;
  private readonly _sunLight: SunLight;
  private readonly _sunExtinction: SunExtinction;
  private readonly _skyLight: SkyLightSource;
  // 天体の光学から焼く表の持ち主。直射光の透過率は地表・雲・艦と大気の散乱が、
  // 天空光の放射照度は天空光源が読む。
  private readonly sunTransmittanceTables = new SunTransmittanceTables();
  private readonly skyIrradianceTables = new SkyIrradianceTables(this.sunTransmittanceTables);
  private readonly _exposure: Exposure;
  private readonly target: THREE.RenderTarget;
  // composite パスと 3D UI パスの描画先。トーンマッピングと表示用色空間への変換を終えた絵が入る。
  private readonly displayTarget: THREE.RenderTarget;
  private readonly quad: QuadMesh;
  // 合成段の色へ適用するフィルム風ルック（LUT）。通常表示の2枚(offCompositeMaterial と
  // lensCompositeMaterial)が組み込む。
  private readonly filmLut = new FilmLut();
  // デバッグ表示の選択肢ごとの合成マテリアル一式と、それが使うカメラ由来の uniform。
  private readonly debugComposites: DebugComposites;
  // デバッグ表示を選んでいないときの通常表示。
  private readonly offCompositeMaterial: THREE.MeshBasicNodeMaterial;
  // レンズ効果を掛けた通常表示。**offCompositeMaterial とは別に持つ** — デバッグ表示の選択肢
  // (DebugTargetId)ではなく、描画品質設定でオン/オフする 'off' の別版だからである。
  private readonly lensCompositeMaterial: THREE.MeshBasicNodeMaterial;
  private lensEnabled: boolean;
  private readonly schematicComposite: SchematicComposite;
  private readonly schematicMaterial: THREE.MeshBasicNodeMaterial;
  // getDrawingBufferSize の書き込み先。フレームごとに確保しない使い回し領域。
  private readonly drawingBufferSize = new THREE.Vector2();
  // 天体照の写しの基準点(カメラの描画座標)の書き込み先。同じく使い回し領域。
  private readonly cameraPosition = new THREE.Vector3();

  // 以下は、毎フレームの値(恒星の位置・順応の基準点・影を落とすもの・光源になる天体・環境光の割合・
  // 大気を持つ天体)の書き込み先。
  public get sunLight(): SunLight { return this._sunLight; }
  public get sunExtinction(): SunExtinction { return this._sunExtinction; }
  public get skyLight(): SkyLightSource { return this._skyLight; }
  public get exposure(): Exposure { return this._exposure; }
  public get bodyShadow(): BodyShadow { return this._bodyShadow; }
  public get ringShadow(): RingShadow { return this._ringShadow; }
  public get cloudShadow(): CloudShadowRenderer { return this._cloudShadow; }
  public get planetLight(): PlanetLightSource { return this._planetLight; }
  public get ambient(): AmbientSource { return this._ambient; }
  public get workLight(): WorkLightSource { return this._workLight; }
  public get atmosphere(): AtmospherePass { return this.atmospherePass; }

  // graphics は構築時点の描画品質設定。以後の変更は rebuildForGraphics() で受ける。
  public constructor(
    private readonly renderer: WebGPURenderer, graphics: GraphicsSettingsData, private readonly gpu: GpuTimings,
  ) {
    this.gbuffer = new GBufferPass(renderer, gpu);
    this._sunLight = new SunLight();
    this._sunExtinction = new SunExtinction(this._sunLight, this.sunTransmittanceTables);
    this._skyLight = new SkyLightSource(this._sunLight, this.skyIrradianceTables);
    this._exposure = new Exposure();
    this.shadowMaps = new ShadowMaps(
      renderer, gpu, graphics.meshShadow,
      graphics.shadowSlotCount, graphics.shadowSlotSize, graphics.shadowTexelsPerPixel,
    );
    this._bodyShadow = new BodyShadow(this._sunLight);
    this._ringShadow = new RingShadow(this._sunLight);
    this._cloudShadow = new CloudShadowRenderer(this._sunLight);
    this.meshShadow = new MeshShadow(this._sunLight, this.shadowMaps);
    this.shadowPass = new ShadowPass(
      renderer, this.gbuffer,
      this._bodyShadow, this._ringShadow, this._cloudShadow, this.meshShadow, gpu,
    );
    this.sphereSpecular = new SphereSpecular();
    this.sunSource = new SunSource(
      this._sunLight, this.shadowPass, this.sphereSpecular, this._sunExtinction, graphics.sunLightModel);
    this._planetLight = new PlanetLightSource(
      this._sunLight, this._bodyShadow, this.sphereSpecular, graphics.planetLightCount,
      graphics.planetLightModel, this.sunTransmittanceTables);
    this._ambient = new AmbientSource(this._sunLight);
    this._workLight = new WorkLightSource(this.sphereSpecular);
    this.lightPrepass = new LightPrepass(renderer, this.gbuffer, [
      this.sunSource, ...this._planetLight.lightSources, this._skyLight, this._ambient, this._workLight,
    ], gpu);
    this.materialPass = new MaterialPass(renderer, this.lightPrepass, this.gbuffer, gpu);

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
      renderer, this.gbuffer, this.target, this._sunLight, this._bodyShadow,
      this._cloudShadow, this.sunTransmittanceTables, gpu,
    );
    this.overlayPass = new OverlayPass(renderer, gpu, this.gbuffer.depthTexture);

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

    this.debugComposites = new DebugComposites({
      gbuffer: this.gbuffer,
      atmosphere: this.atmospherePass,
      shadow: this.shadowPass,
      shadowMaps: this.shadowMaps,
      meshShadow: this.meshShadow,
      lightPrepass: this.lightPrepass,
      lens: this.lensPass,
      planetLight: this._planetLight,
      exposure: this._exposure,
    });
    this.offCompositeMaterial = buildCompositeMaterial(
      this.gbuffer,
      vec4(filmLooked(toneMapped(texture(this.target.texture, screenUV).rgb, this._exposure), this.filmLut), 1),
    );
    this.lensCompositeMaterial = buildCompositeMaterial(
      this.gbuffer,
      vec4(
        filmLooked(
          toneMapped(this.lensPass.blendedWith(texture(this.target.texture, screenUV).rgb), this._exposure),
          this.filmLut,
        ),
        1,
      ),
    );
    // 模式図用の合成マテリアル。表示スタイルの切り替えなので、デバッグ表示の選択肢とは別に持つ。
    this.schematicComposite = new SchematicComposite(this.gbuffer, this.debugComposites.depthProjInv);
    this.schematicMaterial = buildCompositeMaterial(this.gbuffer, this.schematicComposite.colorNode);

    this.quad = new QuadMesh(this.offCompositeMaterial);
    this.syncTargetSize();
    // 構築で渡さなかった値も含めて、構築時点の設定をすべてのパスへ配る。
    this.rebuildForGraphics(graphics);
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

  // このフレームに画面いっぱいへ映す中間ターゲット。'off' なら通常表示。
  public syncDebugTarget(target: DebugTargetId): void {
    this.debugComposites.setTarget(target);
  }

  // 描画品質設定を各パスへ配る。影マップなどの GPU 資源は、値が変わったものだけを組み直す。
  public rebuildForGraphics(graphics: GraphicsSettingsData): void {
    // 天体と星野の画像の段。読み手のテクスチャ実体はそのままで、画像だけが段に応じて差し替わる。
    DeferredTexture.setResolution(graphics.textureResolution);
    // 描く段と影マップの品質。
    this.lensEnabled = graphics.lens;
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
    this.atmospherePass.setCirrusDetail(graphics.cirrusDetail);
    // 天体照の写しは、その天体の描画設定で見えている雲と大気を写す。
    this._planetLight.setAtmosphereEnabled(graphics.atmosphere !== ATMOSPHERE_QUALITY.off);
    this._planetLight.setCumulusEnabled(graphics.cumulus);
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

    this.debugComposites.writeCamera(camera);

    // 描画順に並べる。スタイルによらず通る段。
    const passes: [string, () => Promise<void>][] = [
      ['影マップ', () => this.shadowMaps.compile(scene, camera, height, this._sunLight)],
      ['G バッファ', () => this.gbuffer.compile(scene, camera, width, height)],
      ['影', () => this.shadowPass.compile(camera, width, height)],
      ['照明', () => this.lightPrepass.compile(camera, width, height)],
    ];

    // 合成板は描画時と同じものを載せてから組む。模式図は物理量の段を通らない。
    if (style === 'schematic') {
      this.schematicComposite.update(width, height);
      this.quad.material = this.schematicMaterial;
    } else {
      this.quad.material = this.lensEnabled ? this.lensCompositeMaterial : this.offCompositeMaterial;
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

  // 雲殻の層だけを G バッファの添付形式でコンパイルする。雲の精細さの段のマテリアルを
  // 事前に組むのに使う — 呼ぶ側でその段のマテリアルをメッシュへ張り替えておく。
  public async compileCloudShell(scene: THREE.Scene, camera: THREE.Camera): Promise<void> {
    await this.gbuffer.compileCloudShellLayer(scene, camera);
  }

  // 1 フレームぶんの描画を、影マップ → G バッファ → 影 → ライティング → マテリアル → 大気 →
  // world → レンズ → 合成 → 3D UI → アンチエイリアスの順に発行する。模式図スタイルでは
  // マテリアル・大気・world・レンズの4つのパスをスキップする。デバッグ表示を選んでいてもパスは省略しない —
  // 設定で切られているパス(影マップ・レンズ)を選べば、そのフレームが何も作っていないことがそのまま
  // 空として見える。例外はスナップショットのブリットで、「マテリアル」表示の間は大気の写らない
  // フレームでも撮る。
  public render(scene: THREE.Scene, camera: THREE.Camera, style: RenderStyle): void {
    // シーンのワールド行列はフレームの頭で 1 度だけ確定させ、全パスで共有する。パスの途中で
    // シーンの物体を動かすと、その変化は次のフレームまで描かれない。
    scene.updateMatrixWorld();
    const autoUpdate = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    try {
      this.renderPasses(scene, camera, style);
    } finally {
      scene.matrixWorldAutoUpdate = autoUpdate;
    }
  }

  // render の本体。パスを順に発行する。
  private renderPasses(scene: THREE.Scene, camera: THREE.Camera, style: RenderStyle): void {
    DeferredTexture.publishOne(this.renderer);
    const { x: width, y: height } = this.syncTargetSize();

    // 太陽光の影マップパス。G バッファを必要としないので、その前に置く。
    this.shadowMaps.render(scene, camera, height, this._sunLight);

    // G バッファパス。
    this.gbuffer.render(scene, camera, width, height);

    // 影パス。G バッファの深度を読む。
    this.shadowPass.render(camera, width, height);

    // 天体照の写し。基準点はカメラの位置で、ライティングパスより前に焼く。
    this._planetLight.bake(this.renderer, camera.getWorldPosition(this.cameraPosition), this.gpu);

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
      if (this.debugComposites.target === 'material') this.atmospherePass.inspectBackdrop();
      this.atmospherePass.render(camera);
      if (this.debugComposites.target === 'atmosphere') this.atmospherePass.inspectScattered(camera);

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

      const debugTarget = this.debugComposites.target;
      this.quad.material = debugTarget === 'off'
        ? (this.lensEnabled ? this.lensCompositeMaterial : this.offCompositeMaterial)
        : this.debugComposites.materialFor(debugTarget);
    }

    // composite パス。
    this.debugComposites.writeCamera(camera);
    // 出力先を差し替えると、描画先を指定しない2つのパスが表示用ターゲットへ向く。撮影用途などで
    // 事前に設定された出力先を上書きしてしまわないよう、一時退避してから復元する。
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
    this.gbuffer.dispose();
    this.shadowPass.dispose();
    this.shadowMaps.dispose();
    this.lightPrepass.dispose();
    this.sphereSpecular.dispose();
    this.materialPass.dispose();
    this.atmospherePass.dispose();
    this.overlayPass.dispose();
    this.antialiasPass.dispose();
    this.lensPass.dispose();
    this.lensCompositeMaterial.dispose();
    this.offCompositeMaterial.dispose();
    this.sunTransmittanceTables.dispose();
    this.skyIrradianceTables.dispose();
    this.target.dispose();
    this.displayTarget.dispose();
    this.debugComposites.dispose();
    this.schematicMaterial.dispose();
    this.filmLut.dispose();
  }
}
