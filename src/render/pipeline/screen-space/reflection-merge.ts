// 縮小列の段を粗い側から合流し、段ごとの映り込みを 2 倍に拡大する。
// 各親段は端数を見るテントの 3 × 3 で読み、代表面の類似度で重み付けする。
// 代表面で選んだ均す段に応じて、自分の段の平均と親段の値を混ぜる。
// 確からしさは拡散補正項の合流と同じく、寄与した親面の重みの平均で求める。
import * as THREE from 'three/webgpu';
import { QuadMesh, type WebGPURenderer } from 'three/webgpu';
import {
  Fn, If, ceil, clamp, float, floor, ivec2, length, max, mrt, screenCoordinate, screenUV, select, struct, textureLoad,
  uniform, vec2, vec4,
} from 'three/tsl';
import { GPU_PASS, type GpuTimings } from '../../gpu-timings';
import { specularLobeHalfWidthOf } from '../lighting/ggx';
import { compileInto } from '../compile-into';
import { phaseTentWeight } from './band-pyramid';
import { ReflectionReduction, representativeSurfaceOf, sameSurfaceWeight } from './reflection-reduction';
import { reflectionDenoiseLevelOf } from './reflection-denoise-level';
import { NO_REFLECTION_ROUGHNESS } from './reflection-trace';
import type { FloatNode, Vec2Node, Vec2Uniform, Vec3Node, Vec4Node } from '../../tsl-types';

// 合流後の重み付き色と重みを格納する添付名。
const MERGED_WEIGHTED = 'reflectionMergedWeighted';
// 合流後の重み付き距離と当たり距離を格納する添付名。
const MERGED_DISTANCE = 'reflectionMergedDistance';
// 合流後の各段に保存する値。
const MergedReflection = struct({ weighted: 'vec4', distance: 'float', hitDistance: 'float' }, 'MergedReflection');

// 合流列の 2 つの添付を持つ描画先を作る。
function atlasTarget(): THREE.RenderTarget {
  const target = new THREE.RenderTarget(1, 1, {
    count: 2, depthBuffer: false, samples: 0, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter,
  });
  // 色と距離を別の添付へ記録する。
  target.textures[0]!.name = MERGED_WEIGHTED;
  target.textures[0]!.format = THREE.RGBAFormat;
  target.textures[0]!.type = THREE.HalfFloatType;
  target.textures[1]!.name = MERGED_DISTANCE;
  target.textures[1]!.format = THREE.RGFormat;
  target.textures[1]!.type = THREE.HalfFloatType;
  return target;
}

// 合流列の画素値。
interface MergedTexel {
  readonly weighted: Vec4Node;
  readonly distance: FloatNode;
  readonly hitDistance: FloatNode;
}

// 親段から読み取った値と、寄与面の確からしさ。
interface ParentReflection extends MergedTexel {
  readonly confidence: FloatNode;
}

// 縮小列の粗い段から順に親の値を合流し、各段の結果を atlas に描く。
export class ReflectionMerge {
  // 段ごとの値を交互に書く描画先。
  private readonly atlases = [atlasTarget(), atlasTarget()] as const;
  // 描画先の寸法を保持する。
  private readonly atlasSizes = [new THREE.Vector2(), new THREE.Vector2()] as const;
  // 描画バッファの寸法 [px]。
  private readonly fullSize: Vec2Uniform = uniform(new THREE.Vector2(1, 1));
  // このフレームに合流する最も粗い段。
  private readonly lastLevel = uniform(1);
  // 合流する段ごとの描画マテリアル。
  private readonly materials: readonly THREE.MeshBasicNodeMaterial[];
  // 段を描く四角形。
  private readonly quad = new QuadMesh();

  // 描画先と段ごとの合流シェーダを構築する。
  public constructor(
    private readonly renderer: WebGPURenderer, private readonly reduction: ReflectionReduction,
    private readonly gpu: GpuTimings, private readonly focalLength: FloatNode, private readonly coarsestLevel: FloatNode,
    private readonly distanceLevel: FloatNode, levelCount: number,
  ) {
    // 各段の結果を、段番号で決まる合流シェーダに結び付ける。
    this.materials = Array.from({ length: levelCount - 1 }, (_, index) => {
      const merged = this.mergedAt(index + 1);
      const material = new THREE.MeshBasicNodeMaterial({
        depthTest: false, depthWrite: false, transparent: true, blending: THREE.NoBlending,
      });
      material.mrtNode = mrt({
        [MERGED_WEIGHTED]: merged.get('weighted') as Vec4Node,
        [MERGED_DISTANCE]: vec4(merged.get('distance') as FloatNode, merged.get('hitDistance') as FloatNode, 0, 1),
      });
      return material;
    });
  }

