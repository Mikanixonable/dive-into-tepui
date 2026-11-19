// パイプラインの中間ターゲットを画面いっぱいへ映すデバッグ表示の一式。選択肢(DebugTargetId、
// 'off' を除く)ごとの合成マテリアルの表と、深度・影スロットの表示が深度から位置・距離を
// 復元するのに使うカメラ由来の uniform を持つ。
import * as THREE from 'three/webgpu';
import { float, int, log, max, screenUV, select, texture, uniform, vec3, vec4 } from 'three/tsl';
import { buildCompositeMaterial, toneMapped } from './composite';
import { octDecodeNormal, type GBufferPass } from './gbuffer';
import { viewPositionAt } from './view-ray';
import type { DebugTargetId } from './debug-target';
import type { AtmospherePass } from './atmosphere-pass';
import type { LightPrepass } from './light-prepass';
import type { LensPass } from './lens-pass';
import type { PlanetLightSource } from './lighting/planet-light-source';
import type { ShadowPass } from './shadow/shadow-pass';
import type { MeshShadow } from './shadow/mesh-shadow';
import type { ShadowMaps } from './shadow/shadow-maps';
import type { Exposure } from './exposure';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node } from '../tsl-types';

// デバッグ表示が覗く中間ターゲットと、HDR の物理量を表示値へ写す露出係数の供給元。
export interface DebugCompositeSources {
  readonly gbuffer: GBufferPass;
  readonly atmosphere: AtmospherePass;
  readonly shadow: ShadowPass;
  readonly shadowMaps: ShadowMaps;
  readonly meshShadow: MeshShadow;
  readonly lightPrepass: LightPrepass;
  readonly lens: LensPass;
  readonly planetLight: PlanetLightSource;
  readonly exposure: Exposure;
}

export class DebugComposites {
  // 表示ごとの合成マテリアルの表。表示ごとに別マテリアルを持ち、quad.material の差し替えで
  // 切り替える — 1 枚をユニフォームで分岐させると、通常プレイの毎フレームで G バッファの
  // 全テクスチャを bind/sample することになる。
  private readonly materials: Readonly<Record<Exclude<DebugTargetId, 'off'>, THREE.MeshBasicNodeMaterial>>;
  // 深度デバッグ表示が使う uniform。composite パスは QuadMesh 自前の固定直交カメラ
  // (near=0/far=1)で描かれるため、TSL の cameraNear/cameraFar/cameraProjectionMatrix
  // 組み込みノードはここでは実カメラの値を返さない — writeCamera が毎フレーム実カメラの
  // near/far と逆射影行列を書き込む。
  private readonly depthNear: FloatUniform;
  private readonly depthFar: FloatUniform;
  // G バッファ深度から view 空間の位置を復元する逆射影行列。
  public readonly depthProjInv: Mat4Uniform;
  // 復元した view 空間の位置を描画座標へ戻す行列。影スロット表示が使う。
  private readonly viewToWorld: Mat4Uniform;

  // 画面いっぱいへ映す中間ターゲットの選択。'off' なら通常表示。
  private _target: DebugTargetId = 'off';

  public constructor(sources: DebugCompositeSources) {
    this.depthNear = uniform(1);
    this.depthFar = uniform(2);
    this.depthProjInv = uniform(new THREE.Matrix4());
    this.viewToWorld = uniform(new THREE.Matrix4());
    this.materials = this.buildMaterials(sources);
  }

  // このフレームに画面いっぱいへ映す中間ターゲット。
  public get target(): DebugTargetId { return this._target; }

  public setTarget(target: DebugTargetId): void {
    this._target = target;
  }

  // 選択中の表示の合成マテリアル。'off' の通常表示はここには無い。
  public materialFor(target: Exclude<DebugTargetId, 'off'>): THREE.MeshBasicNodeMaterial {
    return this.materials[target];
  }

