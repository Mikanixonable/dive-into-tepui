// フレームの描画パス構成を制御する。render/** 配下の個々の描画物モジュールとは別に、
// 「何段で、どのターゲットへ描き、どう合成してキャンバスへ出すか」をここへ集約する。
// 現在は10段: 影パス(恒星の直射光を遮るメッシュをライト空間の深度マップへ描く)→ G バッファパス
// (深度・法線・ラフネスを MRT へ描く)→ 遮蔽パス(G バッファ深度から
// 復元した位置に届く恒星の直射光の透過率を1枚へ描く)→ ライティングパス(その2枚だけを読み、
// 拡散/鏡面の照度を MRT へ描く)→ マテリアルパス(lit-opaque 層をライティングパスの照度で描き、
// world パスと共有する HDR ターゲットの最初の書き込みとしてクリアする)→ 大気パス(同じ
// ターゲットへ画面空間で大気を重ねる)→ world パス(シーンを同じ HDR ターゲットへ重ね描きする)
// → レンズ効果パス(明るい画素の光を画面上の角度で決まる広がりへ配り直す)→ composite パス
// → 3D UI パス。composite パスは通常表示
// (debugTarget==='off')では HDR ターゲットをトーンマッピングしてキャンバスへ合成し、それ以外を選ぶと
// 代わりに中間ターゲットの中身を画面いっぱいに映す(debug-target.ts)。あわせて G バッファの
// 深度をキャンバスの深度バッファへ複製するので、最後の 3D UI パス(overlay-pass.ts)は
// 普通に深度テストするだけで不透明物の奥へ隠れる。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { log, max, neutralToneMapping, screenUV, select, texture, uniform, vec3, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import type { GraphicsOptionKey, GraphicsSettingsData, GraphicsTarget } from '../graphics-settings';
import type { RenderStyle } from '../render-style';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec4Node } from '../tsl-types';
import type { DebugTargetHost, DebugTargetId } from './debug-target';
import { GBufferPass, octDecodeNormal } from './gbuffer';
import { AtmospherePass } from './atmosphere-pass';
import { LightPrepass } from './light-prepass';
import { PlanetLightSource } from './lighting/planet-light-source';
import { SunSource } from './lighting/sun-source';
import { MaterialPass } from './material-pass';
import { OcclusionPass } from './occlusion';
import { SunOcclusion } from './sun-occlusion';
import { OverlayPass } from './overlay-pass';
import { SchematicComposite } from './schematic-composite';
import { LensPass } from './lens-pass';
import { Exposure } from './exposure';
import { SunLight } from './sun-light';
import { SunShadowMaps, type SunShadowSlot } from './sun-shadow-maps';
import { viewPositionAt } from './view-ray';
import { flushProteinMotionComputes, registerProteinMotionRenderer } from '../protein-motion-material';

// applyGraphics が読む項目。**ここを変えたときだけ描画が変わる**ので、パイプラインだけを
// 駆動する呼び出し側(描画テスト環境)は、この並びを操作の対象にする。
export const PIPELINE_GRAPHICS_KEYS = [
  'lens', 'exposureCompensation', 'sunLightModel', 'planetLightModel',
  'meshShadow', 'shadowSlotCount', 'shadowSlotSize', 'shadowTexelsPerPixel',
] as const satisfies readonly GraphicsOptionKey[];

export class RenderPipeline implements DebugTargetHost, GraphicsTarget {
  private readonly renderer: WebGPURenderer;
  private readonly gbuffer: GBufferPass;
  private readonly occlusionPass: OcclusionPass;
  private readonly _sunOcclusion: SunOcclusion;
  private readonly sunShadowMaps: SunShadowMaps;
  private readonly lightPrepass: LightPrepass;
  // 光源モデルの設定を受けるため、光源の列とは別に太陽光源だけ手元にも持つ。
  private readonly sunSource: SunSource;
  private readonly _planetLight: PlanetLightSource;
  private readonly materialPass: MaterialPass;
  private readonly atmospherePass: AtmospherePass;
  private readonly overlayPass: OverlayPass;
  private readonly lensPass: LensPass;
  private readonly _sunLight: SunLight;
  private readonly _exposure: Exposure;
  private readonly target: THREE.RenderTarget;
  private readonly quad: QuadMesh;
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
  debugTarget: DebugTargetId = 'off';

