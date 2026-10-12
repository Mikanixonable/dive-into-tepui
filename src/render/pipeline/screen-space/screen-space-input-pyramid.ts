// 近傍拡散補正の段ごとの代表の面。段 ℓ の画素は走査の 2^ℓ 画素四方を受け持ち、その中で実在する G バッファの画素 1 つを
// 代表に持つ。段 0 の描画先には面の写しと、その面が放つ放射輝度を持つ。段 1 から上は選んだ子の面の値を描画先へ写す。
// 段の寸法の規則もここが持つ。
import * as THREE from 'three/webgpu';
import {
  ceil, float, floor, getViewPosition, ivec2, max, min, screenSize, screenUV, select, textureLoad, vec2, vec4,
} from 'three/tsl';
import { GPU_PASS } from '../../gpu-timings';
import { gbufferTexelOf, texelCenterUV } from './hemisphere-scan';
import { QUAD_OFFSETS } from './band-pyramid';
import { multiOutputMaterial, type ScreenSpaceStage } from './screen-space-stage';
import type { GBufferPass } from '../gbuffer';
import type { ScanSurfaces, Texel, TexelSurface } from './texel-surface';
import type { BoolNode, FloatNode, Mat4Uniform, Vec2Node, Vec4Node } from '../../tsl-types';

// 面のない子の、視点からの深さ [m]。どの面よりも遠い。
const NO_SURFACE_DISTANCE = 1e30;

// 走査の一辺 scanExtent [px] の、段 level の一辺 [段の画素] — 走査の一辺を level 回 ⌈/2⌉ したもの。
export function levelExtent(scanExtent: number, level: number): number {
  return Math.ceil(scanExtent / 2 ** level);
}

// 代表の候補になる子 1 つ — 面があるか hasSurface、視点からの深さ distance(view 空間の −z [m])、面 surface。
export interface RepresentativeCandidate {
  readonly hasSurface: BoolNode;
  readonly distance: FloatNode;
  readonly surface: TexelSurface;
}

// 4 つの子の候補 children(子 0 から順)のうち、面のあるものを視点から近い順に並べた 2 番目の面。面のある子が 1 つなら
// それ、無ければ子 0 の面(面なしとして読まれる)。
export function secondNearest(children: readonly RepresentativeCandidate[]): TexelSurface {
  const [first, second, third, fourth] = children.map(({ hasSurface, distance, surface }) => ({
    distance: select(hasSurface, distance, float(NO_SURFACE_DISTANCE)), surface,
  }));
  // 4 つの深さを並べ替える比較の網の、最も近いものと 2 番目に近いものだけを取る。
  const [nearA, farA] = ordered(first!, second!);
  const [nearB, farB] = ordered(third!, fourth!);
  const [nearest, nearestOfRest] = ordered(nearA, nearB);
  const [runnerUp] = ordered(nearestOfRest, ordered(farA, farB)[0]);
  return pickSurface(runnerUp.distance.lessThan(NO_SURFACE_DISTANCE), runnerUp.surface,
    pickSurface(nearest.distance.lessThan(NO_SURFACE_DISTANCE), nearest.surface, first!.surface));
}

// 視点からの深さ distance [m] と面 surface の組。
interface Ranked {
  readonly distance: FloatNode;
  readonly surface: TexelSurface;
}

// 条件 condition が真なら面 a、偽なら面 b。
function pickSurface(condition: BoolNode, a: TexelSurface, b: TexelSurface): TexelSurface {
  return {
    texel: select(condition, a.texel, b.texel),
    depth: select(condition, a.depth, b.depth),
    encodedNormal: select(condition, a.encodedNormal, b.encodedNormal),
  };
}

// 2 つの組を、視点に近いほう・遠いほうの順に並べる。深さが同じなら a を近いほうとする。
function ordered(a: Ranked, b: Ranked): readonly [Ranked, Ranked] {
  const swapped = b.distance.lessThan(a.distance);
  return [
    { distance: min(a.distance, b.distance), surface: pickSurface(swapped, b.surface, a.surface) },
    { distance: max(a.distance, b.distance), surface: pickSurface(swapped, a.surface, b.surface) },
  ];
}

