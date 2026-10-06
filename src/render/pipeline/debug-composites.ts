// デバッグ表示の選択肢ごとの合成マテリアル。通常表示を除く各選択肢は、そのフレームで本番の段が書いた中間ターゲットを
// 画面いっぱいに映す。照度など 1 を超えうる値は、通常表示と同じトーンマッピングを通して出す。表示ごとに別の
// マテリアルを持つ — 1 枚をユニフォームで分岐させると、通常プレイの毎フレームで G バッファの全テクスチャを
// bind/sample することになる。
import * as THREE from 'three/webgpu';
import {
  abs, float, floor, int, ivec2, log, max, sRGBTransferEOTF, sRGBTransferOETF, screenUV, select, sign, texture,
  uniform, vec3, vec4,
} from 'three/tsl';
import { octDecodeNormal } from './gbuffer';
import { compositeMaterial } from './composite-material';
import { viewPositionAt } from './view-ray';
import {
  CHAIN_DEBUG_TARGETS, type ChainDebugTarget, type ChainDebugTargetId, type DebugTargetId,
} from './debug-target';
import { unpackedBands } from './screen-space/band-pyramid';
import type { GBufferPass } from './gbuffer';
import type { Exposure } from './exposure';
import type { ShadowMaps } from './shadow/shadow-maps';
import type { MeshShadow } from './shadow/mesh-shadow';
import type { ShadowPass } from './shadow/shadow-pass';
import type { LightPrepass } from './light-prepass';
import type { ScreenSpacePass } from './screen-space/screen-space-pass';
import type { DiffuseCorrection } from './screen-space/diffuse-correction';
import type { PlanetLightSource } from './lighting/planet-light-source';
import type { AtmospherePass } from './atmosphere-pass';
import type { LensPass } from './lens-pass';
import type { FloatNode, FloatUniform, Mat4Uniform, Vec3Node, Vec4Node } from '../tsl-types';

// 通常表示を除くデバッグ表示の選択肢。
export type DebugView = Exclude<DebugTargetId, 'off'>;

// 選択肢 view が、近傍拡散補正の帯と段の表示か。
function isChainView(view: DebugView): view is ChainDebugTargetId {
  return CHAIN_DEBUG_TARGETS.some(({ id }) => id === view);
}

export class DebugComposites {
  private readonly materials: Readonly<Record<Exclude<DebugView, ChainDebugTargetId>, THREE.MeshBasicNodeMaterial>>;
  // 帯の数ごとの、帯と段の表示。初めてその帯の数で映すときに組む。
  private readonly chainMaterials = new Map<number, ReadonlyMap<ChainDebugTargetId, THREE.MeshBasicNodeMaterial>>();
  // いまの段の帯の数に無い帯と段の表示が映す黒。
  private readonly blankMaterial: THREE.MeshBasicNodeMaterial;
  // 深度と影スロットの表示が、深度から距離と描画座標を引き直す実カメラの値。合成パスは固定の直交カメラで描かれる
  // ので、TSL のカメラの組み込みノードは実カメラの値を返さない — syncCamera が毎フレーム書き込む。
  private readonly near: FloatUniform = uniform(1);
  private readonly far: FloatUniform = uniform(2);
  private readonly viewToWorld: Mat4Uniform = uniform(new THREE.Matrix4());

