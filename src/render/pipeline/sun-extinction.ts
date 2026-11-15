// 恒星の直射光が、大気を通って地表・雲・艦へ届くまでに受ける波長別の消衰。
// 大気の光学から焼いた透過率表(sun-transmittance-tables.ts)を、点が属する天体ごとの
// (太陽の天頂角余弦・高度)で引いて掛ける。大気を持つ天体は毎フレーム set() で受ける —
// 大気パスが描く天体と同じ列である。
// **幾何学的な遮蔽はここでは扱わない** — 天体を貫通する経路の減衰は影パス(BodyShadow)が担い、
// ここが足すのは大気そのものによる消衰だけ(二重に数えない)。
import type * as THREE from 'three/webgpu';
import { texture, uniformArray, vec3 } from 'three/tsl';
import { MAX_ATMOSPHERE_BODIES, type AtmosphereBody } from '../atmosphere';
import type { Vec3Node } from '../tsl-types';
import type { SunLight } from './sun-light';
import { AtmosphereSlots } from './atmosphere-slots';
import {
  sunTransmittanceUv, type SunTransmittanceTables,
} from './sun-transmittance-tables';

export class SunExtinction {
  private readonly slots = new AtmosphereSlots();
  // 天体ごとの、表の高度軸の上限 [m] と焼き込み済みの表。
  private readonly altitudeMaxes: number[];
  private readonly altitudeMaxArray: THREE.UniformArrayNode<'float'>;
  private readonly tables: THREE.TextureNode[];

  // 上限ぶんの uniform を確保する。件数は固定なので、大気を持つ天体が増減しても
  // グラフの形は変わらない。
  public constructor(
    private readonly sunLight: SunLight,
    private readonly sunTables: SunTransmittanceTables,
  ) {
    this.altitudeMaxes = Array.from({ length: MAX_ATMOSPHERE_BODIES }, () => 1);
    this.altitudeMaxArray = uniformArray(this.altitudeMaxes, 'float');
    this.tables = Array.from(
      { length: MAX_ATMOSPHERE_BODIES }, () => texture(sunTables.forEmpty().texture),
    );
  }

  // このフレームの直射光が抜ける大気の天体の列(大気パスと同じ列)。空きスロットには
  // 素通しの 1×1 の表を置く。
  public set(bodies: readonly AtmosphereBody[]): void {
    this.slots.set(bodies);
    for (let i = 0; i < MAX_ATMOSPHERE_BODIES; i++) {
      const body = bodies[i];
      const table = body === undefined ? this.sunTables.forEmpty() : this.sunTables.forBody(body);
      this.tables[i]!.value = table.texture;
      this.altitudeMaxes[i] = table.altitudeMax;
    }
  }

  // 描画座標の点 worldPos へ届く恒星の直射光が残る割合 0..1 を、RGB ごとに返す。
  // 全スロットの表の積。空きスロットは素通しの表を読むので、有効な数で回す必要が無い。
  // スロット数はコンパイル時に固定なので JS で展開する。
  public transmittance(worldPos: Vec3Node): Vec3Node {
    let transmittance = vec3(1, 1, 1) as Vec3Node;
    for (let i = 0; i < MAX_ATMOSPHERE_BODIES; i++) {
      const path = this.slots.geometryOf(i, worldPos, this.sunLight.position);
      const uv = sunTransmittanceUv(
        path.sunMu, path.radius.sub(path.surfaceRadius), this.altitudeMaxArray.element(i),
      );
      transmittance = transmittance.mul(this.tables[i]!.sample(uv).rgb) as Vec3Node;
    }
    return transmittance;
  }
}
