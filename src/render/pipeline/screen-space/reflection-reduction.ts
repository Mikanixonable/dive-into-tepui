// 均す前の映り込みの縮小列。段 k の画素は描画画素 2^k 個四方をまとめ、そこに写る代表の面に載る描画画素についての
// w × I・w・w × d の和と被覆率を持つ。段ごとの値と代表の面を読む口を持つ。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, abs, ceil, clamp, dot, float, floor, getViewPosition, ivec2, length, max, min, mrt, screenCoordinate,
  select, smoothstep, struct, textureLoad, uniform, vec2, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { octDecodeNormal, type GBufferPass } from '../gbuffer';
import { specularLobeHalfWidthOf } from '../lighting/ggx';
import { viewRayAt } from '../view-ray';
import { compileInto } from '../compile-into';
import { rayThicknessAt } from './reflection-trace';
import type { ScreenSpaceReflection } from './screen-space-reflection';
import { stageMaterial } from './screen-space-stage';
import type { BoolNode, FloatNode, Mat4Uniform, Vec2Node, Vec2Uniform, Vec3Node, Vec4Node } from '../../tsl-types';

// 同じ面とみなす重みの区間。重みは full の側で 1、none の側で 0 で、あいだをなめらかにつなぐ — 二値の判定は、境をまたぐ
// 受け手どうしで値を跳ばす。
// 法線どうしの余弦(約 18°〜32°)。曲面の隣り合う画素を同じ面に残し、稜の向こうの面を分ける。
const SAME_SURFACE_NORMAL_COSINE = { full: 0.95, none: 0.85 } as const;
// 代表の平面までの隔たりの、点の奥行きの ray thickness に対する比。
const SAME_SURFACE_PLANE_OFFSET = { full: 0.5, none: 1 } as const;
// 鏡面ローブの半幅の差の、大きいほうの半幅に対する比。粗さが 1 割違う材質(半幅は約 2 割違う)を同じ面に残し、2 割違う
// 材質(半幅は 3 割以上違う)を分ける。
const SAME_SURFACE_LOBE_WIDTH_DIFFERENCE = { full: 0.2, none: 0.3 } as const;

// 縮小列の段の画素 1 つ。どの量も、代表の面に載る描画画素についての和を、段の画素が覆う描画画素の数で割ったもの。
// weighted は rgb = w × I の和、a = w の和。covered は x = w × d の和 [m]、y = 被覆率(代表の面に載る描画画素の割合)。
// surface は代表の面で、xy = 法線の octahedral 符号、z = 平面の原点からの距離 n·P [m](view 空間)、w = 知覚的粗さ。
// 「載る」は同じ面とみなす重みを掛けた量で、0..1 の割合で載る。
const ReflectionLevelTexel = struct(
  { weighted: 'vec4', covered: 'vec2', surface: 'vec4' }, 'ReflectionLevelTexel',
);
export interface LevelTexel {
  readonly weighted: Vec4Node;
  readonly covered: Vec2Node;
  readonly surface: Vec4Node;
}
// 法線の変化率を測る近傍の画素。coverage が 0 なら面が写っていない。
interface NormalCoverage {
  readonly normal: Vec3Node;
  readonly coverage: FloatNode;
}

// 縮小列の段の描画先のテクスチャの名前。MRT の出力と結び付く。
const LEVEL_WEIGHTED = 'reflectionLevelWeighted';
const LEVEL_COVERED = 'reflectionLevelCovered';
const LEVEL_SURFACE = 'reflectionLevelSurface';
// 測れない近傍の法線の差。単位法線どうしの差はこの値を超えない。
const UNMEASURED_NORMAL_DIFFERENCE = 2;

// 縮小列の段 1 以降を詰める描画先。添付は LevelTexel の weighted・covered・surface の順で、平面の距離は km 規模の面でも
// 半精度の上限を超えないよう 32bit 浮動小数で持つ。32bit の添付はフィルタできないので、textureLoad で読むこと。
function atlasTarget(): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count: 3, depthBuffer: false, samples: 0, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  // 添付ごとの名前と形式。名前は MRT の出力と結び付く。
  const formats = [
    [LEVEL_WEIGHTED, THREE.RGBAFormat, THREE.HalfFloatType],
    [LEVEL_COVERED, THREE.RGFormat, THREE.HalfFloatType],
    [LEVEL_SURFACE, THREE.RGBAFormat, THREE.FloatType],
  ] as const;
  for (const [index, [name, format, type]] of formats.entries()) {
    const attachment = target.textures[index]!;
    attachment.name = name;
    attachment.format = format;
    attachment.type = type;
  }
  return target;
}

