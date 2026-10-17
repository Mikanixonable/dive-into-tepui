// G バッファ(法線・粗さ・深度)から、そのシェーディング点に届く光の量を拡散・直接の鏡面・遠方の鏡面の
// 3枚の照度バッファへ書く。照度は素材(アルベド・金属度・F0)を掛ける前の、どれだけの光がどこから届くかを表す。
// 近傍補正が遠方の拡散光を向きを見る天体照のスロットごとと、向きを見ない和とに分けて読むときは、
// 遠方の拡散照度をそれらの描画先へも書く。
//
// フレームの最初に照度バッファを 0 でクリアし、光源 1 つにつきフルスクリーン 1 枚を加算合成で積む。
// 光源は拡散と自分の鏡面(と分けるときの遠方の拡散)だけに書くので、その描画先だけを結んだ組へ描く。
// 寄与の中身はそれぞれの光源(lighting/)が持ち、このパスは器に徹する。
//
// 面が写っていない画素の照度は 0 になる。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { GPU_PASS, type GpuTimings } from '../gpu-timings';
import type { GBufferPass } from './gbuffer';
import { DIFFUSE_OUTPUT, FAR_DIFFUSE_OUTPUT, SPECULAR_OUTPUT, type LightSource } from './lighting/light-source';
import { ShadingSample } from './lighting/shading-sample';
import { compileInto } from './compile-into';
import { MrtTexturePool } from './mrt-texture-pool';

// 1 度に結べるテクスチャの数。添付 1 枚あたりのバイト数の既定の上限 32 を、rgba16float の 8 で割った数。
const MAX_ATTACHMENTS = 4;

export class LightPrepass {
  private readonly renderer: WebGPURenderer;
  private readonly pool: MrtTexturePool;
  private readonly quad: QuadMesh;
  private readonly sample: ShadingSample;
  // 何も描かずクリアだけを発行するための空のシーン。クリアも render() 呼び出しにして計時へ乗せる。
  private readonly clearScene = new THREE.Scene();
  // 積む順の全光源。
  private readonly sources: readonly LightSource[];
  private readonly precompiledSources: readonly LightSource[];
  // 天体照のスロットの光源。スロット i は、向きを見るとき directionalPlanetDiffuse[i] へ遠方の拡散を書く。
  private readonly planetSlots: readonly LightSource[];
  // 前のフレームにクリアして結んだテクスチャ。結ばなくなったものを 1 度だけ空へ戻すために覚える。
  private previousBound: readonly THREE.Texture[] = [];
  private readonly diffuse: THREE.Texture;
  private readonly directSpecular: THREE.Texture;
  private readonly farSpecular: THREE.Texture;
  private readonly undirectedFarDiffuse: THREE.Texture;
  private readonly directionalPlanetDiffuse: readonly THREE.Texture[];
  // クリア色の退避先。毎フレーム確保しないよう 1 つだけ持つ。
  private readonly savedClearColor = new THREE.Color();

  // 照度バッファと、光源が共有するシェーディング入力を組む。積む順は sun、planetSlots、ambient、onDemandSources。
  // sun・planetSlots・ambient は事前コンパイルでマテリアルを組み、onDemandSources は寄与を持った最初のフレームで組む。
  public constructor(
    renderer: WebGPURenderer,
    gbuffer: GBufferPass,
    sun: LightSource,
    planetSlots: readonly LightSource[],
    ambient: LightSource,
    onDemandSources: readonly LightSource[],
    private readonly gpu: GpuTimings,
  ) {
    this.renderer = renderer;
    this.planetSlots = planetSlots;
    this.precompiledSources = [sun, ...planetSlots, ambient];
    this.sources = [...this.precompiledSources, ...onDemandSources];

    // WebGPU に3チャンネル16bit浮動小数点フォーマットは無いため、rgba16float(a は未使用)を使う。
    // 遠方の拡散の描画先は、向きを見ない和とスロットごとで同じ出力名を持つ(同じ組には 1 枚しか入らない)。
    this.pool = new MrtTexturePool([
      DIFFUSE_OUTPUT, SPECULAR_OUTPUT.direct, SPECULAR_OUTPUT.far,
      ...Array.from({ length: 1 + planetSlots.length }, () => FAR_DIFFUSE_OUTPUT),
    ]);
    const [diffuse, directSpecular, farSpecular, undirectedFarDiffuse, ...directionalPlanetDiffuse] = this.pool.textures;
    this.diffuse = diffuse!;
    this.directSpecular = directSpecular!;
    this.farSpecular = farSpecular!;
    this.undirectedFarDiffuse = undirectedFarDiffuse!;
    this.directionalPlanetDiffuse = directionalPlanetDiffuse;

    this.sample = new ShadingSample(gbuffer);
    this.quad = new QuadMesh();
  }

  public get diffuseTexture(): THREE.Texture { return this.diffuse; }
  // 近くの物体の映り込みが置き換えない鏡面の照度(太陽など)。
  public get directSpecularTexture(): THREE.Texture { return this.directSpecular; }
  // 近くの物体の映り込みが置き換える鏡面の照度(天体照と環境光)。
  public get farSpecularTexture(): THREE.Texture { return this.farSpecular; }
  // 遠方の拡散照度のうち、向きを見ない和(環境光と、向きを見る数から先のスロット)。
  public get undirectedFarDiffuseTexture(): THREE.Texture { return this.undirectedFarDiffuse; }

