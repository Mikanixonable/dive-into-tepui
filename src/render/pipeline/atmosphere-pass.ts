// 大気を、幾何形状ではなく画面空間のフィルタとして不透明の絵の上へ重ねる。G バッファの深度から
// 復元した位置と視線で層 1 枚ぶんの透過率と内部散乱を引き、下地へ「下地 × 透過率(波長別)+
// 内部散乱」をパスの中で合成する。
//
// **板は 1 天体分だけ持ち、複数の大気は奥から順に描き重ねる。** 合成は「下地 × 透過率 +
// 内部散乱」の鎖なので、奥の層の出力をそのまま手前の層の下地にすれば同じ絵になる。
// どの天体の見えも同じ 1 枚の板で解き、違うのは層へ書き込む光学パラメータと、呼び出し側が
// 配ったサンプル点の数だけ。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { Fn, length, screenUV, sub, texture, uniform, vec4 } from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import { MAX_ATMOSPHERE_BODIES, type AtmosphereDraw, cutoffAltitude } from '../atmosphere';
import { AtmosphereIntegrator } from './atmosphere-integrator';
import { viewPositionAt, viewRayAt } from './view-ray';
import type { CloudSpecies } from './cloud-atmosphere-renderer';
import type { CloudLodMode } from '../cloud/cloud-field-sampler';
import type { Mat4Uniform, Vec3Node } from '../tsl-types';
import type { GBufferPass } from './gbuffer';
import type { BodyShadow } from './shadow/body-shadow';
import type { SunLight } from './sun-light';
import { compileInto } from './compile-into';

// 1 枚を画面いっぱいへ写すだけのマテリアル。
function copyMaterial(source: THREE.Texture): THREE.MeshBasicNodeMaterial {
  const material = new THREE.MeshBasicNodeMaterial({
    depthTest: false, depthWrite: false, blending: THREE.NoBlending,
  });
  material.colorNode = texture(source, screenUV);
  return material;
}

export class AtmospherePass {
  private readonly quad: QuadMesh;
  private readonly material: THREE.MeshBasicNodeMaterial;
  // 板が解く層。描く直前に、その天体の光学パラメータを書き込む。
  private readonly layer: AtmosphereIntegrator;
  // 板が読む下地。層ごとに、その層より奥まで重ね終えた絵をここへ写す。
  private readonly backdropTarget: THREE.RenderTarget;
  private readonly sharedCopyMaterial: THREE.MeshBasicNodeMaterial;
  private readonly sharedCopyQuad: QuadMesh;
  // 描画デバッグ表示へ渡す 1 枚と、それを下地として読み直すためのコピー板。
  private readonly inspectTarget: THREE.RenderTarget;
  private readonly inspectCopyMaterial: THREE.MeshBasicNodeMaterial;
  private readonly inspectCopyQuad: QuadMesh;
  // QuadMesh は固定直交カメラで描かれるため、実カメラの逆射影行列と view→描画座標の行列は
  // 毎フレーム自前で書き込む。
  private readonly projMatrixInverse: Mat4Uniform;
  private readonly viewToWorld: Mat4Uniform;
  // このフレームに重ねる層。視点に近い順。
  private draws: readonly AtmosphereDraw[] = [];
  // 裾球と、クリア色の退避先。フレームごとに確保しない使い回し領域。
  private readonly cutoffSphere = new THREE.Sphere();
  private readonly savedClearColor = new THREE.Color();
  private readonly frustum = new THREE.Frustum();
  private readonly viewProjection = new THREE.Matrix4();