// 面の位置と法線を持つ描画先。1 枚目は rgba32float で (G バッファの画素の x, y, 素の深度, 0)、2 枚目は rg16float で法線の rg。
// **rgba32float はフィルタできない** — サンプラを Nearest に明示しないと three が線形フィルタを要求し、パイプライン生成が落ちる。
function createSurfaceTarget(name: string, count = 2): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count, type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: false, samples: 0,
    minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  const [locatedTexture, normalTexture] = target.textures;
  locatedTexture!.name = `${name}Located`;
  normalTexture!.name = `${name}Normal`;
  normalTexture!.format = THREE.RGFormat;
  normalTexture!.type = THREE.HalfFloatType;
  return target;
}

// 段 level(1 以上)の代表の面の描画先。
function createLevelSurfaceTarget(level: number): THREE.RenderTarget {
  return createSurfaceTarget(`surfaceRepresentative${level}`);
}

// 段 0 の面の写しと、その面が放つ放射輝度の描画先。3 枚目は rgba16float で照り返しの源。
function createScanSurfaceTarget(): THREE.RenderTarget {
  const target = createSurfaceTarget('scanSurface', 3);
  const radianceTexture = target.textures[2]!;
  radianceTexture!.name = 'surfaceRadiance';
  radianceTexture!.type = THREE.HalfFloatType;
  return target;
}

export class ScreenSpaceInputPyramid implements ScanSurfaces {
  private readonly scanTarget = createScanSurfaceTarget();
  // 段 1 から順の、代表の面を写す描画命令(描画先は段の代表の描画先)。必要になった段まで作る。
  private readonly levels: ScreenSpaceStage[] = [];

  // gbuffer は段 0 の面の写しが深度と法線を読む G バッファ、projectionInverse は実カメラの逆射影行列、fullSize と scanSize は描画
  // バッファと走査の解像度 [px]、representative は走査の画素が受け持つブロックの中の代表の位置 [1/REPRESENTATIVE_STEPS ブロック]
  // (走査の画素ごとに組む式)。
  public constructor(
    private readonly gbuffer: GBufferPass, private readonly projectionInverse: Mat4Uniform,
    private readonly fullSize: Vec2Node, private readonly scanSize: Vec2Node, private readonly representative: Texel,
  ) {}

  // 段 0 の面の写しと、その面が放つ放射輝度 radiance(走査の画素ごとの値。null なら 0)を書く描画命令。マテリアルの
  // 解放は呼び出し側が行う。
  public scanStageOf(radiance: Vec4Node | null): ScreenSpaceStage {
    const material = multiOutputMaterial(this.scanTarget, () => {
      const texel = gbufferTexelOf(floor(screenUV.mul(screenSize)), this.representative, this.fullSize, this.scanSize)
        .toVar();
      return [
        vec4(vec2(texel), textureLoad(this.gbuffer.depthTexture, texel).r, 0),
        vec4(textureLoad(this.gbuffer.normalTexture, texel).rg, 0, 0),
        radiance ?? vec4(0),
      ];
    });
    return { material, target: this.scanTarget, gpuPass: GPU_PASS.nearbyDiffuseScanSurface };
  }

  // 走査の解像度の、面が放つ放射輝度(rgb。SUN_IRRADIANCE_1AU の目盛り)のテクスチャ。
  public get radianceTexture(): THREE.Texture { return this.scanTarget.textures[2]!; }

  // 走査の画素 pixel(整数座標)が表す G バッファの画素の面。段 0 の写しを書いた後に読むこと。
  public scanSurfaceAt(pixel: Texel): TexelSurface {
    return surfaceFromTextures(this.scanTarget.textures, pixel);
  }

  // 段 0 の面の写しのテクスチャ index(0 が (x, y, 素の深度)、1 が法線の rg)。
  public scanSurfaceTexture(index: 0 | 1): THREE.Texture {
    return this.scanTarget.textures[index]!;
  }

  // 段 level の画素 pixel(整数座標)の代表の面。段 1 から上は、その段を書いた後に読むこと。
  public surfaceAt(level: number, pixel: Texel): TexelSurface {
    if (level === 0) return this.scanSurfaceAt(pixel);
    return surfaceFromTextures(this.levelOf(level).target.textures, pixel);
  }

  // 段 level の寸法 [段の画素]。
  public sizeAt(level: number): Vec2Node {
    return ceil(this.scanSize.div(2 ** level));
  }

  // 段 level の画素 pixel(整数座標)が、段の画面の内にあるか。
  public contains(level: number, pixel: Texel): BoolNode {
    const position = vec2(pixel);
    const size = this.sizeAt(level);
    return position.x.greaterThanEqual(0).and(position.y.greaterThanEqual(0))
      .and(position.x.lessThan(size.x)).and(position.y.lessThan(size.y));
  }

