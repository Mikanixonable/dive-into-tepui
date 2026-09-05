// フレームの描画パス構成を制御する。render/** 配下の個々の描画物モジュールとは別に、
// 「何段で、どのターゲットへ描き、どう合成してキャンバスへ出すか」をここへ集約する。段の並びは
// render() が持つ。composite パスは通常表示(debugTarget==='off')では HDR ターゲットを
// トーンマッピングして合成し、それ以外を選ぶと代わりに中間ターゲットの中身を画面いっぱいに映す
// (debug-target.ts)。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { float, int, log, max, neutralToneMapping, screenUV, select, texture, uniform, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import type { GraphicsSettingsData, GraphicsTarget } from '../graphics-settings';
import type { RenderStyle } from '../render-style';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec4Node } from '../tsl-types';
import type { DebugTargetHost, DebugTargetId } from './debug-target';
import { GBufferPass, octDecodeNormal } from './gbuffer';
import { AtmospherePass } from './atmosphere-pass';
import { LightPrepass } from './light-prepass';
import { AmbientSource } from './lighting/ambient-source';
import { PlanetLightSource } from './lighting/planet-light-source';
import { SphereSpecular } from './lighting/sphere-light';
import { SunSource } from './lighting/sun-source';
import { MaterialPass } from './material-pass';
import { ShadowPass } from './shadow/shadow-pass';
import { BodyShadow } from './shadow/body-shadow';
import { RingShadow } from './shadow/ring-shadow';
import { CumulusShadow } from './shadow/cumulus-shadow';
import { MeshShadow } from './shadow/mesh-shadow';
import { OverlayPass } from './overlay-pass';
import { AntialiasPass } from './antialias-pass';
import { SchematicComposite } from './schematic-composite';
import { LensPass } from './lens-pass';
import { Exposure } from './exposure';
import { SunLight } from './sun-light';
import { ShadowMaps } from './shadow/shadow-maps';
import { viewPositionAt } from './view-ray';
import { flushProteinMotionComputes, registerProteinMotionRenderer } from '../protein-motion-material';
import { FilmLut } from './film-lut';
import { compileInto, compileIntoOutput } from './compile-into';
import { DeferredTexture } from '../deferred-texture';

export class RenderPipeline implements DebugTargetHost, GraphicsTarget {
  private readonly gbuffer: GBufferPass;
  private readonly shadowPass: ShadowPass;
  private readonly _bodyShadow: BodyShadow;
  private readonly _ringShadow: RingShadow;
  private readonly _cumulusShadow: CumulusShadow;
  private readonly meshShadow: MeshShadow;
  private readonly shadowMaps: ShadowMaps;
  private readonly lightPrepass: LightPrepass;
  // 球光源の鏡面が引く係数表。太陽と天体照で 1 つを共有する。
  private readonly sphereSpecular: SphereSpecular;
  // 光源モデルの設定を受けるため、光源の列とは別に太陽光源だけ手元にも持つ。
  private readonly sunSource: SunSource;
  private readonly _planetLight: PlanetLightSource;
  private readonly _ambient: AmbientSource;
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
  // 合成段の色へ当てるフィルムのルック。通常表示の2枚(compositeMaterials.off と
  // lensCompositeMaterial)だけがこのノードを組み込む。
  private readonly filmLut = new FilmLut();
  private readonly compositeMaterials: Readonly<Record<DebugTargetId, THREE.MeshBasicNodeMaterial>>;
  // レンズ効果を掛けた通常表示。**compositeMaterials とは別に持つ** — デバッグ表示の選択肢
  // (DebugTargetId)ではなく、描画品質設定でオン/オフする 'off' の別版だからである。
  private readonly lensCompositeMaterial: THREE.MeshBasicNodeMaterial;
  private lensEnabled: boolean;
  private readonly schematicComposite: SchematicComposite;
  private readonly schematicMaterial: THREE.MeshBasicNodeMaterial;
  // 深度デバッグ表示が使う uniform。composite パスは QuadMesh 自前の固定直交カメラ
  // (near=0/far=1)で描かれるため、TSL の cameraNear/cameraFar/cameraProjectionMatrix
  // 組み込みノードはここでは実カメラの値を返さない — render() が毎フレーム実カメラの
  // near/far と逆射影行列を書き込む。
  private readonly depthDebugNear: FloatUniform;
  private readonly depthDebugFar: FloatUniform;
  private readonly depthDebugProjInv: Mat4Uniform;
  // 「影スロット」表示が、復元した view 空間の位置を描画座標へ戻すのに使う。
  private readonly debugViewToWorld: Mat4Uniform;
  // getDrawingBufferSize の書き込み先。フレームごとに確保しない使い回し領域。
  private readonly drawingBufferSize = new THREE.Vector2();
  private readonly unregisterProteinMotionRenderer: () => void;

