// 映り込みの像の元のパス。映り込みの追跡が当たった点の像を読む元として、G バッファの面を一様に反射する面とみなした
// 放射輝度を描画バッファの解像度で描く。映り込みを切っているフレームは描かない。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import { mrt, screenUV, select, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { compileInto } from './compile-into';
import { lambertianRadianceAt, receivedIrradiance } from './material-pass';
import type { GBufferPass } from './gbuffer';
import type { LightPrepass } from './light-prepass';
import type { DiffuseCorrection } from './screen-space/diffuse-correction';

// 近傍補正を読む(correction が null でない)か読まないかの板のマテリアル。
function radianceMaterial(
  lightPrepass: LightPrepass, gbuffer: GBufferPass, correction: DiffuseCorrection | null,
): THREE.MeshBasicNodeMaterial {
  // 拡散照度は近傍の遮蔽と照り返しを含んだまま使う — 抜くと、遮られた隅の面が映り込みの中で明るくなりすぎる。
  // 映り込みの中の精度を上げる手段(事前縮小列・粗さの比で鏡面を混ぜる・画面空間より正確な追跡)は設計の判断を
  // 要するので、指示なしに着手しない。
  const radiance = lambertianRadianceAt(gbuffer, screenUV, receivedIrradiance(lightPrepass, correction));
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, transparent: false, blending: THREE.NoBlending,
  });
  material.mrtNode = mrt({
    reflectionSource: select(gbuffer.covered(), vec4(radiance, 1), vec4(0)),
  });
  return material;
}

export class ReflectionSourcePass {
  // 映り込みの像の元。面の無い画素は 0。
  private readonly target = new THREE.RenderTarget(1, 1, { depthBuffer: false, samples: 0 });
  // 近傍補正を読む板と読まない板。設定の切り替えでは持ち替える。
  private readonly correctedMaterial: THREE.MeshBasicNodeMaterial;
  private readonly uncorrectedMaterial: THREE.MeshBasicNodeMaterial;
  private readonly quad = new QuadMesh();
  // 直前に render したときのオン / オフ。null はまだ render していないこと。
  private renderedEnabled: boolean | null = null;
  // 空へ戻すときに退避する消去色。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly savedClearColor = new THREE.Color();

  // enabled / corrected は構築時点の描画設定 screenSpaceSpecular / 「遮蔽と照り返し」がオフでないか、の値。
  public constructor(
    private readonly renderer: WebGPURenderer,
    lightPrepass: LightPrepass,
    gbuffer: GBufferPass,
    correction: DiffuseCorrection,
    private readonly gpu: GpuTimings,
    private enabled: boolean,
    private corrected: boolean,
  ) {
    // 名前は MRT の出力と結び付く。
    const output = this.target.texture;
    output.name = 'reflectionSource';
    output.format = THREE.RGBAFormat;
    output.type = THREE.HalfFloatType;

    this.correctedMaterial = radianceMaterial(lightPrepass, gbuffer, correction);
    this.uncorrectedMaterial = radianceMaterial(lightPrepass, gbuffer, null);
  }

  // 映り込みの像の元(放射輝度、描画バッファの解像度)。面の無い画素は 0。
  public get texture(): THREE.Texture { return this.target.texture; }

  // 次の render からオン / オフを enabled にする。
  public setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  // 次の render から、corrected が真なら近傍補正を照度へ足して読み、偽なら読まない。
  public setCorrected(corrected: boolean): void {
    this.corrected = corrected;
  }

  // 1 フレームぶんを描く。ライティングと遮蔽と照り返しのパスの後に、描画バッファの寸法 width × height で呼ぶ。
  public render(width: number, height: number): void {
    // 切ったばかりなら描画先を空へ戻す — 残すと、切る直前の像がデバッグ表示に凍って出る。
    if (!this.enabled && this.renderedEnabled !== false) this.clear();
    this.renderedEnabled = this.enabled;
    if (!this.enabled) return;
    this.resize(width, height);
    this.renderer.setRenderTarget(this.target);
    this.quad.material = this.corrected ? this.correctedMaterial : this.uncorrectedMaterial;
    this.gpu.beginPass(GPU_PASS.reflectionSource);
    this.quad.render(this.renderer);
    this.renderer.setRenderTarget(null);
  }

  // オンなら 2 枚の板を描画先へ事前コンパイルする。
  public async compile(width: number, height: number): Promise<void> {
    if (!this.enabled) return;
    this.resize(width, height);
    for (const material of [this.correctedMaterial, this.uncorrectedMaterial]) {
      this.quad.material = material;
      await compileInto(this.renderer, this.target, this.quad, this.quad.camera);
    }
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    this.target.dispose();
    this.correctedMaterial.dispose();
    this.uncorrectedMaterial.dispose();
  }

  // 描画先を描画バッファの寸法へ合わせる。
  private resize(width: number, height: number): void {
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height);
  }

  // 描画先を黒の透明へ戻す。消去色はレンダラーを共有する他のパスのものなので、退避して戻す。
  private clear(): void {
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
  }
}