  // 映す中間ターゲットの持ち主を受ける。projectionInverse は実カメラの逆射影行列で、書き込むのは呼び出し側。
  public constructor(
    private readonly gbuffer: GBufferPass, private readonly exposure: Exposure,
    private readonly projectionInverse: Mat4Uniform, private readonly shadowMaps: ShadowMaps,
    private readonly meshShadow: MeshShadow, shadowPass: ShadowPass, lightPrepass: LightPrepass,
    private readonly screenSpacePass: ScreenSpacePass, private readonly diffuseCorrection: DiffuseCorrection,
    planetLight: PlanetLightSource, atmospherePass: AtmospherePass, lensPass: LensPass,
  ) {
    const material = (color: Vec4Node): THREE.MeshBasicNodeMaterial => compositeMaterial(color, gbuffer.depthTexture);
    const toneMapped = (color: Vec3Node): Vec4Node => vec4(exposure.toneMapped(color), 1);
    this.blankMaterial = material(vec4(0, 0, 0, 1));
    // 「マテリアル」も「大気」も、大気パスが点検用に描く1枚を映すので、材質を共有する。
    const inspectMaterial = material(toneMapped(texture(atmospherePass.inspectTexture, screenUV).rgb));
    this.materials = {
      normal: material(vec4(octDecodeNormal(texture(gbuffer.normalTexture, screenUV).rg).mul(0.5).add(0.5), 1)),
      roughness: material(vec4(vec3(texture(gbuffer.roughnessTexture, screenUV).r), 1)),
      basecolor: material(vec4(texture(gbuffer.basecolorTexture, screenUV).rgb, 1)),
      metalness: material(vec4(vec3(this.metalness()), 1)),
      // 自己発光は 1 を超える HDR 値なので、照度と同じくトーンマッピングを通して出す。
      emissive: material(toneMapped(texture(gbuffer.emissiveTexture, screenUV).rgb)),
      depth: material(vec4(vec3(this.logDepth()), 1)),
      // 4 枚のスロットを 2x2 に並べて画面いっぱいへ映す。線形深度なのでそのまま濃淡として
      // 読め(遠いほど白)、使われていないスロットは真っ白のまま残る。
      'shadow-map': material(vec4(vec3(this.shadowSlotGrid()), 1)),
      'shadow-map-slot': material(vec4(this.shadowSlotColor(), 1)),
      shadow: material(vec4(vec3(texture(shadowPass.texture, screenUV).r), 1)),
      // 照度・陰影は 1 を超え得る HDR 値なので、通常表示と同じトーンマッピングを通してから
      // 画面へ出す(1 天文単位の放射照度は π を超えるため、通さないと全面白になる)。
      diffuse: material(toneMapped(texture(lightPrepass.diffuseTexture, screenUV).rgb)),
      specular: material(toneMapped(texture(lightPrepass.specularTexture, screenUV).rgb)),
      correction: material(vec4(this.signedCorrection(texture(diffuseCorrection.texture, screenUV)), 1)),
      'bounce-source': material(toneMapped(texture(screenSpacePass.surfaceRadianceTexture, screenUV).rgb)),
      material: inspectMaterial,
      atmosphere: inspectMaterial,
      lens: material(toneMapped(lensPass.redistributedLight())),
      'planet-light': material(toneMapped(planetLight.imageRadianceAt(screenUV))),
    };
  }

  // 選択肢 view の合成マテリアル。帯と段の表示は、いまの段の帯の数で描いた中間ターゲットを映し、その帯の数に無い
  // 帯と段なら黒。
  public material(view: DebugView): THREE.MeshBasicNodeMaterial {
    if (!isChainView(view)) return this.materials[view];
    return this.chainMaterialsOf(this.screenSpacePass.bandCount).get(view) ?? this.blankMaterial;
  }

  // 帯の数 count で描いた帯と段の表示の合成マテリアル。その帯の数に無い帯と段は持たない。初めて引いたときに組む。
  private chainMaterialsOf(count: number): ReadonlyMap<ChainDebugTargetId, THREE.MeshBasicNodeMaterial> {
    const existing = this.chainMaterials.get(count);
    if (existing !== undefined) return existing;
    const materials = new Map(CHAIN_DEBUG_TARGETS.flatMap((target) => {
      const color = this.chainColor(target, count);
      return color === null ? [] : [[target.id, compositeMaterial(color, this.gbuffer.depthTexture)] as const];
    }));
    this.chainMaterials.set(count, materials);
    return materials;
  }

  // 帯の数 count で描いた、帯と段の表示 target の色。補正は符号を色分けし、代表の面は法線を映す。その帯の数に無い
  // 帯と段なら null。
  private chainColor(target: ChainDebugTarget, count: number): Vec4Node | null {
    const corrections = this.diffuseCorrection;
    switch (target.kind) {
      // 段 level の描画先は、帯 level〜count − 1 を packedBands の並びで詰めて持つ。
      case 'band':
      case 'reduced': {
        const { level, band } = target;
        if (band >= count) return null;
        const packed = corrections.bandTarget(count, level).textures.map((source) => texture(source, screenUV));
        return this.signedColor(unpackedBands(packed, count - level)[band - level]!);
      }
      case 'representative':
        return target.level < count ? vec4(this.representativeNormal(target.level), 1) : null;
      case 'merged': {
        if (target.level >= count - 1) return null;
        return this.signedColor(texture(corrections.mergedTarget(count, target.level).texture, screenUV).rgb);
      }
    }
  }

  // 帯や合流の補正 value を、符号を色分けして映す色。詰めた帯や合流の出力の α は値なので、書かれた画素として扱う。
  private signedColor(value: Vec3Node): Vec4Node {
    return vec4(this.signedCorrection(vec4(value, 1)), 1);
  }