  // 粗い段から段 1 までを描画する。
  public render(width: number, height: number, lastLevel: number): void {
    this.prepare(width, height, lastLevel);
    this.renderer.autoClear = false;
    // 粗い段を先に描き、次の細かい段がその結果を読めるようにする。
    for (let level = lastLevel; level >= 1; level--) {
      const atlas = this.atlases[level % 2]!;
      atlas.viewport.copy(this.reduction.viewportAt(level));
      this.renderer.setRenderTarget(atlas);
      this.quad.material = this.materials[level - 1]!;
      this.gpu.beginPass(GPU_PASS.reflectionMerge);
      this.quad.render(this.renderer);
    }
    this.renderer.autoClear = true;
  }

  // 合流シェーダを描画先へ事前コンパイルする。
  public async compile(width: number, height: number, lastLevel: number): Promise<void> {
    this.prepare(width, height, lastLevel);
    for (const [index, material] of this.materials.entries()) {
      this.quad.material = material;
      await compileInto(this.renderer, this.atlases[(index + 1) % 2]!, this.quad, this.quad.camera);
    }
  }

  // 保持している GPU 資源を解放する。
  public dispose(): void {
    for (const material of this.materials) material.dispose();
    for (const atlas of this.atlases) atlas.dispose();
  }

  // 受け手の全解像度画素から段 level の合流値を読む。**Fn の中から呼ぶこと。**
  public readAt(level: number, point: Vec3Node, normal: Vec3Node, width: FloatNode): ParentReflection {
    const span = this.reduction.spanAt(level);
    const position = screenUV.mul(this.fullSize).div(span).sub(0.5).toVar();
    const center = position.add(0.5).floor().toVar();
    const fraction = position.sub(center).toVar();
    return this.readLevelAt(level, center, fraction, point, normal, width);
  }

  // 段 level の各画素について親の値を合流するシェーダを作る。
  private mergedAt(level: number): THREE.Node {
    return Fn(() => {
      const q = floor(screenCoordinate).sub(this.reduction.originAt(level)).toVar();
      const own = this.reduction.reducedLevelTexelAt(level, q);
      const covered = own.covered.y.toVar();
      const hasSurface = covered.greaterThan(1e-4);
      const weighted = vec4(0).toVar();
      const distance = float(0).toVar();
      const hitDistance = float(0).toVar();
      const highest = level === this.materials.length;
      // 映り込みの出ない画素は、最後のパスも読まないので計算しない。
      If(hasSurface.and(own.surface.w.lessThan(NO_REFLECTION_ROUGHNESS)), () => {
        const a = own.weighted.div(max(covered, 1e-4)).toVar();
        const ownDistance = own.covered.x.div(max(covered, 1e-4)).toVar();
        if (highest) {
          weighted.assign(a);
          distance.assign(ownDistance);
          If(float(level).greaterThanEqual(this.distanceLevel).and(a.a.greaterThan(0)), () => {
            hitDistance.assign(ownDistance.div(max(a.a, 1e-6)));
          });
        } else {
          const child = this.reduction.reducedChildAt(level, q);
          const width = specularLobeHalfWidthOf(own.surface.w).toVar();
          const parent = this.parentAt(level, q, child.point, child.normal, width);
          const ownHasDistance = float(level).greaterThanEqual(this.distanceLevel).and(a.a.greaterThan(0));
          If(ownHasDistance, () => hitDistance.assign(ownDistance.div(max(a.a, 1e-6))));
          // いちばん粗い段より粗い段は、このフレームに書いていない。
          If(ownHasDistance.not().and(this.lastLevel.greaterThan(level)), () => hitDistance.assign(parent.hitDistance));
          const viewDir = child.point.negate().div(max(length(child.point), 1e-6));
          const denoiseLevel = reflectionDenoiseLevelOf(
            child.point, child.normal, width, viewDir, hitDistance, this.focalLength, this.coarsestLevel,
          );
          const mix = select(this.lastLevel.greaterThan(level), clamp(denoiseLevel.sub(level), 0, 1), float(0))
            .mul(parent.confidence);
          weighted.assign(a.mul(float(1).sub(mix)).add(parent.weighted.mul(mix)));
          distance.assign(ownDistance.mul(float(1).sub(mix)).add(parent.distance.mul(mix)));
        }
      });
      return MergedReflection(weighted, distance, hitDistance);
    })();
  }