  // 大気は、共有ターゲットに入った不透明の絵を下地として読み、「下地 × 透過率 + 内部散乱」を
  // 解いた完成形で同じターゲットを上書きする。合成をブレンドではなくパスの中で行うのは、
  // 合成のアルファは 1 つしか無く、下地の波長別の減衰(厚い大気越しの下地が赤へ寄る)を
  // 表せないため。
  public constructor(
    private readonly renderer: WebGPURenderer,
    gbuffer: GBufferPass,
    private readonly sharedTarget: THREE.RenderTarget,
    sunLight: SunLight,
    bodyShadow: BodyShadow,
    private readonly gpu: GpuTimings,
  ) {
    this.layer = new AtmosphereIntegrator(sunLight, bodyShadow);
    this.projMatrixInverse = uniform(new THREE.Matrix4());
    this.viewToWorld = uniform(new THREE.Matrix4());

    // 下地も点検用の1枚も色を写しただけなので、深度を持たない。
    this.backdropTarget = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    });
    this.inspectTarget = new THREE.RenderTarget(1, 1, {
      type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false,
    });
    this.sharedCopyMaterial = copyMaterial(sharedTarget.texture);
    this.sharedCopyQuad = new QuadMesh(this.sharedCopyMaterial);
    this.inspectCopyMaterial = copyMaterial(this.inspectTarget.texture);
    this.inspectCopyQuad = new QuadMesh(this.inspectCopyMaterial);

    const viewPos = viewPositionAt(gbuffer.depthTexture, this.projMatrixInverse);
    const opaquePos: Vec3Node = this.viewToWorld.mul(vec4(viewPos, 1)).xyz;
    // 視線は投影方式に依らない形(view-ray.ts)から取る — 平行投影の視線はカメラ位置から
    // 放射状に出ないので、「カメラ位置から復元位置へ」の形では組めない。
    const ray = viewRayAt(this.projMatrixInverse);
    const rayOrigin: Vec3Node = this.viewToWorld.mul(vec4(ray.origin, 1)).xyz;
    const rayDir: Vec3Node = this.viewToWorld.mul(vec4(ray.direction, 0)).xyz;
    const opaqueDist = length(sub(opaquePos, rayOrigin));

    const composed = Fn(() => {
      const { transmittance, inscatter } = this.layer.contribution(rayOrigin, rayDir, opaqueDist);
      return inscatter.add(texture(this.backdropTarget.texture, screenUV).rgb.mul(transmittance));
    })();

    this.material = new THREE.MeshBasicNodeMaterial({
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this.material.colorNode = composed;
    this.quad = new QuadMesh(this.material);
  }

  // 種類ごとに、雲の殻を描くかを置き直す。
  public setCloudShellEnabled(species: CloudSpecies, enabled: boolean): void {
    this.layer.setCloudShellEnabled(species, enabled);
  }

  public setCloudBlueNoiseEnabled(enabled: boolean): void {
    this.layer.setCloudBlueNoiseEnabled(enabled);
  }

  public setCloudLodSampling(mode: CloudLodMode, fixedLevel = 0): void {
    this.layer.setCloudLodSampling(mode, fixedLevel);
  }

  // このフレームで大気を描く天体を、**視点に近い順**に、それぞれのサンプル点の数と一緒に渡す。
  // 合成の前後はこの並びで決まる。MAX_ATMOSPHERE_BODIES を超えた分は描かれない。
  public setDraws(draws: readonly AtmosphereDraw[]): void {
    this.draws = draws.slice(0, MAX_ATMOSPHERE_BODIES);
  }

  // 視錐台に掛かる層を奥から順に、共有ターゲットの不透明の絵へ重ねる。
  public render(camera: THREE.Camera): void {
    this.composeLayers(camera, this.sharedTarget, this.sharedCopyQuad);
  }

  // 描画デバッグ表示へ渡す1枚。
  public get inspectTexture(): THREE.Texture { return this.inspectTarget.texture; }

  // 大気が最初に重ねる下地を、そのまま点検用の1枚へ控える。render より前に呼ぶこと。
  public inspectBackdrop(): void {
    this.syncSize(this.inspectTarget);
    this.copyInto(this.inspectTarget, this.sharedCopyQuad);
  }

  // 下地を黒へ置き換えて同じ層を重ね、大気が足す内部散乱だけを点検用の1枚へ描く。
  public inspectScattered(camera: THREE.Camera): void {
    this.syncSize(this.inspectTarget);
    // 層を1つも描かないフレームは、この黒がそのまま残る。
    this.clearToBlack(this.inspectTarget);
    this.composeLayers(camera, this.inspectTarget, this.inspectCopyQuad);
  }

  // 下地の控えと大気の合成板を、描画時と同じターゲットへ事前コンパイルする。
  public async compile(camera: THREE.Camera): Promise<void> {
    this.writeCamera(camera);
    this.syncSize(this.backdropTarget);
    await compileInto(this.renderer, this.backdropTarget, this.sharedCopyQuad, this.sharedCopyQuad.camera);
    await compileInto(this.renderer, this.sharedTarget, this.quad, this.quad.camera);
  }

  // 層を奥から順に destination へ重ねる。層ごとに、そこまでに重ね終えた絵を backdropSource から
  // 下地の控えへ写し、それを読んで destination を書き換える。
  //
  // **視錐台から外れた層は描画命令ごと落とす** — 裾の外の密度は打ち切り済みなので、裾球が
  // 掛からない層は絵に何も足さない。
  private composeLayers(camera: THREE.Camera, destination: THREE.RenderTarget, backdropSource: QuadMesh): void {
    this.writeCamera(camera);
    this.frustum.setFromProjectionMatrix(
      this.viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
      camera.coordinateSystem, camera.reversedDepth,
    );
    // **奥から重ねる** — draws は視点に近い順なので、逆にたどる。手前の層の透過率が奥の層の
    // 内部散乱へ掛かる形は、奥の出力を手前の下地にすることで出る。
    for (let index = this.draws.length - 1; index >= 0; index--) {
      const { body, steps } = this.draws[index]!;
      const cutoffRadius = body.surfaceRadius + cutoffAltitude(body.optics, body.surfaceRadius);
      this.cutoffSphere.set(body.center, cutoffRadius);
      if (!this.frustum.intersectsSphere(this.cutoffSphere)) continue;
      this.layer.write(body, steps, cutoffRadius);
      this.syncSize(this.backdropTarget);
      this.copyInto(this.backdropTarget, backdropSource);
      // 雲を含む天体は、雲専用の計測行へ分ける。ただし積分器は大気散乱と雲散乱を同じ
      // fullscreen materialで合成するため、ここでの時刻は「雲有効大気の合算」であり、
      // 雲項だけをGPU上で分離した値ではない。
      this.drawLayer(destination, body.clouds !== null);
    }
  }

  // QuadMesh は固定直交カメラで描かれるので、実カメラの行列を uniform へ書き写す。
  private writeCamera(camera: THREE.Camera): void {
    this.projMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.viewToWorld.value.copy(camera.matrixWorld);
  }

  // いま書き込んである層 1 つを destination へ描く。
  private drawLayer(destination: THREE.RenderTarget, includesClouds: boolean): void {
    // 色だけを上書きする — 共有ターゲットの深度はマテリアルパスが書いたものを後段も使う。
    this.renderer.setRenderTarget(destination);
    this.renderer.autoClear = false;
    // GPU 計測は、beginPass の直後の描画命令に付く。層ごとのぶんは計測側が足し合わせる。
    this.gpu.beginPass(includesClouds ? GPU_PASS.cloudAtmosphere : GPU_PASS.atmosphere);
    this.quad.render(this.renderer);
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
  }

  // source が読んでいる1枚を destination へ写す。
  private copyInto(destination: THREE.RenderTarget, source: QuadMesh): void {
    this.gpu.beginPass(GPU_PASS.atmosphere);
    this.renderer.setRenderTarget(destination);
    source.render(this.renderer);
    this.renderer.setRenderTarget(null);
  }

  // ターゲットを黒で塗り潰す。クリア色はレンダラの共有状態なので、退避して戻す。
  private clearToBlack(target: THREE.RenderTarget): void {
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 1);
    this.renderer.setRenderTarget(target);
    this.renderer.clear(true, false, false);
    this.renderer.setRenderTarget(null);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
  }

  // 中間の1枚を共有ターゲットと同じ寸法へ合わせる。**点検用の1枚は、点検が要求されたときだけ
  // 広げる** — 通常のプレイでは 1×1 のまま置いておく。
  private syncSize(target: THREE.RenderTarget): void {
    const { width, height } = this.sharedTarget;
    if (target.width !== width || target.height !== height) target.setSize(width, height);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  public dispose(): void {
    this.material.dispose();
    this.backdropTarget.dispose();
    this.inspectTarget.dispose();
    this.sharedCopyMaterial.dispose();
    this.inspectCopyMaterial.dispose();
    this.layer.dispose();
  }
}
