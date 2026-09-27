// 雲場テクスチャを、天体固定の単位方向から読む。焼いた側と同じ cap の置き方を写し取り、同じ uv
// で読む。差し込まれたテクスチャは借り物で、解放は差し込んだ側が行う。
import * as THREE from 'three/webgpu';
import { dot, mix, step, texture, uniform } from 'three/tsl';
import { EMPTY_CLOUD_FIELD } from './cumulus-shape';
import { orthographicCapUv, type CapPlacement } from '../field-projection';
import { cloudSampleFromTexels, type CloudSample } from './cloud-field-sample';
import type { FloatUniform, Vec3Node, Vec3Uniform, Vec4Node } from '../tsl-types';

// 焼いた雲場の下層・上層のテクスチャの対。
export interface CloudFieldTextures {
  readonly lower: THREE.Texture;
  readonly upper: THREE.Texture;
}

// 前後 2 つのキー時刻に焼いた雲場と、そのあいだの補間係数。a が早い側の時刻、b が遅い側の時刻で、
// blend は a から b への割合 0..1。
export interface CloudFieldKeyframes {
  readonly a: CloudFieldTextures;
  readonly b: CloudFieldTextures;
  readonly blend: number;
}

// 焼いた雲場と、それを焼いた cap の置き方の組。場を出す側が毎フレーム公開し、読み手が写し取る。
export interface CloudFieldBinding extends CloudFieldKeyframes {
  readonly cap: CapPlacement;
}

export class CloudFieldSampler {
  // 読む雲場の下層・上層のテクスチャノードを、キー時刻の早い側(a)と遅い側(b)に持つ。場が結ばれる
  // までは EMPTY_CLOUD_FIELD を読み、bind は同じノードの値を差し替える。
  private readonly aLower = texture(EMPTY_CLOUD_FIELD);
  private readonly aUpper = texture(EMPTY_CLOUD_FIELD);
  private readonly bLower = texture(EMPTY_CLOUD_FIELD);
  private readonly bUpper = texture(EMPTY_CLOUD_FIELD);
  // a から b への補間係数 0..1。
  private readonly blend: FloatUniform = uniform(0);
  // 焼いた側の cap の置き方。グラフは一度組めば済み、値だけが毎フレーム入れ替わる。
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3(0, 0, 1));
  private readonly east: Vec3Uniform = uniform(new THREE.Vector3(1, 0, 0));
  private readonly north: Vec3Uniform = uniform(new THREE.Vector3(0, 1, 0));
  private readonly sinRadius: FloatUniform = uniform(1);
  private readonly cosRadius: FloatUniform = uniform(-1);

  // 焼いた場と、それを焼いた cap の置き方を写し取る。テクスチャの所有権は移らない。
  public bind(binding: CloudFieldBinding): void {
    this.aLower.value = binding.a.lower;
    this.aUpper.value = binding.a.upper;
    this.bLower.value = binding.b.lower;
    this.bUpper.value = binding.b.upper;
    this.blend.value = binding.blend;
    this.center.value.copy(binding.cap.center);
    this.east.value.copy(binding.cap.east);
    this.north.value.copy(binding.cap.north);
    this.sinRadius.value = binding.cap.sinRadius;
    this.cosRadius.value = binding.cap.cosRadius;
  }

  // 単位方向 direction の雲標本を、生成時と同じ単位で読む。下層・上層それぞれ、2 キー時刻の texel
  // を blend で混ぜる — 成分はどれも線形に混ぜられる量(被覆率・高度・光学的厚み・形態)なので
  // texel 補間でよい。**cap の外は「雲なし」を返す** — 返さないと縁の値が外へ伸び、裏側の半球では
  // 表側の雲を鏡映しに読む。
  public sampleCloud(direction: Vec3Node): CloudSample {
    const inside = step(this.cosRadius, dot(direction, this.center));
    const uv = orthographicCapUv(direction, this.east, this.north, this.sinRadius);
    return cloudSampleFromTexels({
      lower: mix(this.aLower.sample(uv), this.bLower.sample(uv), this.blend).mul(inside) as Vec4Node,
      upper: mix(this.aUpper.sample(uv), this.bUpper.sample(uv), this.blend).mul(inside) as Vec4Node,
    });
  }
}