  // 遠方の拡散照度のうち、向きを見るスロット slot(0..スロット数 − 1)の天体が届けるぶん。
  public directionalPlanetDiffuseTexture(slot: number): THREE.Texture {
    return this.directionalPlanetDiffuse[slot]!;
  }

  // 寄与のある光源を順に照度バッファへ積む。camera は共有のシェーディング入力の行列を
  // 毎フレーム引き直すためだけに使い、シーン自体は描かない(光源ごとのフルスクリーンのみ)。
  // directionalSlotCount は遠方の拡散を向きを見るスロットの先頭の何枚かと和とに分けて書くときの枚数で、
  // null なら分けない。
  public render(camera: THREE.Camera, width: number, height: number, directionalSlotCount: number | null): void {
    this.pool.setSize(width, height);
    this.sample.sync(camera);

    // 加算合成の土台は 0。クリア色は共有状態なので退避して戻す(lens-pass.ts と同じ)。
    const savedClearAlpha = this.renderer.getClearAlpha();
    this.renderer.getClearColor(this.savedClearColor);
    this.renderer.setClearColor(0x000000, 0);
    this.clearBound(directionalSlotCount);

    this.renderer.autoClear = false;
    for (const source of this.sources) {
      if (!source.hasContribution()) continue;
      this.renderer.setRenderTarget(this.targetOf(source, directionalSlotCount));
      this.quad.material = source.material(this.sample);
      // beginPass は render() 呼び出しごとに申告する。同じパスの複数回ぶんは計測側が足し合わせる。
      this.gpu.beginPass(GPU_PASS.lighting);
      this.quad.render(this.renderer);
    }
    this.renderer.autoClear = true;
    this.renderer.setRenderTarget(null);
    this.pool.select(this.basicTextures);
    this.renderer.setClearColor(this.savedClearColor, savedClearAlpha);
  }

  // 事前コンパイルする光源ごとの全マテリアルを、directionalSlotCount で本番に描く組へ結んだ照度ターゲットへ
  // 事前コンパイルする。
  public async compile(
    camera: THREE.Camera, width: number, height: number, directionalSlotCount: number | null,
  ): Promise<void> {
    this.pool.setSize(width, height);
    this.sample.sync(camera);
    for (const source of this.precompiledSources) {
      const target = this.targetOf(source, directionalSlotCount);
      this.quad.material = source.material(this.sample);
      await compileInto(this.renderer, target, this.quad, this.quad.camera);
    }
    this.pool.select(this.basicTextures);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで
  // 共有する単一の板なので、ここでは解放しない。
  public dispose(): void {
    this.pool.dispose();
    for (const source of this.sources) source.dispose();
  }

  // 常に書く 3 枚(拡散・直接の鏡面・遠方の鏡面)。描き終えたらこの組を結んでおく — 描画先から読み戻す側は、
  // texture.renderTarget の textures から添字を引く。
  private get basicTextures(): readonly THREE.Texture[] {
    return [this.diffuse, this.directSpecular, this.farSpecular];
  }

  // このフレームに書く全テクスチャを 0 でクリアする。前のフレームに書いて今は書かないテクスチャも、ここで 1 度だけ
  // 空へ戻す。一度に結べる枚数に収まるよう分けて発行する。
  private clearBound(directionalSlotCount: number | null): void {
    const bound = directionalSlotCount === null ? this.basicTextures : [
      ...this.basicTextures, this.undirectedFarDiffuse, ...this.directionalPlanetDiffuse.slice(0, directionalSlotCount),
    ];
    // 結ぶ予定の全枚と、前のフレームの全枚の和。
    const clearing = [...new Set([...bound, ...this.previousBound])];
    // 1 度に結べる枚数ずつ、結んでクリアだけの描画を発行する。
    for (let from = 0; from < clearing.length; from += MAX_ATTACHMENTS) {
      this.renderer.setRenderTarget(this.pool.select(clearing.slice(from, from + MAX_ATTACHMENTS)));
      this.gpu.beginPass(GPU_PASS.lighting);
      this.renderer.render(this.clearScene, this.quad.camera);
    }
    this.previousBound = bound;
  }

  // source が積むテクスチャ(拡散・その鏡面・分けるときは遠方の拡散の 1 枚)を結んだ描画先。遠方の拡散は、
  // 向きを見るスロットは自分の描画先へ、環境光と向きを見ないスロットは和の描画先へ書く。
  private targetOf(source: LightSource, directionalSlotCount: number | null): THREE.RenderTarget {
    if (source.specularReach === 'direct') return this.pool.select([this.diffuse, this.directSpecular]);
    if (directionalSlotCount === null) return this.pool.select([this.diffuse, this.farSpecular]);
    const slot = this.planetSlots.indexOf(source);
    const farDiffuse = slot >= 0 && slot < directionalSlotCount
      ? this.directionalPlanetDiffuse[slot]! : this.undirectedFarDiffuse;
    return this.pool.select([this.diffuse, this.farSpecular, farDiffuse]);
  }
}