  // 段 ℓ + 1 の画素 pixel(整数座標)が受け持つ、段 ℓ の 4 つの子の画素。子 0 は左上。
  public childrenOf(pixel: Texel): Texel[] {
    return QUAD_OFFSETS.map(([dx, dy]) => pixel.mul(2).add(ivec2(dx, dy)));
  }

  // 段 1..levelCount − 1 の代表の面を写す描画命令の列。まだ無い段は、初めて引いたときに作る。
  public stagesUpTo(levelCount: number): ScreenSpaceStage[] {
    return Array.from({ length: levelCount - 1 }, (_, index) => this.levelOf(index + 1));
  }

  // 段 level(1 以上)の代表の描画先の 1 枚目のテクスチャ(rgb = G バッファの画素の x, y と素の深度)。まだ無い段は、このときに作る。
  public representativeTexture(level: number): THREE.Texture {
    return this.levelOf(level).target.texture;
  }

  // 段 0 の写しと、作った段の描画先。
  public get targets(): readonly THREE.RenderTarget[] {
    return [this.scanTarget, ...this.levels.map(({ target }) => target)];
  }

  // 段 0 の写しと作った段の描画先を、走査の寸法 scanWidth × scanHeight から決まる段の寸法へ合わせる。寸法が変わった
  // 描画先だけを確保し直す。
  public setSize(scanWidth: number, scanHeight: number): void {
    if (this.scanTarget.width !== scanWidth || this.scanTarget.height !== scanHeight) {
      this.scanTarget.setSize(scanWidth, scanHeight);
    }
    for (const [index, { target }] of this.levels.entries()) {
      const width = levelExtent(scanWidth, index + 1);
      const height = levelExtent(scanHeight, index + 1);
      if (target.width !== width || target.height !== height) target.setSize(width, height);
    }
  }

  // 段 0 の写しと作った段の描画先とマテリアルを解放する。
  public dispose(): void {
    this.scanTarget.dispose();
    for (const { target, material } of this.levels) {
      target.dispose();
      material.dispose();
    }
  }

  // 段 level の代表の面を写す描画命令。まだ無ければ、段 1 から level までを作る。
  private levelOf(level: number): ScreenSpaceStage {
    while (this.levels.length < level) this.levels.push(this.createLevel(this.levels.length + 1));
    return this.levels[level - 1]!;
  }

  // 段 level の代表の面を写す描画命令を、その描画先とともに作る。
  private createLevel(level: number): ScreenSpaceStage {
    const target = createLevelSurfaceTarget(level);
    const material = multiOutputMaterial(target, () => {
      const { texel, depth, encodedNormal } = this.selectedSurfaceAt(level);
      return [vec4(vec2(texel), depth, 0), vec4(encodedNormal, 0, 0)];
    });
    return { material, target, gpuPass: GPU_PASS.nearbyDiffuseInputPyramid };
  }

  // 段 level の描いている画素の代表 — 段 level − 1 の 4 つの子の代表の面から secondNearest で選んだ面。段の画面の外の子は
  // 面なしとする。**Fn の中から呼ぶこと。**
  private selectedSurfaceAt(level: number): TexelSurface {
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    return secondNearest(this.childrenOf(pixel).map((child) => {
      const surface = this.surfaceAt(level - 1, child);
      const texel = surface.texel.toVar();
      const depth = surface.depth.toVar();
      const encodedNormal = surface.encodedNormal.toVar();
      // 視点からの深さは view 空間の −z で測る — 素の深度の向き(逆深度か)によらない。
      const position = getViewPosition(texelCenterUV(texel, this.fullSize), depth, this.projectionInverse);
      return {
        hasSurface: this.contains(level - 1, child).and(depth.greaterThan(0)),
        distance: position.z.negate(),
        surface: { texel, depth, encodedNormal },
      };
    }));
  }
}

// 位置と法線のテクスチャから画素の面を読む。
function surfaceFromTextures(textures: readonly THREE.Texture[], pixel: Texel): TexelSurface {
  const [locatedTexture, normalTexture] = textures;
  const located = textureLoad(locatedTexture!, pixel);
  return { texel: ivec2(located.xy), depth: located.z, encodedNormal: textureLoad(normalTexture!, pixel).xy };
}