  // 通常表示に代えて画面いっぱいに映す中間ターゲットの選択。ページ再読み込みでは必ず 'off'
  // に戻るセッション限定の状態で、永続化しない。
  public debugTarget: DebugTargetId = 'off';

  // 以下は、シーン側が毎フレームの値(恒星の位置・順応の基準点・影を落とすもの・光源になる天体・
  // 環境光の割合・大気を持つ天体)を書き込む先。
  public get sunLight(): SunLight { return this._sunLight; }
  public get exposure(): Exposure { return this._exposure; }
  public get bodyShadow(): BodyShadow { return this._bodyShadow; }
  public get ringShadow(): RingShadow { return this._ringShadow; }
  public get cumulusShadow(): CumulusShadow { return this._cumulusShadow; }
  public get planetLight(): PlanetLightSource { return this._planetLight; }
  public get ambient(): AmbientSource { return this._ambient; }
  public get atmosphere(): AtmospherePass { return this.atmospherePass; }

  // graphics は構築時点の描画品質設定。以後の変更は applyGraphics() で受ける。
  public constructor(
    private readonly renderer: WebGPURenderer, graphics: GraphicsSettingsData, private readonly gpu: GpuTimings,
  ) {
    this.unregisterProteinMotionRenderer = registerProteinMotionRenderer(renderer);
    this.gbuffer = new GBufferPass(renderer, gpu);
    this._sunLight = new SunLight();
    this._exposure = new Exposure();
    this.shadowMaps = new ShadowMaps(
      renderer, gpu, graphics.meshShadow,
      graphics.shadowSlotCount, graphics.shadowSlotSize, graphics.shadowTexelsPerPixel,
    );
    this._bodyShadow = new BodyShadow(this._sunLight);
    this._ringShadow = new RingShadow(this._sunLight);
    this._cumulusShadow = new CumulusShadow(this._sunLight);
    this.meshShadow = new MeshShadow(this._sunLight, this.shadowMaps);
    this.shadowPass = new ShadowPass(
      renderer, this.gbuffer,
      this._bodyShadow, this._ringShadow, this._cumulusShadow, this.meshShadow, gpu,
    );
    this.sphereSpecular = new SphereSpecular();
    this.sunSource = new SunSource(
      this._sunLight, this.shadowPass, this.sphereSpecular, graphics.sunLightModel);
    this._planetLight = new PlanetLightSource(
      this._sunLight, this.sphereSpecular, graphics.planetLightCount);
    this._ambient = new AmbientSource(this._sunLight);
    this.lightPrepass = new LightPrepass(renderer, this.gbuffer, [
      this.sunSource, ...this._planetLight.lightSources, this._ambient,
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
      renderer, this.gbuffer, this.target, this._sunLight, this._bodyShadow, gpu,
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

    this.depthDebugNear = uniform(1);
    this.depthDebugFar = uniform(2);
    this.depthDebugProjInv = uniform(new THREE.Matrix4());
    this.debugViewToWorld = uniform(new THREE.Matrix4());

    const inspectMaterial = this.buildCompositeMaterial(
      vec4(this.toneMapped(texture(this.atmospherePass.inspectTexture, screenUV).rgb), 1),
    );
    // 表示ごとに別マテリアルを持ち、quad.material の差し替えで切り替える。1 枚をユニフォームで
    // 分岐させると、通常プレイの毎フレームで G バッファの全テクスチャを bind/sample することになる。
    this.compositeMaterials = {
      off: this.buildCompositeMaterial(
        vec4(this.filmLut.apply(this.toneMapped(texture(this.target.texture, screenUV).rgb)), 1),
      ),
      normal: this.buildCompositeMaterial(
        vec4(octDecodeNormal(texture(this.gbuffer.normalTexture, screenUV).rg).mul(0.5).add(0.5), 1),
      ),
      roughness: this.buildCompositeMaterial(
        vec4(vec3(texture(this.gbuffer.roughnessTexture, screenUV).r), 1),
      ),
      basecolor: this.buildCompositeMaterial(
        vec4(texture(this.gbuffer.basecolorTexture, screenUV).rgb, 1),
      ),
      metalness: this.buildCompositeMaterial(vec4(vec3(this.metalnessDebugNode()), 1)),
      // 自己発光は 1 を超えうる HDR 値なので、照度と同じくトーンマッピングを通して出す。
      emissive: this.buildCompositeMaterial(
        vec4(this.toneMapped(texture(this.gbuffer.emissiveTexture, screenUV).rgb), 1),
      ),
      depth: this.buildCompositeMaterial(vec4(vec3(this.logDepthNode()), 1)),
      // 4 枚のスロットを 2x2 に並べて画面いっぱいへ映す。線形深度なのでそのまま濃淡として
      // 読め(遠いほど白)、使われていないスロットは真っ白のまま残る。
      'shadow-map': this.buildCompositeMaterial(vec4(vec3(this.shadowSlotGridNode()), 1)),
      'shadow-map-slot': this.buildCompositeMaterial(vec4(this.shadowSlotColorNode(), 1)),
      shadow: this.buildCompositeMaterial(
        vec4(vec3(texture(this.shadowPass.texture, screenUV).r), 1),
      ),
      // 照度・陰影は 1 を超え得る HDR 値なので、通常表示と同じトーンマッピングを通してから
      // 画面へ出す(1 天文単位の放射照度は π を超えるため、通さないと全面白になる)。
      diffuse: this.buildCompositeMaterial(
        vec4(this.toneMapped(texture(this.lightPrepass.diffuseTexture, screenUV).rgb), 1),
      ),
      specular: this.buildCompositeMaterial(
        vec4(this.toneMapped(texture(this.lightPrepass.specularTexture, screenUV).rgb), 1),
      ),
      // 「マテリアル」も「大気」も、大気パスが点検用に描く1枚を映すので、材質を共有する。
      material: inspectMaterial,
      atmosphere: inspectMaterial,
      lens: this.buildCompositeMaterial(vec4(this.toneMapped(this.lensPass.redistributedLight()), 1)),
    };
    this.lensCompositeMaterial = this.buildCompositeMaterial(
      vec4(
        this.filmLut.apply(this.toneMapped(this.lensPass.blendedWith(texture(this.target.texture, screenUV).rgb))),
        1,
      ),
    );
    // 模式図用の合成マテリアル。表示スタイルの切り替えなので、デバッグ表示の選択肢とは別に持つ。
    this.schematicComposite = new SchematicComposite(this.gbuffer, this.depthDebugProjInv);
    this.schematicMaterial = this.buildCompositeMaterial(this.schematicComposite.colorNode);

    this.quad = new QuadMesh(this.compositeMaterials.off);
  }

  // 1 を超える HDR 値を切り落とさず白へ寄せる。Khronos PBR Neutral を選ぶのは、圧縮開始点より
  // 下では色相・彩度を保ったまま素通しするため — 「表示値 = アルベド」という校正が中間調では
  // そのまま読み取れる。
  private toneMapped(color: Vec3Node): Vec3Node {
    return neutralToneMapping(color, this._exposure.factor) as Vec3Node;
  }

  // composite 用マテリアル。colorNode だけが表示ごとに異なる。深度は G バッファのものを描画先の
  // 深度バッファへ複製する(depthTest を切ったまま depthWrite を立てるので全画素が無条件に書かれる)
  // — 次段の 3D UI パスがこれに対して深度テストする。デバッグ表示中も同じく書く。
  private buildCompositeMaterial(colorNode: Vec4Node): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: true, transparent: false });
    material.colorNode = colorNode;
    material.depthNode = texture(this.gbuffer.depthTexture, screenUV).r;
    return material;
  }

  // G バッファのベース色の α に載っている金属度。物体の無い画素は 0。
  private metalnessDebugNode(): FloatNode {
    const metalness = texture(this.gbuffer.basecolorTexture, screenUV).a;
    return select(this.gbuffer.covered(), metalness, float(0));
  }

  // 影のスロット 4 枚を 2x2 のタイルとして 1 枚のノードへ畳む。
  private shadowSlotGridNode(): FloatNode {
    const tileUV = screenUV.mul(2).fract();
    const parameters = this.shadowMaps.uniformArrays.parameters;
    const left = screenUV.x.lessThan(0.5);
    // screenUV は上端が原点なので、y の小さいほうが画面の上段。
    const top = screenUV.y.lessThan(0.5);
    // 深度マップはメートルで持っているので、スロットごとの深度の幅(far − near)で割って濃淡へ直す。
    const tile = (layer: number): FloatNode => {
      const slot = parameters.element(layer);
      return texture(this.shadowMaps.texture, tileUV).depth(int(layer)).r
        .div(max(slot.y.sub(slot.x), 1e-6));
    };
    const topRow = select(left, tile(0), tile(1));
    const bottomRow = select(left, tile(2), tile(3));
    return select(top, topRow, bottomRow);
  }

  // G バッファ深度から復元した位置を覆う影スロットの色。どのスロットも覆っていなければ黒。
  private shadowSlotColorNode(): Vec3Node {
    const viewPos = viewPositionAt(this.gbuffer.depthTexture, this.depthDebugProjInv);
    const worldPos: Vec3Node = this.debugViewToWorld.mul(vec4(viewPos, 1)).xyz;
    return this.meshShadow.slotDebugColor(worldPos);
  }

  // 深度バッファの生値を near/far 間の対数スケール(0=near, 1=far)へ変換する。素の深度値は
  // near=2m/far=2e12m のスケールでは端に潰れて識別できないため、対数を挟むことで
  // 精度の落ち方そのものを見えるようにする。
  private logDepthNode(): FloatNode {
    // 深度の生値から距離への逆写像は投影方式ごとに違う(透視は 1/z、平行投影は線形)ので、
    // 生値ではなく復元位置の view 空間 z から測る — 逆射影行列がその違いを吸収する。
    const dist = viewPositionAt(this.gbuffer.depthTexture, this.depthDebugProjInv).z.negate();
    return log(dist.div(this.depthDebugNear)).div(log(this.depthDebugFar.div(this.depthDebugNear)));
  }

  // 共有ターゲットと表示用ターゲットを描画バッファの寸法へ合わせ、その寸法を返す。
  private syncTargetSize(): THREE.Vector2 {
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    const { x: width, y: height } = this.drawingBufferSize;
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
    if (this.displayTarget.width !== width || this.displayTarget.height !== height) {
      this.displayTarget.setSize(width, height);
    }
    return this.drawingBufferSize;
  }

  // 深度デバッグ表示が深度から距離を引き直すための、カメラ由来の値を書き込む。
  private writeDepthDebugCamera(camera: THREE.Camera): void {
    this.depthDebugProjInv.value.copy(camera.projectionMatrixInverse);
    this.debugViewToWorld.value.copy(camera.matrixWorld);
    if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
      this.depthDebugNear.value = camera.near;
      this.depthDebugFar.value = camera.far;
    }
  }

  // 描画品質設定のうち、GPU 資源の確保を伴うものを各パスへ配る。値が変わった時点で1回呼ばれる。
  public applyGraphics(graphics: GraphicsSettingsData): void {
    this.lensEnabled = graphics.lens;
    this.shadowMaps.setQuality(
      graphics.meshShadow,
      graphics.shadowSlotCount, graphics.shadowSlotSize, graphics.shadowTexelsPerPixel,
    );
    this._exposure.setCompensation(graphics.exposureCompensation);
    this.sunSource.setModel(graphics.sunLightModel);
    this._planetLight.setCount(graphics.planetLightCount);
    this.antialiasPass.setMethod(graphics.antialias);
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

    this.writeDepthDebugCamera(camera);

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
      this.quad.material = this.lensEnabled ? this.lensCompositeMaterial : this.compositeMaterials.off;
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

  // 1 フレームぶんの描画を、影マップ → G バッファ → 影 → ライティング → マテリアル → 大気 →
  // world → レンズ → 合成 → 3D UI → アンチエイリアスの順に発行する。模式図スタイルでは
  // マテリアル・大気・world・レンズの4段を飛ばす。デバッグ表示を選んでいてもパスは省略しない —
  // 設定で切られている段(影マップ・レンズ)を選べば、そのフレームが何も作っていないことがそのまま
  // 空として見える。例外はスナップショットのブリットで、「マテリアル」表示の間は大気の写らない
  // フレームでも撮る。
  public render(scene: THREE.Scene, camera: THREE.Camera, style: RenderStyle): void {
    DeferredTexture.publishOne(this.renderer);
    const { x: width, y: height } = this.syncTargetSize();

    // 影マップパスと本体パスが同じフレームの残基配置を読むよう、両方より前に一度だけ合成する。
    flushProteinMotionComputes(this.renderer);

    // 太陽光の影マップパス。G バッファを必要としないので、その前に置く。
    this.shadowMaps.render(scene, camera, height, this._sunLight);

    // G バッファパス。camera.layers の一時的な絞り込みと GPU 計測の申告は自身の中で行う。
    this.gbuffer.render(scene, camera, width, height);

    // 影パス。G バッファ深度だけを読むので scene は渡さない。
    this.shadowPass.render(camera, width, height);

    // ライティングパス。G バッファと影の透過率だけを読むので scene は渡さない。
    this.lightPrepass.render(camera, width, height);

    // 模式図は G バッファの深度・法線だけから輪郭を出すため、マテリアルパス・大気パス・world
    // パスを経ない — 星野・大気・環・点群・ビルボードはこの3段が描くものなので、画面から消える。
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

      // world パス。LIT_OPAQUE_LAYER と背景専用レイヤーはチャンネル0から外れているので、既定の
      // カメラマスクで描く限り重複しない。autoClear を落としてマテリアルパスの描画(色・深度とも)
      // を残したまま重ね描きする — world パスは透明物(オービットライン・プルーム・ビルボード)を
      // 描画順の最後に描くため、不透明な自艦の深度が先に無いと、自艦の手前の透明物が上書きされる。
      this.renderer.setRenderTarget(this.target);
      this.renderer.autoClear = false;
      this.gpu.beginPass(GPU_PASS.world);
      this.renderer.render(scene, camera);
      this.renderer.autoClear = true;
      this.renderer.setRenderTarget(null);

      // レンズ効果パス。world パスまでの絵だけを読むので scene も camera も渡さない。設定で
      // 切られているフレームは回さず、切り替わった最初の 1 フレームだけ出力を空へ戻す
      // — 「レンズ」デバッグ表示にも、そのフレームが実際に何も作っていないことがそのまま出る。
      if (this.lensEnabled) this.lensPass.render(width, height);
      else this.lensPass.clear(width, height);

      this.quad.material = this.debugTarget === 'off' && this.lensEnabled
        ? this.lensCompositeMaterial
        : this.compositeMaterials[this.debugTarget];
    }

    // composite パス。
    this.writeDepthDebugCamera(camera);
    // 出力先を差し替えると、描画先を指定しない2つのパスが表示用ターゲットへ向く。撮影のために
    // 呼び出し側が張った出力先を潰さないよう、退避してから戻す。
    const outputTarget = this.renderer.getOutputRenderTarget();
    this.renderer.setOutputRenderTarget(this.displayTarget);
    this.gpu.beginPass(GPU_PASS.composite);
    this.quad.render(this.renderer);

    // 3D UI パス。合成パスが複製した深度に対して深度テストしながら重ね描きする。
    this.overlayPass.render(scene, camera, style);
    this.renderer.setOutputRenderTarget(outputTarget);

    // アンチエイリアスパス。表示用ターゲットの絵だけを読むので scene も camera も渡さない。
    this.antialiasPass.render();
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    this.unregisterProteinMotionRenderer();
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
    this.target.dispose();
    this.displayTarget.dispose();
    // 同じ1枚を複数の選択肢が共有するので、重複を畳んでから解放する。
    for (const material of new Set(Object.values(this.compositeMaterials))) material.dispose();
    this.schematicMaterial.dispose();
    this.filmLut.dispose();
  }
}
