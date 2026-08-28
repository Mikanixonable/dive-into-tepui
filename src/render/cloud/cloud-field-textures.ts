// 天気のモデルを正距円筒図法の写しへ描く。雲の場(field: 鉛直光学的厚み・雲頂)と中間生成物
// (weather: 温度・湿度・風)の 2 枚を 1 つの MRT ターゲットに持ち、時刻を渡すたびに全面を描き直す。
import * as THREE from 'three/webgpu';
import { QuadMesh, WebGPURenderer } from 'three/webgpu';
import { cos, mrt, screenUV, sin, vec3, vec4 } from 'three/tsl';
import { WeatherModel } from './weather-model';
import type { Vec2Node, Vec3Node } from '../tsl-types';

// 写しの解像度 [texel]。正距円筒なので幅は高さの 2 倍。
export const CLOUD_FIELD_WIDTH = 2048;
export const CLOUD_FIELD_HEIGHT = 1024;

// 正距円筒図法の uv から単位方向へ。u は経度(0.5 が本初子午線 +Z、東が +X)、v は緯度
// (0 が北極 +Y)。
export function directionFromEquirectUv(uv: Vec2Node): Vec3Node {
  const longitude = uv.x.sub(0.5).mul(2 * Math.PI);
  const latitude = uv.y.sub(0.5).negate().mul(Math.PI);
  const flat = cos(latitude);
  return vec3(flat.mul(sin(longitude)), sin(latitude), flat.mul(cos(longitude)));
}

export class CloudFieldTextures {
  private readonly target: THREE.RenderTarget;
  private readonly material: THREE.MeshBasicNodeMaterial;
  private readonly quad: QuadMesh;
  private readonly model = new WeatherModel();

  // 写しの 2 枚と、それを描くグラフを一度だけ組む。時刻は render() のたびに受ける。
  public constructor() {
    this.target = new THREE.RenderTarget(CLOUD_FIELD_WIDTH, CLOUD_FIELD_HEIGHT, {
      count: 2, depthBuffer: false, samples: 0,
    });
    const [fieldTex, weatherTex] = this.target.textures;
    fieldTex!.name = 'field';
    fieldTex!.format = THREE.RGFormat;
    fieldTex!.type = THREE.HalfFloatType;
    weatherTex!.name = 'weather';
    weatherTex!.format = THREE.RGBAFormat;
    weatherTex!.type = THREE.HalfFloatType;

    // texel ごとに単位方向へ写し、そこでの天気と雲を 2 枚へ振り分ける。
    const weather = this.model.weatherAt(directionFromEquirectUv(screenUV));
    const cloud = this.model.condense(weather);
    this.material = new THREE.MeshBasicNodeMaterial({ depthTest: false, depthWrite: false });
    this.material.mrtNode = mrt({
      field: vec4(cloud.opticalDepth, cloud.top, 0, 1),
      weather: vec4(weather.temperature, weather.humidity, weather.wind),
    });
    this.quad = new QuadMesh(this.material);
  }

  // rg16f: r = 鉛直光学的厚み、g = 雲頂の高さ 0..1。
  public get fieldTexture(): THREE.Texture { return this.target.textures[0]!; }
  // rgba16f: r = 温度 [°C]、g = 湿度 0..1、b = 東向きの風 [m/s]、a = 北向きの風 [m/s]。
  public get weatherTexture(): THREE.Texture { return this.target.textures[1]!; }

  // 時刻 [s] の天気を 2 枚へ描く。
  public render(renderer: WebGPURenderer, seconds: number): void {
    this.model.syncTime(seconds);
    renderer.setRenderTarget(this.target);
    this.quad.render(renderer);
    renderer.setRenderTarget(null);
  }

  // 保持している GPU 資源を解放する。QuadMesh の geometry は three が全インスタンスで共有する
  // 単一の板なので、ここでは解放しない。
  public dispose(): void {
    this.target.dispose();
    this.material.dispose();
  }
}
