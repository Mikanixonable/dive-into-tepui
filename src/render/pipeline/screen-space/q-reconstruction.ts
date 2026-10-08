// 低解像度の補正を joint-bilateral で均し、全解像度へ確率的に拡大する再構成処理。
import type * as THREE from 'three/webgpu';
import {
  If, Loop, bool, clamp, cos, exp2, float, floor, ivec2, length, max, round, screenSize, screenUV, select, sin, sqrt,
  textureLoad, vec2, vec3,
} from 'three/tsl';
import { SurfaceWeight, type SurfaceReceiver } from './surface-weight';
import type { ScanSurfaces, Texel } from './texel-surface';
import type { FloatNode, Vec2Node, Vec3Node } from '../../tsl-types';

const SPARSE_RADIUS = 12 / Math.SQRT2;
const DENSE_RADIUS = 1;
const DENSE_SIGMA = 1;
const UPSAMPLE_OFFSETS = [[0, 0], [1, 0], [0, 1], [1, 1]] as const;
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// 旧 7 の再構成。タップ数は実験で調整できるが、半径・確率的拡大の定義は固定する。
export class QReconstruction {
  public constructor(
    private readonly weight: SurfaceWeight, private readonly surfaces: ScanSurfaces,
    private readonly fullSize: Vec2Node, private readonly scanSize: Vec2Node,
  ) {}

  public sparseDenoised(source: THREE.Texture, rotation: FloatNode, tapCount: number): Vec3Node {
    const texel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const receiver = this.weight.receiverAt(this.surfaces.scanSurfaceAt(texel));
    const radius = this.scanSize.x.div(this.fullSize.x).mul(SPARSE_RADIUS).toVar();
    const angle = rotation.mul(2 * Math.PI).toVar();
    const sum = vec3(0).toVar();
    const total = float(0).toVar();
    Loop(tapCount, ({ i }) => {
      const rho = radius.mul(sqrt(float(i).mul(1 / Math.max(tapCount - 1, 1))));
      const theta = float(i).mul(GOLDEN_ANGLE).add(angle);
      const tap = this.clampToScan(texel.add(ivec2(round(vec2(cos(theta), sin(theta)).mul(rho))))).toVar();
      this.addTap(receiver, source, tap, sum, total, null);
    });
    return select(total.greaterThan(1e-6), sum.div(max(total, 1e-6)), vec3(0));
  }

  public denseDenoised(source: THREE.Texture): Vec3Node {
    const texel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const receiver = this.weight.receiverAt(this.surfaces.scanSurfaceAt(texel));
    const sum = vec3(0).toVar();
    const total = float(0).toVar();
    const side = 2 * DENSE_RADIUS + 1;
    Loop(side * side, ({ i }) => {
      const dx = i.mod(side).sub(DENSE_RADIUS).toVar();
      const dy = i.div(side).sub(DENSE_RADIUS).toVar();
      const tap = this.clampToScan(texel.add(ivec2(dx, dy))).toVar();
      const spatial = float(dx.mul(dx).add(dy.mul(dy))).mul(0.5 * Math.LOG2E / (DENSE_SIGMA * DENSE_SIGMA));
      this.addTap(receiver, source, tap, sum, total, spatial);
    });
    return select(total.greaterThan(1e-6), sum.div(max(total, 1e-6)), vec3(0));
  }

  public stochasticUpsampled(source: THREE.Texture, choice: FloatNode): Vec3Node {
    const pixel = ivec2(floor(screenUV.mul(screenSize))).toVar();
    const receiver = this.weight.receiverAt(this.weight.surfaceAt(pixel));
    const span = ivec2(this.fullSize).mul(2).toVar();
    const shifted = ivec2(pixel).mul(2).add(1).mul(ivec2(this.scanSize)).add(ivec2(this.fullSize)).toVar();
    const quotient = shifted.div(span).toVar();
    const corner = quotient.sub(1).toVar();
    const fraction = vec2(shifted.sub(quotient.mul(span))).div(vec2(span)).toVar();
    const taps = UPSAMPLE_OFFSETS.map(([dx, dy]) => {
      const tap = this.clampToScan(corner.add(ivec2(dx, dy))).toVar();
      const surface = this.surfaces.scanSurfaceAt(tap);
      const exponent = this.weight.exponentOf(receiver, surface, float(1), float(Math.PI / 9));
      const bilinear = (dx === 0 ? fraction.x.oneMinus() : fraction.x)
        .mul(dy === 0 ? fraction.y.oneMinus() : fraction.y);
      return { tap, weight: exp2(exponent.negate()).mul(bilinear).toVar() };
    });
    const total = float(0).toVar();
    for (const { weight } of taps) total.addAssign(weight);
    const threshold = choice.mul(255 / 256).add(0.5 / 256).mul(total).toVar();
    const chosen = ivec2(taps[taps.length - 1]!.tap).toVar();
    const pending = bool(true).toVar();
    const cumulative = float(0).toVar();
    for (const { tap, weight } of taps) {
      cumulative.addAssign(weight);
      If(pending.and(cumulative.greaterThan(threshold)), () => {
        chosen.assign(tap);
        pending.assign(bool(false));
      });
    }
    return select(total.greaterThan(1e-6), textureLoad(source, chosen).rgb, vec3(0));
  }

  private addTap(
    receiver: SurfaceReceiver, source: THREE.Texture, tap: Texel,
    sum: Vec3Node, total: FloatNode, spatial: FloatNode | null,
  ): void {
    const surface = this.surfaces.scanSurfaceAt(tap);
    const distance = max(
      length(vec2(surface.texel.sub(receiver.texel))), 1,
    );
    const exponent = this.weight.exponentOf(receiver, surface, distance, float(Math.PI / 9));
    const weight = exp2(exponent.negate().sub(spatial ?? float(0))).toVar();
    sum.addAssign(textureLoad(source, tap).rgb.mul(weight));
    total.addAssign(weight);
  }

  private clampToScan(texel: Texel): Texel {
    return ivec2(clamp(vec2(texel), vec2(0), this.scanSize.sub(1)));
  }
}