  // 段 level の代表の面の法線を 0..1 へ写した色。代表に面がなければ黒。
  private representativeNormal(level: number): Vec3Node {
    const surfaces = this.screenSpacePass.inputPyramid;
    const pixel = ivec2(floor(screenUV.mul(surfaces.sizeAt(level))));
    const { depth, encodedNormal } = surfaces.surfaceAt(level, pixel);
    return select(depth.greaterThan(0), octDecodeNormal(encodedNormal).mul(0.5).add(0.5), vec3(0));
  }

  // 深度と影スロットの表示が読む実カメラ camera の値を書き込む。
  public syncCamera(camera: THREE.Camera): void {
    this.viewToWorld.value.copy(camera.matrixWorld);
    if (camera instanceof THREE.PerspectiveCamera || camera instanceof THREE.OrthographicCamera) {
      this.near.value = camera.near;
      this.far.value = camera.far;
    }
  }

  // 全マテリアルを解放する。同じ1枚を複数の選択肢が共有するので、重複を畳んでから解放する。
  public dispose(): void {
    const chainMaterials = [...this.chainMaterials.values()].flatMap((materials) => [...materials.values()]);
    for (const material of new Set([...Object.values(this.materials), ...chainMaterials, this.blankMaterial])) {
      material.dispose();
    }
  }

  // 符号付きの値を成分ごとに、画面に出る値が 0 で中間灰、正で明るく、負で暗くなるよう写す。大きさの階調は
  // 他の表示が画面に出す階調(トーンマッピングと sRGB 符号化)と同じにする。
  // α が 0 の texel は黒にする。
  private signedCorrection(texel: Vec4Node): Vec3Node {
    const value = texel.rgb;
    const magnitude = sRGBTransferOETF(this.exposure.toneMapped(abs(value))) as Vec3Node;
    // 画面へ出るときの sRGB 符号化を打ち消す — 省くと 0 が中間灰より明るく出る。
    const signed = sRGBTransferEOTF(sign(value).mul(magnitude).mul(0.5).add(0.5)) as Vec3Node;
    return select(texel.a.equal(0), vec3(0), signed);
  }

  // G バッファのベース色の α に載っている金属度。物体の無い画素は 0。
  private metalness(): FloatNode {
    const metalness = texture(this.gbuffer.basecolorTexture, screenUV).a;
    return select(this.gbuffer.covered(), metalness, float(0));
  }

  // 影のスロット 4 枚を 2x2 のタイルとして 1 枚のノードへ畳む。
  private shadowSlotGrid(): FloatNode {
    const tileUV = screenUV.mul(2).fract();
    const parameters = this.shadowMaps.uniformArrays.parameters;
    const left = screenUV.x.lessThan(0.5);
    // screenUV は上端が原点なので、y の小さいほうが画面の上段。
    const top = screenUV.y.lessThan(0.5);
    // 深度マップはメートルで持っているので、スロットごとの深度の幅(far − near)で割って濃淡へ直す。
    const tile = (layer: number): FloatNode => {
      const slot = parameters.element(layer);
      return texture(this.shadowMaps.texture, tileUV).depth(int(layer)).r
        .div(max(slot.y.sub(slot.x), 1e-6));
    };
    const topRow = select(left, tile(0), tile(1));
    const bottomRow = select(left, tile(2), tile(3));
    return select(top, topRow, bottomRow);
  }

  // G バッファ深度から復元した位置を覆う影スロットの色。どのスロットも覆っていなければ黒。
  private shadowSlotColor(): Vec3Node {
    const viewPos = viewPositionAt(this.gbuffer.depthTexture, this.projectionInverse);
    const worldPos: Vec3Node = this.viewToWorld.mul(vec4(viewPos, 1)).xyz;
    return this.meshShadow.slotDebugColor(worldPos);
  }

  // 深度バッファの生値を near/far 間の対数スケール(0=near, 1=far)へ変換する。素の深度値は
  // near=2m/far=2e12m のスケールでは端に潰れて識別できないため、対数を挟むことで
  // 精度の落ち方そのものを見えるようにする。
  private logDepth(): FloatNode {
    // 深度の生値から距離への逆写像は投影方式ごとに違う(透視は 1/z、平行投影は線形)ので、
    // 生値ではなく復元位置の view 空間 z から測る — 逆射影行列がその違いを吸収する。
    const dist = viewPositionAt(this.gbuffer.depthTexture, this.projectionInverse).z.negate();
    return log(dist.div(this.near)).div(log(this.far.div(this.near)));
  }
}