// 段の画素を全画面で書くマテリアル。出力は mrtNode へ置く。
function levelMaterial(mrtNode: ReturnType<typeof mrt>): THREE.MeshBasicNodeMaterial {
  const material = stageMaterial();
  material.mrtNode = mrtNode;
  return material;
}

// 縮小列の段 1 以降の 1 段。段は atlas の中の矩形 viewport を占め、origin はその左上 [px]、span は段の画素 1 つが覆う
// 描画画素の一辺の数。
interface ReductionLevel {
  readonly atlas: THREE.RenderTarget;
  readonly viewport: THREE.Vector4;
  readonly origin: Vec2Uniform;
  readonly span: number;
  readonly material: THREE.MeshBasicNodeMaterial;
}

// 縮小列の段の画素がまとめる、1 つ細かい段の画素。inside はその画素が画面の中にあるか、point はその画素に写る代表の
// 面の点(view 空間)、normal はその面の単位法線(view 空間)。
interface ReductionChild {
  readonly inside: BoolNode;
  readonly texel: LevelTexel;
  readonly point: Vec3Node;
  readonly normal: Vec3Node;
}

// 同じ面とみなす判定に使う形へ戻した代表の面。normal は単位法線(view 空間)、offset は平面の原点からの距離 n·P [m]、
// lobeHalfWidth は鏡面ローブの半幅 [rad]。
interface RepresentativeSurface {
  readonly normal: Vec3Node;
  readonly offset: FloatNode;
  readonly lobeHalfWidth: FloatNode;
}

// 縮小列の 2 × 2 の子の、左上の子からのずれ。
const CORNERS = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;

// LevelTexel の surface の符号を戻した代表の面。**Fn の中から呼ぶこと。**
export function representativeSurfaceOf(code: Vec4Node): RepresentativeSurface {
  return {
    normal: octDecodeNormal(code.xy).toVar(),
    offset: code.z,
    lobeHalfWidth: specularLobeHalfWidthOf(code.w).toVar(),
  };
}

// 点 point(view 空間)に載る、法線 normal・鏡面ローブの半幅 lobeHalfWidth の面を、代表の面 surface と同じ面とみなす
// 重み(0..1)。法線の向き、代表の平面からの隔たり、鏡面ローブの半幅の近さの重みを掛けたもの。**Fn の中から呼ぶこと。**
export function sameSurfaceWeight(
  surface: RepresentativeSurface, point: Vec3Node, normal: Vec3Node, lobeHalfWidth: FloatNode,
): FloatNode {
  const facing = smoothstep(
    SAME_SURFACE_NORMAL_COSINE.none, SAME_SURFACE_NORMAL_COSINE.full, dot(surface.normal, normal),
  );
  // 平面からの隔たりは、点の奥行きの ray thickness を目盛りに測る。
  const offset = abs(dot(surface.normal, point).sub(surface.offset)).div(max(rayThicknessAt(point.z), 1e-6));
  const onPlane = float(1).sub(smoothstep(SAME_SURFACE_PLANE_OFFSET.full, SAME_SURFACE_PLANE_OFFSET.none, offset));
  // 半幅の差は、大きいほうの半幅を目盛りに測る。
  const width = surface.lobeHalfWidth;
  const difference = abs(width.sub(lobeHalfWidth)).div(max(max(width, lobeHalfWidth), 1e-6));
  const alike = float(1).sub(smoothstep(
    SAME_SURFACE_LOBE_WIDTH_DIFFERENCE.full, SAME_SURFACE_LOBE_WIDTH_DIFFERENCE.none, difference,
  ));
  return facing.mul(onPlane).mul(alike);
}