  // 深度から距離・位置を引き直す表示のために、カメラ由来の値を uniform へ書き込む。
  public writeCamera(camera: THREE.Camera): void {
    this.depthProjInv.value.copy(camera.projectionMatrixInverse);
    this.viewToWorld.value.copy(camera.matrixWorld);
    if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
      this.depthNear.value = camera.near;
      this.depthFar.value = camera.far;
    }
  }

  // 「マテリアル」と「大気」は、大気パスが点検用に描く1枚を映すので、材質を共有する。
  private buildMaterials(
    sources: DebugCompositeSources,
  ): Readonly<Record<Exclude<DebugTargetId, 'off'>, THREE.MeshBasicNodeMaterial>> {
    const { gbuffer, atmosphere, shadow, shadowMaps, meshShadow, lightPrepass, lens, planetLight, exposure } = sources;
    const inspectMaterial = buildCompositeMaterial(
      gbuffer, vec4(toneMapped(texture(atmosphere.inspectTexture, screenUV).rgb, exposure), 1),
    );
    return {
      normal: buildCompositeMaterial(
        gbuffer, vec4(octDecodeNormal(texture(gbuffer.normalTexture, screenUV).rg).mul(0.5).add(0.5), 1),
      ),
      roughness: buildCompositeMaterial(gbuffer, vec4(vec3(texture(gbuffer.roughnessTexture, screenUV).r), 1)),
      basecolor: buildCompositeMaterial(gbuffer, vec4(texture(gbuffer.basecolorTexture, screenUV).rgb, 1)),
      metalness: buildCompositeMaterial(gbuffer, vec4(vec3(this.metalnessNode(gbuffer)), 1)),
      // 自己発光は 1 を超えうる HDR 値なので、照度と同じくトーンマッピングを通して出す。
      emissive: buildCompositeMaterial(
        gbuffer, vec4(toneMapped(texture(gbuffer.emissiveTexture, screenUV).rgb, exposure), 1),
      ),
      depth: buildCompositeMaterial(gbuffer, vec4(vec3(this.logDepthNode(gbuffer)), 1)),
      // 4 枚のスロットを 2x2 に並べて画面いっぱいへ映す。線形深度なのでそのまま濃淡として
      // 読め(遠いほど白)、使われていないスロットは真っ白のまま残る。
      'shadow-map': buildCompositeMaterial(gbuffer, vec4(vec3(this.shadowSlotGridNode(shadowMaps)), 1)),
      'shadow-map-slot': buildCompositeMaterial(gbuffer, vec4(this.shadowSlotColorNode(gbuffer, meshShadow), 1)),
      shadow: buildCompositeMaterial(gbuffer, vec4(vec3(texture(shadow.texture, screenUV).r), 1)),
      // 照度・陰影は 1 を超え得る HDR 値なので、通常表示と同じトーンマッピングを通してから
      // 画面へ出す(1 天文単位の放射照度は π を超えるため、通さないと全面白になる)。
      diffuse: buildCompositeMaterial(
        gbuffer, vec4(toneMapped(texture(lightPrepass.diffuseTexture, screenUV).rgb, exposure), 1),
      ),
      specular: buildCompositeMaterial(
        gbuffer, vec4(toneMapped(texture(lightPrepass.specularTexture, screenUV).rgb, exposure), 1),
      ),
      material: inspectMaterial,
      atmosphere: inspectMaterial,
      lens: buildCompositeMaterial(gbuffer, vec4(toneMapped(lens.redistributedLight(), exposure), 1)),
      'planet-light': buildCompositeMaterial(
        gbuffer, vec4(toneMapped(planetLight.imageRadianceAt(screenUV), exposure), 1),
      ),
    };
  }

  // G バッファのベース色の α に載っている金属度。物体の無い画素は 0。
  private metalnessNode(gbuffer: GBufferPass): FloatNode {
    const metalness = texture(gbuffer.basecolorTexture, screenUV).a;
    return select(gbuffer.covered(), metalness, float(0));
  }

  // 影のスロット 4 枚を 2x2 のタイルとして 1 枚のノードへ畳む。
  private shadowSlotGridNode(shadowMaps: ShadowMaps): FloatNode {
    const tileUV = screenUV.mul(2).fract();
    const parameters = shadowMaps.uniformArrays.parameters;
    const left = screenUV.x.lessThan(0.5);
    // screenUV は上端が原点なので、y の小さいほうが画面の上段。
    const top = screenUV.y.lessThan(0.5);
    // 深度マップはメートルで持っているので、スロットごとの深度の幅(far − near)で割って濃淡へ直す。
    const tile = (layer: number): FloatNode => {
      const slot = parameters.element(layer);
      return texture(shadowMaps.texture, tileUV).depth(int(layer)).r
        .div(max(slot.y.sub(slot.x), 1e-6));
    };
    const topRow = select(left, tile(0), tile(1));
    const bottomRow = select(left, tile(2), tile(3));
    return select(top, topRow, bottomRow);
  }

  // G バッファ深度から復元した位置を覆う影スロットの色。どのスロットも覆っていなければ黒。
  private shadowSlotColorNode(gbuffer: GBufferPass, meshShadow: MeshShadow): Vec3Node {
    const viewPos = viewPositionAt(gbuffer.depthTexture, this.depthProjInv);
    const worldPos: Vec3Node = this.viewToWorld.mul(vec4(viewPos, 1)).xyz;
    return meshShadow.slotDebugColor(worldPos);
  }

  // 深度バッファの生値を near/far 間の対数スケール(0=near, 1=far)へ変換する。素の深度値は
  // near=2m/far=2e12m のスケールでは端に潰れて識別できないため、対数を挟むことで
  // 精度の落ち方そのものを見えるようにする。
  private logDepthNode(gbuffer: GBufferPass): FloatNode {
    // 深度の生値から距離への逆写像は投影方式ごとに違う(透視は 1/z、平行投影は線形)ので、
    // 生値ではなく復元位置の view 空間 z から測る — 逆射影行列がその違いを吸収する。
    const dist = viewPositionAt(gbuffer.depthTexture, this.depthProjInv).z.negate();
    return log(dist.div(this.depthNear)).div(log(this.depthFar.div(this.depthNear)));
  }

  // 同じ1枚を複数の選択肢が共有するので、重複を畳んでから解放する。
  public dispose(): void {
    for (const material of new Set(Object.values(this.materials))) material.dispose();
  }
}
