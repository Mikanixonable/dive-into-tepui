// 積雲が落とす影。受け手から恒星までの光路を連続密度として積分し、カメラの積雲描画と同じ
// cloudDensityAt() を読む。雲頂の交差、coverage の二値化、単一の固定シェルは使わない。
import * as THREE from 'three/webgpu';
import {
  Fn, If, Loop, dot, exp, float, fract, length, max, min, normalize, sqrt, texture, uniform, vec2, vec4,
} from 'three/tsl';
import { sphereMeshUv } from '../../celestial-surface';
import { EMPTY_CLOUD_FIELD } from '../../cloud/cumulus-shape';
import { cloudDensityAt } from '../../cloud/cloud-density';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec3Uniform, Vec4Node } from '../../tsl-types';
import type { SunLight } from '../sun-light';

export interface ShadowCumulus {
  readonly center: THREE.Vector3;
  readonly surfaceRadius: number;
  readonly axes: THREE.Vector3;
  readonly topAltitude: number;
  readonly bodyFromWorld: THREE.Matrix4;
  readonly field: THREE.Texture;
}

const SHADOW_TAPS = 8;
const MAX_LIGHT_PATH = 3e5;

export class CumulusShadow {
  private readonly center: Vec3Uniform;
  private readonly surfaceRadius: FloatUniform;
  private readonly axes: Vec3Uniform;
  private readonly topAltitude: FloatUniform;
  private readonly bodyFromWorld: Mat4Uniform;
  private readonly active: FloatUniform;
  private readonly field = texture(EMPTY_CLOUD_FIELD);

  // 太陽光路を積分するための天体・雲場 uniform を確保する。
  constructor(private readonly sunLight: SunLight) {
    this.center = uniform(new THREE.Vector3());
    this.surfaceRadius = uniform(0);
    this.axes = uniform(new THREE.Vector3(1, 1, 1));
    this.topAltitude = uniform(0);
    this.bodyFromWorld = uniform(new THREE.Matrix4());
    this.active = uniform(0);
  }

  // このフレームに影を落とす雲場を置き直す。null なら影を無効にする。
  set(cumulus: ShadowCumulus | null): void {
    this.active.value = cumulus === null ? 0 : 1;
    if (cumulus === null) return;
    this.center.value.copy(cumulus.center);
    this.surfaceRadius.value = cumulus.surfaceRadius;
    this.axes.value.copy(cumulus.axes);
    this.topAltitude.value = cumulus.topAltitude;
    this.bodyFromWorld.value.copy(cumulus.bodyFromWorld);
    this.field.value = cumulus.field;
  }

  casts(): boolean { return this.active.value > 0; }

  // worldPos から太陽方向へ進む密度を積分する。光路の各タップは雲の内部での位置を直接評価し、
  // 雲頂をまたいだかどうかの判定を持たない。
  // 受け手から太陽までの連続密度を積分した雲の透過率を返す。
  transmittance(worldPos: Vec3Node): FloatNode {
    const sunDir = this.sunLight.directionFrom(worldPos);
    return Fn(() => {
      // 太陽光路を雲の外側までの区間へ変換し、雲場を読む準備をする。
      const result = float(1).toVar();
      If(this.active.greaterThan(0.5), () => {
        const bodyRadius = max(this.surfaceRadius, 1);
        const offset = this.toShellSpace(worldPos.sub(this.center));
        const rayDir = normalize(this.toShellSpace(sunDir));
        const shellRadius = float(1).add(this.topAltitude.div(bodyRadius));
        const along = dot(offset, rayDir);
        const discriminant = shellRadius.mul(shellRadius)
          .sub(dot(offset, offset)).add(along.mul(along));
        const exit = max(sqrt(max(discriminant, 0)).sub(along), 0).mul(bodyRadius);
        const stepLength = min(exit, MAX_LIGHT_PATH).div(SHADOW_TAPS);
        const opticalDepth = float(0).toVar();
        // 各中点の高度で密度を評価し、光学的厚みを積み上げる。
        Loop({ start: 0, end: SHADOW_TAPS, type: 'int', condition: '<' }, ({ i }) => {
          const sample = offset.add(rayDir.mul(stepLength.div(bodyRadius).mul(float(i).add(0.5))));
          const radius = max(length(sample), 1e-6);
          const field = this.fieldAt(sample.div(radius));
          const altitude = radius.sub(1).mul(bodyRadius);
          opticalDepth.addAssign(cloudDensityAt(field, altitude).mul(stepLength));
        });
        result.assign(exp(opticalDepth.negate()));
      });
      return result;
    })();
  }

  private toShellSpace(worldVec: Vec3Node): Vec3Node {
    // 扁平な天体を真球へ伸ばした空間へ、天体固定の向きで写す。
    return this.bodyFromWorld.mul(vec4(worldVec, 0)).xyz.div(this.axes);
  }

  private fieldAt(up: Vec3Node): Vec4Node {
    // 光路上の天体固定方向から、共有する2D雲場を読む。
    const uv = sphereMeshUv(up);
    return this.field.sample(vec2(fract(uv.x), uv.y)).level(float(0));
  }
}