  // ライティングパスが読む恒星光。EnvironmentScene がここへ毎フレーム書き込む。
  get sunLight(): SunLight { return this._sunLight; }

  // 合成パスが掛ける露出。EnvironmentScene が順応の基準点を毎フレーム書き込む。
  get exposure(): Exposure { return this._exposure; }

  // 恒星の直射光の遮蔽。EnvironmentScene が遮蔽器と環の帯を毎フレーム書き込む。
  get sunOcclusion(): SunOcclusion { return this._sunOcclusion; }

  // 天体照の光源スロット。EnvironmentScene が選んだ天体を毎フレーム書き込む。
  get planetLight(): PlanetLightSource { return this._planetLight; }

  // 大気パス。EnvironmentScene が大気を持つ天体を毎フレーム書き込む。
  get atmosphere(): AtmospherePass { return this.atmospherePass; }

  // G バッファパス・ライティングパス・マテリアルパスと、world パスの描画先である HDR
  // オフスクリーンターゲット、それらをキャンバスへ合成する QuadMesh 用のデバッグ表示ごとの
  // マテリアルを構築する。
  constructor(renderer: WebGPURenderer, graphics: GraphicsSettingsData, private readonly gpu: GpuTimings) {
    this.renderer = renderer;
    this.unregisterProteinMotionRenderer = registerProteinMotionRenderer(renderer);
    this.gbuffer = new GBufferPass(renderer, gpu);
    this._sunLight = new SunLight();
    this._exposure = new Exposure();
    this.sunShadowMaps = new SunShadowMaps(
      renderer, gpu, graphics.meshShadow,
      graphics.shadowSlotCount, graphics.shadowSlotSize, graphics.shadowTexelsPerPixel,
    );
    this._sunOcclusion = new SunOcclusion(this._sunLight, this.sunShadowMaps);
    this.occlusionPass = new OcclusionPass(renderer, this.gbuffer, this._sunOcclusion, gpu);
    this.sunSource = new SunSource(this._sunLight, this.occlusionPass, graphics.sunLightModel);
    this._planetLight = new PlanetLightSource(graphics.planetLightModel);
    this.lightPrepass = new LightPrepass(renderer, this.gbuffer, [
      this.sunSource, ...this._planetLight.lightSources,
    ], gpu);
    this.materialPass = new MaterialPass(renderer, this.lightPrepass, gpu);
    this.atmospherePass = new AtmospherePass(
      renderer, this.gbuffer, this._sunLight, this._sunOcclusion, this.occlusionPass, gpu,
    );
    this.overlayPass = new OverlayPass(renderer, gpu, this.gbuffer.depthTexture);

    // antialias はレンダラ生成時にしか渡せず(scene.ts 参照)、キャンバスへの直描きは
    // それでマルチサンプルされていた。オフスクリーンの HDR ターゲットは自前で samples を
    // 要求しないと素通りで失われるので、構築時に一度だけ読んで反映する。
    const samples = graphics.antialias ? 4 : 0;
    this.target = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      format: THREE.RGBAFormat,
      depthBuffer: true,
      samples,
    });
    // G バッファと同じく、深度を 32bit 浮動小数点にするには明示が要る(gbuffer.ts 参照)。
    this.target.depthTexture = new THREE.DepthTexture(1, 1, THREE.FloatType);

    this.lensPass = new LensPass(renderer, this.target.texture, gpu);
    this.lensEnabled = graphics.lens;

    this.depthDebugNear = uniform(1);
    this.depthDebugFar = uniform(2);
    this.depthDebugProjInv = uniform(new THREE.Matrix4());
    this.debugViewToWorld = uniform(new THREE.Matrix4());

    // デバッグ表示の切替は quad.material の差し替えで行う(WebGPU ではジオメトリ/頂点属性の
    // 差し替えは禁止だが、マテリアルの差し替えは可 — CLAUDE.md の WebGPU 注意点参照)。1枚の
    // マテリアルをユニフォーム分岐させると、通常プレイの毎フレームで G バッファの全テクスチャを
    // bind/sample することになるため、表示ごとに別マテリアルを構築する。
    this.compositeMaterials = {
      off: this.buildCompositeMaterial(vec4(this.toneMapped(texture(this.target.texture, screenUV).rgb), 1)),
      normal: this.buildCompositeMaterial(
        vec4(octDecodeNormal(texture(this.gbuffer.normalTexture, screenUV).rg).mul(0.5).add(0.5), 1),
      ),
      roughness: this.buildCompositeMaterial(
        vec4(vec3(texture(this.gbuffer.roughnessTexture, screenUV).r), 1),
      ),
      depth: this.buildCompositeMaterial(vec4(vec3(this.logDepthNode()), 1)),
      // 4 枚のスロットを 2x2 に並べて画面いっぱいへ映す。線形深度なのでそのまま濃淡として
      // 読め(遠いほど白)、使われていないスロットは真っ白のまま残る。
      shadow: this.buildCompositeMaterial(vec4(vec3(this.shadowSlotGridNode()), 1)),
      'shadow-slot': this.buildCompositeMaterial(vec4(this.shadowSlotColorNode(), 1)),
      occlusion: this.buildCompositeMaterial(
        vec4(vec3(texture(this.occlusionPass.texture, screenUV).r), 1),
      ),
      // 照度・陰影は 1 を超え得る HDR 値なので、通常表示と同じトーンマッピングを通してから
      // 画面へ出す(1 天文単位の放射照度は π を超えるため、通さないと全面白になる)。
      diffuse: this.buildCompositeMaterial(
        vec4(this.toneMapped(texture(this.lightPrepass.diffuseTexture, screenUV).rgb), 1),
      ),
      specular: this.buildCompositeMaterial(
        vec4(this.toneMapped(texture(this.lightPrepass.specularTexture, screenUV).rgb), 1),
      ),
      material: this.buildCompositeMaterial(
        vec4(this.toneMapped(texture(this.materialPass.texture, screenUV).rgb), 1),
      ),
      atmosphere: this.buildCompositeMaterial(
        vec4(this.toneMapped(this.atmospherePass.scatteredLight()), 1),
      ),
      lens: this.buildCompositeMaterial(vec4(this.toneMapped(this.lensPass.redistributedLight()), 1)),
    };
    this.lensCompositeMaterial = this.buildCompositeMaterial(
      vec4(this.toneMapped(this.lensPass.blendedWith(texture(this.target.texture, screenUV).rgb)), 1),
    );
    // 模式図用の合成マテリアルは compositeMaterials とは別に1枚だけ持つ。debugTarget の選択肢
    // (DebugTargetId)には含まれない、表示スタイルそのものの切り替えのため。
    this.schematicComposite = new SchematicComposite(this.gbuffer, this.depthDebugProjInv);
    this.schematicMaterial = this.buildCompositeMaterial(this.schematicComposite.colorNode);

    this.quad = new QuadMesh(this.compositeMaterials.off);
  }

  // 1 を超える HDR 値を切り落とさず白へ寄せる。Khronos PBR Neutral を選ぶのは、圧縮開始点より
  // 下では色相・彩度を保ったまま素通しするため — 「表示値 = アルベド」という校正が中間調では
  // そのまま読み取れる。明るさの基準は放射照度の単位そのもの(sun-light.ts の
  // SUN_IRRADIANCE_1AU)が決めていて、そこからいまいる場所へ合わせ直すぶんが露出係数になる。
  private toneMapped(color: Vec3Node): Vec3Node {
    return neutralToneMapping(color, this._exposure.factor) as Vec3Node;
  }

  // depthTest/depthWrite/transparent の共通設定を1箇所へまとめた、composite 用マテリアルの
  // 下請け。colorNode だけがデバッグ表示ごとに異なる。
  //
  // 深度は G バッファのものを画面の深度バッファへそのまま複製する(depthTest は切ったまま
  // depthWrite を立てるので、全画素が無条件に書かれる)。次段の 3D UI パスがこれに対して
  // 深度テストするだけで済み、線のマテリアルをノード化せずに不透明物の奥へ隠せる。
  // デバッグ表示中も同じく書く — 中間結果を見ている間も 3D UI が正しく隠れるほうが読みやすい。
  private buildCompositeMaterial(colorNode: Vec4Node): THREE.MeshBasicNodeMaterial {
    const material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: true, transparent: false });
    material.colorNode = colorNode;
    material.depthNode = texture(this.gbuffer.depthTexture, screenUV).r;
    return material;
  }

  // 影のスロット 4 枚を 2x2 のタイルとして 1 枚のノードへ畳む。スロットは独立した
  // レンダーターゲットなので、並べるのは表示のときだけの都合。
  private shadowSlotGridNode(): FloatNode {
    const tileUV = screenUV.mul(2).fract();
    const slots = this.sunShadowMaps.slots;
    const left = screenUV.x.lessThan(0.5);
    // screenUV は上端が原点なので、y の小さいほうが画面の上段。
    const top = screenUV.y.lessThan(0.5);
    // 深度マップはメートルで持っているので、スロットごとの深度の幅で割って濃淡へ直す。
    const tile = (slot: SunShadowSlot): FloatNode => texture(slot.texture, tileUV).r
      .div(max(slot.far.sub(slot.near), 1e-6));
    const topRow = select(left, tile(slots[0]!), tile(slots[1]!));
    const bottomRow = select(left, tile(slots[2]!), tile(slots[3]!));
    return select(top, topRow, bottomRow);
  }

  // G バッファ深度から復元した位置を覆う影スロットの色。どのスロットも覆っていなければ黒。
  private shadowSlotColorNode(): Vec3Node {
    const viewPos = viewPositionAt(this.gbuffer.depthTexture, this.depthDebugProjInv);
    const worldPos: Vec3Node = this.debugViewToWorld.mul(vec4(viewPos, 1)).xyz;
    return this._sunOcclusion.slotDebugColor(worldPos);
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

  // 描画品質設定のうち、GPU 資源の確保を伴うものを各パスへ配る。値が変わった時点で1回呼ばれる。
  applyGraphics(graphics: GraphicsSettingsData): void {
    this.lensEnabled = graphics.lens;
    this.sunShadowMaps.setQuality(
      graphics.meshShadow,
      graphics.shadowSlotCount, graphics.shadowSlotSize, graphics.shadowTexelsPerPixel,
    );
    this._exposure.setCompensation(graphics.exposureCompensation);
    this.sunSource.setModel(graphics.sunLightModel);
    this._planetLight.setModel(graphics.planetLightModel);
  }

  // 1 フレームぶんの描画を、影 → G バッファ → 遮蔽 → ライティング → マテリアル → 大気 →
  // world → レンズ → 合成 → 3D UI の順に発行する。Game.render() から毎フレーム 1回呼ぶ。
  // 模式図スタイルではマテリアル・大気・world・レンズの4段を飛ばす。
  // デバッグ表示を選んでいてもいずれのパスも省略しない — 見せるのは通常のフレームが実際に
  // 生成した中身であるべきため。設定で切られている段(影・レンズ)を選べば、そのフレームが
  // 何も作っていないことがそのまま空として見える。**見せるために描き足すのはマテリアルだけ**
  // — あの段の出力は共有ターゲットの上で大気と world に上書きされて残らず、かつ MSAA を
  // 落とさずに残す方法が無いため(material-pass.ts の showDebugTarget)。
  render(scene: THREE.Scene, camera: THREE.Camera, style: RenderStyle): void {
    this.renderer.getDrawingBufferSize(this.drawingBufferSize);
    const width = this.drawingBufferSize.x;
    const height = this.drawingBufferSize.y;
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);

    // 影パスと本体パスが同じフレームの残基配置を読むよう、両方より前に一度だけ合成する。
    flushProteinMotionComputes(this.renderer);

    // 太陽光の影パス。G バッファを必要としないので、その前に置く。設定で切られているフレームは
    // スロットが空のまま返り、遮蔽関数側も 1 を返す。
    this.sunShadowMaps.render(scene, camera, height, this._sunLight);

    // G バッファパス。camera.layers の一時的な絞り込みと GPU 計測の申告は自身の中で行う。
    this.gbuffer.render(scene, camera, width, height);

    // 遮蔽パス。G バッファ深度だけを読むので scene は渡さない。
    this.occlusionPass.render(camera, width, height);

    // ライティングパス。G バッファと遮蔽度だけを読むので scene は渡さない。
    this.lightPrepass.render(camera, width, height);

    // 模式図は G バッファの深度・法線だけから輪郭を出すため、マテリアルパス・大気パス・world
    // パスを経ない。星野・大気・オーロラ・環の質感・小天体の点群・ビルボードは、この3段が
    // 描いていたものなので、呼ばないだけで画面から消える。
    if (style === 'schematic') {
      this.schematicComposite.update(width, height);
      this.quad.material = this.schematicMaterial;
    } else {
      // マテリアルパス。LIT_OPAQUE_LAYER のオブジェクトと背景専用レイヤーを this.target(このあとの
      // world パスと共有 — 最初の書き込みなのでクリアする)へ描く。「マテリアル」デバッグ表示を選んでいる
      // ときだけ、自前のターゲットへも同じジオメトリをもう一度描く。
      this.materialPass.render(scene, camera, this.target, width, height, this.debugTarget === 'material');

      // 大気パス。不透明の絵の上へ画面空間で重ねる。G バッファ深度と視線だけを読むので scene は渡さない。
      this.atmospherePass.render(camera, this.target);

      // world パス。マテリアルパスが LIT_OPAQUE_LAYER と背景専用レイヤーをチャンネル0から外しているので、
      // 既定のカメラマスクで描く限りここでは自動的に重複しない。autoClear を落として
      // マテリアルパスの描画(色・深度とも)を残したまま重ね描きする — world パスは透明物
      // (オービットライン・プルーム・ビルボードなど)を自分の描画順の最後に描くため、不透明な
      // 自艦の深度がその前に書き込まれていないと、自艦の手前にある透明物がそれで上書きされて
      // しまう。beginPass はそのパスが発行する renderer.render() の直前に呼び、GPU 所要時間の
      // 計測先を申告する。
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

    // composite パス。QuadMesh.render も内部で renderer.render() を呼ぶので、world パスとは
    // 別の GPU 計測枠が付く。
    this.depthDebugProjInv.value.copy(camera.projectionMatrixInverse);
    this.debugViewToWorld.value.copy(camera.matrixWorld);
    if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
      this.depthDebugNear.value = camera.near;
      this.depthDebugFar.value = camera.far;
    }
    this.gpu.beginPass(GPU_PASS.composite);
    this.quad.render(this.renderer);

    // 3D UI パス。合成パスが複製した深度に対して深度テストしながら、キャンバスへ重ね描きする。
    this.overlayPass.render(scene, camera, style);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  dispose(): void {
    this.unregisterProteinMotionRenderer();
    this.gbuffer.dispose();
    this.occlusionPass.dispose();
    this.sunShadowMaps.dispose();
    this.lightPrepass.dispose();
    this.materialPass.dispose();
    this.atmospherePass.dispose();
    this.overlayPass.dispose();
    this.lensPass.dispose();
    this.lensCompositeMaterial.dispose();
    this.target.dispose();
    for (const material of Object.values(this.compositeMaterials)) material.dispose();
    this.schematicMaterial.dispose();
  }
}