export class ReflectionReduction {
  // 縮小列の段 1 以降。段 k は levels[k − 1]。
  private readonly levels: readonly ReductionLevel[];
  // 段 k は atlases[k % 2] に入り、前の段を読みながら書く描画先が読む描画先と別になる。段ごとに描画先を持つと、均した
  // 値を書く描画が読むテクスチャの数が段数に比例し、WebGPU がフラグメントシェーダに保証する 16 枚を超える。
  private readonly atlases = [atlasTarget(), atlasTarget()] as const;
  // atlases の寸法 [px]。毎フレーム確保しないよう持っておく。
  private readonly atlasSizes = [new THREE.Vector2(), new THREE.Vector2()] as const;
  private readonly quad = new QuadMesh();
  // QuadMesh は固定直交カメラで描かれるため、実カメラの逆射影行列は毎フレーム自前で書き込む。
  private readonly projectionInverse: Mat4Uniform = uniform(new THREE.Matrix4());
  // 描画バッファの解像度 [px]。
  private readonly fullSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));

  // reflection は均す前の映り込みを読む先。段 0(均す前の映り込みと G バッファそのもの)の上に、段 1 から
  // 段 levelCount − 1 までを組む。
  public constructor(
    private readonly renderer: WebGPURenderer, private readonly gbuffer: GBufferPass,
    private readonly reflection: ScreenSpaceReflection, private readonly gpu: GpuTimings, levelCount: number,
  ) {
    // 細かい段から順に組む。段 k は段 k − 1 を読む。
    const levels: ReductionLevel[] = [];
    for (let index = 1; index < levelCount; index++) {
      const origin: Vec2Uniform = uniform(new THREE.Vector2());
      const span = 2 ** index;
      const texel = this.reducedTexel(levels[index - 2] ?? null, origin, span);
      levels.push({
        atlas: this.atlases[index % 2]!,
        viewport: new THREE.Vector4(),
        origin,
        span,
        material: levelMaterial(mrt({
          [LEVEL_WEIGHTED]: texel.get('weighted') as Vec4Node,
          [LEVEL_COVERED]: vec4(texel.get('covered') as Vec2Node, 0, 1),
          [LEVEL_SURFACE]: texel.get('surface') as Vec4Node,
        })),
      });
    }
    this.levels = levels;
  }

  // 1 フレームぶんの縮小列を、段 1 から段 lastLevel まで書く。均す前の映り込みを書いた後に、G バッファと同じ寸法
  // width × height で呼ぶ。camera からは深度から位置を復元する行列を引き直す。
  public render(camera: THREE.Camera, width: number, height: number, lastLevel: number): void {
    this.prepare(camera, width, height);
    // atlas は他の段の矩形を残すので、描く前に消さない。
    this.renderer.autoClear = false;
    for (const level of this.levels.slice(0, lastLevel)) {
      level.atlas.viewport.copy(level.viewport);
      this.renderer.setRenderTarget(level.atlas);
      this.quad.material = level.material;
      this.gpu.beginPass(GPU_PASS.reflectionReduction);
      this.quad.render(this.renderer);
    }
    this.renderer.autoClear = true;
  }

  // 全段のマテリアルを、それぞれの描画先へ事前コンパイルする。
  public async compile(camera: THREE.Camera, width: number, height: number): Promise<void> {
    this.prepare(camera, width, height);
    for (const level of this.levels) {
      this.quad.material = level.material;
      await compileInto(this.renderer, level.atlas, this.quad, this.quad.camera);
    }
  }

  // 保持している GPU 資源を解放する。QuadMesh の板は three が全インスタンスで共有するので解放しない。
  public dispose(): void {
    for (const level of this.levels) level.material.dispose();
    for (const atlas of this.atlases) atlas.dispose();
  }

  // 段 level の atlas 内の原点を返す。
  public originAt(level: number): Vec2Uniform { return this.levels[level - 1]!.origin; }
  // 段 level の描画先の viewport を返す。
  public viewportAt(level: number): THREE.Vector4 { return this.levels[level - 1]!.viewport; }
  // 段 level の画素が覆う描画画素の一辺の数を返す。
  public spanAt(level: number): number { return this.levels[level - 1]!.span; }
  // 段 level の画素 texel の縮小値と代表面を返す。**Fn の中から呼ぶこと。**
  public reducedLevelTexelAt(level: number, texel: Vec2Node): LevelTexel {
    return this.levelTexelAt(this.levels[level - 1]!, texel);
  }
  // 段 level の画素 texel の値・点・法線を返す。**Fn の中から呼ぶこと。**
  public reducedChildAt(level: number, texel: Vec2Node): Omit<ReductionChild, 'inside'> {
    return this.childOf(this.levels[level - 1]!, texel);
  }
  // 段 level の画素 texel の代表の面の法線が、描画画素 1 つで回る角 [rad/px]。**Fn の中から呼ぶこと。**
  public normalRateAt(level: number, texel: Vec2Node): FloatNode {
    const reductionLevel = this.levels[level - 1]!;
    return this.normalRateOf(
      texel, reductionLevel.span,
      (position) => {
        const read = this.levelTexelAt(reductionLevel, position);
        return { normal: representativeSurfaceOf(read.surface).normal, coverage: read.covered.y };
      },
    );
  }
  // 描画画素 texel の面の法線が、描画画素 1 つで回る角 [rad/px]。**Fn の中から呼ぶこと。**
  public drawnNormalRateAt(texel: Vec2Node): FloatNode {
    return this.normalRateOf(texel, 1, (position) => {
      const pixel = ivec2(position);
      const depth = textureLoad(this.gbuffer.depthTexture, pixel).r;
      const code = textureLoad(this.gbuffer.normalTexture, pixel).rg;
      return { normal: octDecodeNormal(code), coverage: select(depth.greaterThan(0), float(1), float(0)) };
    });
  }

  // 近傍の法線の差から、画素の一辺あたりに法線が回る角を返す。輪郭の向こうの面を数えないよう、軸ごとに両側の小さいほうを
  // 取る。**Fn の中から呼ぶこと。**
  private normalRateOf(
    texel: Vec2Node, span: number, read: (position: Vec2Node) => NormalCoverage,
  ): FloatNode {
    const size = ceil(this.fullSize.div(span)).toVar();
    const center = read(texel);
    // 隣の画素との法線の差。測れない隣は UNMEASURED_NORMAL_DIFFERENCE を返す。
    const difference = (dx: number, dy: number): FloatNode => {
      const neighbor = texel.add(vec2(dx, dy)).toVar();
      const inside = neighbor.x.greaterThanEqual(0).and(neighbor.y.greaterThanEqual(0))
        .and(neighbor.x.lessThan(size.x)).and(neighbor.y.lessThan(size.y));
      const adjacent = read(clamp(neighbor, vec2(0), size.sub(1)));
      const valid = inside.and(adjacent.coverage.greaterThan(1e-4));
      return select(valid, length(adjacent.normal.sub(center.normal)), float(UNMEASURED_NORMAL_DIFFERENCE));
    };
    // 1 つの軸の両側の差から、その軸の回転を求める。両側とも測れなければ 0。
    const axisRate = (first: FloatNode, second: FloatNode): FloatNode => {
      const smaller = min(first, second);
      return select(smaller.lessThan(UNMEASURED_NORMAL_DIFFERENCE), smaller, float(0));
    };
    return max(axisRate(difference(-1, 0), difference(1, 0)), axisRate(difference(0, -1), difference(0, 1))).div(span);
  }

  // 縮小列の段の画素(ReflectionLevelTexel)。finer は 1 つ細かい段で、段 1 では null(段 0)。origin は書く段の矩形の
  // 左上、span は書く段の画素 1 つが覆う描画画素の一辺の数。
  private reducedTexel(finer: ReductionLevel | null, origin: Vec2Uniform, span: number): THREE.Node {
    return Fn(() => {
      const children = this.childrenOf(finer, origin, span);
      // 代表の面は、被覆率のいちばん大きい子の面。同じなら手前の子の面。左上の子は必ず画面の中にある。
      const surface = children[0]!.texel.surface.toVar();
      const coverage = children[0]!.texel.covered.y.toVar();
      const nearestZ = children[0]!.point.z.toVar();
      for (const child of children.slice(1)) {
        const childCoverage = child.texel.covered.y;
        const nearer = childCoverage.equal(coverage).and(child.point.z.greaterThan(nearestZ));
        If(child.inside.and(childCoverage.greaterThan(coverage).or(nearer)), () => {
          surface.assign(child.texel.surface);
          coverage.assign(childCoverage);
          nearestZ.assign(child.point.z);
        });
      }
      // 子を、代表の面に載る重みを掛けて足し、段の画素が覆う描画画素の数で割る。
      const representative = representativeSurfaceOf(surface);
      const weighted = vec4(0).toVar();
      const covered = vec2(0).toVar();
      for (const child of children) {
        If(child.inside, () => {
          const childWidth = specularLobeHalfWidthOf(child.texel.surface.w);
          const share = sameSurfaceWeight(representative, child.point, child.normal, childWidth).toVar();
          weighted.addAssign(child.texel.weighted.mul(share));
          covered.addAssign(child.texel.covered.mul(share));
        });
      }
      return ReflectionLevelTexel(weighted.mul(0.25), covered.mul(0.25), surface);
    })();
  }

  // 書く段の描いている画素がまとめる、1 つ細かい段 finer の 2 × 2 の画素。origin と span は reducedTexel と同じ。
  // **Fn の中から呼ぶこと。**
  private childrenOf(finer: ReductionLevel | null, origin: Vec2Uniform, span: number): readonly ReductionChild[] {
    // 描いている画素の、矩形の中の位置の 2 倍が左上の子。細かい段の端の画素は画面の外へはみ出しうる。
    const base = floor(screenCoordinate).sub(origin).mul(2).toVar();
    const finerSize = ceil(this.fullSize.div(span / 2)).toVar();
    return CORNERS.map(([dx, dy]) => {
      const texel = base.add(vec2(dx, dy)).toVar();
      const clamped = min(texel, finerSize.sub(1)).toVar();
      return {
        inside: texel.x.lessThan(finerSize.x).and(texel.y.lessThan(finerSize.y)),
        ...(finer === null ? this.drawnChildAt(clamped) : this.childOf(finer, clamped)),
      };
    });
  }

  // 段 0 の画素 texel(描画画素そのもの)。代表の面はその画素に写る面で、面が写っていれば被覆率は 1。
  // **Fn の中から呼ぶこと。**
  private drawnChildAt(texel: Vec2Node): Omit<ReductionChild, 'inside'> {
    // 画素に写る面の点・法線・粗さ。
    const pixel = ivec2(texel);
    const depth = textureLoad(this.gbuffer.depthTexture, pixel).r.toVar();
    const uv = texel.add(0.5).div(this.fullSize).toVar();
    const point = getViewPosition(uv, depth, this.projectionInverse).toVar();
    const normalCode = textureLoad(this.gbuffer.normalTexture, pixel).rg.toVar();
    const normal = octDecodeNormal(normalCode).toVar();
    const roughness = textureLoad(this.gbuffer.roughnessTexture, pixel).r;
    // 量は均す前の映り込みそのもの。面が写っていない画素は被覆率 0。
    const coverage = select(depth.greaterThan(0), float(1), float(0));
    return {
      texel: {
        weighted: this.reflection.rawWeightedReflectionOfPixel(pixel),
        covered: vec2(this.reflection.rawWeightedDistanceOfPixel(pixel), coverage),
        surface: vec4(normalCode, dot(normal, point), roughness),
      },
      point,
      normal,
    };
  }

  // 段 1 以降の段 level の画素 texel。その画素の点は、画素の中心を通る視線と代表の平面の交点。**Fn の中から呼ぶこと。**
  private childOf(level: ReductionLevel, texel: Vec2Node): Omit<ReductionChild, 'inside'> {
    const read = this.levelTexelAt(level, texel);
    const ray = viewRayAt(this.projectionInverse, texel.add(0.5).mul(level.span).div(this.fullSize));
    const normal = octDecodeNormal(read.surface.xy).toVar();
    // 視線が平面とほぼ平行な画素では、交点を有限の遠い点に留める。
    const along = dot(normal, ray.direction).toVar();
    const safeAlong = select(along.greaterThanEqual(0), max(along, 1e-6), min(along, -1e-6));
    const reach = read.surface.z.sub(dot(normal, ray.origin)).div(safeAlong);
    return { texel: read, point: ray.origin.add(ray.direction.mul(reach)).toVar(), normal };
  }

  // 段 1 以降の段 level の画素 texel の値。**Fn の中から呼ぶこと。**
  private levelTexelAt(level: ReductionLevel, texel: Vec2Node): LevelTexel {
    const [weighted, covered, surface] = level.atlas.textures;
    const atlasTexel = ivec2(texel.add(level.origin)).toVar();
    return {
      weighted: textureLoad(weighted!, atlasTexel).toVar(),
      covered: textureLoad(covered!, atlasTexel).rg.toVar(),
      surface: textureLoad(surface!, atlasTexel).toVar(),
    };
  }

  // 段を atlas の矩形へ並べ、描画先と実カメラの値を書き込む。
  private prepare(camera: THREE.Camera, width: number, height: number): void {
    // 段を atlas の上端に横へ並べる。atlas の幅は並べた段の幅の和、高さはいちばん細かい段の高さ。
    for (const size of this.atlasSizes) size.set(0, 0);
    for (const [index, level] of this.levels.entries()) {
      const atlasSize = this.atlasSizes[(index + 1) % 2]!;
      const levelWidth = Math.max(1, Math.ceil(width / level.span));
      const levelHeight = Math.max(1, Math.ceil(height / level.span));
      level.viewport.set(atlasSize.x, 0, levelWidth, levelHeight);
      level.origin.value.set(atlasSize.x, 0);
      atlasSize.set(atlasSize.x + levelWidth, Math.max(atlasSize.y, levelHeight));
    }
    for (const [index, atlas] of this.atlases.entries()) {
      const { x, y } = this.atlasSizes[index]!;
      if (atlas.width !== x || atlas.height !== y) atlas.setSize(x, y);
    }
    this.fullSize.value.set(width, height);
    this.projectionInverse.value.copy(camera.projectionMatrixInverse);
  }
}
