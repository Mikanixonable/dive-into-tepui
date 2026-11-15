// 大気が散乱した天空光が面へ届ける環境照度。天体の光学から焼いた放射照度表
// (sky-irradiance-tables.ts)を、点の属する天体ごとの (太陽の天頂角余弦・高度) で引き、
// 面の向きの重み (1 + N·up)/2 を掛けて出す。受け取る天体の列は大気パス・直射光と同じ
// — 大気の描画品質がオフなら天空光も届かない。
// **天体の幾何学的遮蔽(影)は掛けない** — 日没後の地表は直射光を失っても空の光を受ける。
// 環境光(AmbientSource)とは別物で、こちらは物理の光: 恒星の色・距離の逆二乗・大気の
// 散乱に従う。
import type * as THREE from 'three/webgpu';
import { PI, dot, max, texture, uniformArray, vec3 } from 'three/tsl';
import { MAX_ATMOSPHERE_BODIES, type AtmosphereBody } from '../../atmosphere';
import type { Vec3Node } from '../../tsl-types';
import type { SunLight } from '../sun-light';
import { AtmosphereSlots } from '../atmosphere-slots';
import {
  skyIrradianceUv, type SkyIrradianceTables,
} from '../sky-irradiance-tables';
import { contributionMaterial, type LightContribution, type LightSource } from './light-source';
import type { ShadingSample } from './shading-sample';

export class SkyLightSource implements LightSource {
  private readonly slots = new AtmosphereSlots();
  // 天体ごとの、表の高度軸の上限 [m] と焼き込み済みの表。
  private readonly altitudeMaxes: number[];
  private readonly altitudeMaxArray: THREE.UniformArrayNode<'float'>;
  private readonly tables: THREE.TextureNode[];
  private cached: THREE.MeshBasicNodeMaterial | null = null;
  // このフレームに天空光を届ける大気があるか。
  private present = false;

  public constructor(
    private readonly sunLight: SunLight,
    private readonly skyTables: SkyIrradianceTables,
  ) {
    this.altitudeMaxes = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => 1);
    this.altitudeMaxArray = uniformArray(this.altitudeMaxes, 'float');
    this.tables = Array.from(
      { length: MAX_ATMOSPHERE_BODIES }, () => texture(skyTables.forEmpty().texture),
    );
  }

  // このフレームの天空光を届ける大気の天体の列(大気パスと同じ列)。空きスロットには
  // 寄与 0 の 1×1 の表を置く。
  public set(bodies: readonly AtmosphereBody[]): void {
    this.slots.set(bodies);
    this.present = bodies.length > 0;
    for (let i = 0; i < MAX_ATMOSPHERE_BODIES; i++) {
      const body = bodies[i];
      const table = body === undefined ? this.skyTables.forEmpty() : this.skyTables.forBody(body);
      this.tables[i]!.value = table.texture;
      this.altitudeMaxes[i] = table.altitudeMax;
    }
  }

  public hasContribution(): boolean { return this.present; }

  // 天空光の寄与のマテリアル。表はテクスチャなので初回だけ組めば足りる。
  public material(sample: ShadingSample): THREE.MeshBasicNodeMaterial {
    this.cached ??= contributionMaterial(sample, this.contribution(sample));
    return this.cached;
  }

  // 拡散は天空光の放射照度そのもの。鏡面は同じ光を放射輝度 E/π の一様な環境として映した
  // もの(環境光と同じ扱い — 拡散を持たない金属面が空の下で真っ黒に残らないための項)。
  private contribution(sample: ShadingSample): LightContribution {
    const toSun = sample.viewPositionOf(this.sunLight.position).sub(sample.position);
    // 表は大気圏外の太陽放射照度を 1 とする比なので、恒星の色と逆二乗の減衰をここで掛ける
    // (直射光と同じ形の放射照度になる)。
    const sunIrradiance = this.sunLight.color
      .mul(this.sunLight.intensity).div(max(dot(toSun, toSun), 1));
    let irradiance = vec3(0, 0, 0) as Vec3Node;
    for (let i = 0; i < MAX_ATMOSPHERE_BODIES; i++) {
      const path = this.slots.geometryOf(i, sample.worldPosition, this.sunLight.position);
      const uv = skyIrradianceUv(
        path.sunMu, path.radius.sub(path.surfaceRadius), this.altitudeMaxArray.element(i),
      );
      // 水平面へ届く量へ、面の向きの重みを掛ける。上向きで 1、真横で 0.5、下向きで 0。
      const weight = dot(sample.normal, path.offset.div(path.radius)).add(1).mul(0.5);
      irradiance = irradiance.add(this.tables[i]!.sample(uv).rgb.mul(weight)) as Vec3Node;
    }
    irradiance = irradiance.mul(sunIrradiance) as Vec3Node;
    return { diffuse: irradiance, specular: irradiance.div(PI) };
  }

  // 組んだマテリアルを解放する。
  public dispose(): void {
    this.cached?.dispose();
  }
}