  // 読む段・中心・端数と受け手の面から、3 × 3 の合流値を求める。**Fn の中から呼ぶこと。**
  private readLevelAt(
    level: number, center: Vec2Node, fraction: Vec2Node, point: Vec3Node, normal: Vec3Node, width: FloatNode,
  ): ParentReflection {
    const size = ceil(this.fullSize.div(this.reduction.spanAt(level))).toVar();
    // 画面内の周辺画素を、端数を見るテントと代表面の類似度で重み付けして集める。
    const sum = vec4(0).toVar();
    const sumDistance = float(0).toVar();
    const sumHit = float(0).toVar();
    const total = float(0).toVar();
    const confidenceSum = float(0).toVar();
    for (const dy of [-1, 0, 1]) for (const dx of [-1, 0, 1]) {
      const texel = center.add(vec2(dx, dy)).toVar();
      const inside = texel.x.greaterThanEqual(0).and(texel.y.greaterThanEqual(0))
        .and(texel.x.lessThan(size.x)).and(texel.y.lessThan(size.y));
      If(inside, () => {
        const surface = representativeSurfaceOf(this.reduction.reducedLevelTexelAt(level, texel).surface);
        const surfaceWeight = sameSurfaceWeight(surface, point, normal, width);
        const share = phaseTentWeight(dx as -1 | 0 | 1, fraction.x)
          .mul(phaseTentWeight(dy as -1 | 0 | 1, fraction.y)).mul(surfaceWeight).toVar();
        const merged = this.mergedTexelAt(level, texel);
        sum.addAssign(merged.weighted.mul(share));
        sumDistance.addAssign(merged.distance.mul(share));
        sumHit.addAssign(merged.hitDistance.mul(share));
        total.addAssign(share);
        confidenceSum.addAssign(share.mul(surfaceWeight));
      });
    }
    // 合計重みで各量を平均し、親面の類似度の平均を確からしさにする。
    const valid = total.greaterThan(0);
    const average = select(valid, sum.div(max(total, 1e-6)), vec4(0));
    return {
      weighted: average, distance: select(valid, sumDistance.div(max(total, 1e-6)), float(0)),
      hitDistance: select(valid, sumHit.div(max(total, 1e-6)), float(0)),
      confidence: select(valid, confidenceSum.div(max(total, 1e-6)), float(0)),
    };
  }

  // 段 level の親画素を、2 倍拡大時の中心と端数から読む。
  private parentAt(level: number, q: Vec2Node, point: Vec3Node, normal: Vec3Node, width: FloatNode): ParentReflection {
    const parentLevel = level + 1;
    const center = floor(q.div(2)).toVar();
    const parity = q.mod(2);
    const fraction = vec2(
      select(parity.x.equal(0), float(-0.25), float(0.25)),
      select(parity.y.equal(0), float(-0.25), float(0.25)),
    );
    return this.readLevelAt(parentLevel, center, fraction, point, normal, width);
  }

  // 段 level の合流値を atlas から読む。
  private mergedTexelAt(level: number, texel: Vec2Node): MergedTexel {
    const textures = this.atlases[level % 2]!.textures;
    const atlasTexel = ivec2(texel.add(this.reduction.originAt(level)));
    const weighted = textureLoad(textures[0]!, atlasTexel).toVar();
    const distances = textureLoad(textures[1]!, atlasTexel).rg;
    return { weighted, distance: distances.x, hitDistance: distances.y };
  }

  // 段の atlas 配置と描画寸法を設定する。
  private prepare(width: number, height: number, lastLevel: number): void {
    this.fullSize.value.set(width, height);
    this.lastLevel.value = lastLevel;
    // 段ごとの矩形を描画先別に集計する。
    for (const size of this.atlasSizes) size.set(0, 0);
    for (let level = 1; level <= this.materials.length; level++) {
      const size = this.atlasSizes[level % 2]!;
      const viewport = this.reduction.viewportAt(level);
      size.set(Math.max(size.x, viewport.x + viewport.z), Math.max(size.y, viewport.w));
    }
    for (const [index, atlas] of this.atlases.entries()) {
      const size = this.atlasSizes[index]!;
      if (atlas.width !== size.x || atlas.height !== size.y) atlas.setSize(size.x, size.y);
    }
  }
}
