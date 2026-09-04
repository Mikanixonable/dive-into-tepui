// ライティングパスの全光源が共有する、1 画素ぶんのシェーディング入力。法線・粗さ・深度は
// 同じ 1 つの面から揃って引く必要があるので、光源からの G バッファ読み出しはここへ集める。
import * as THREE from 'three/webgpu';
import { screenSize, screenUV, select, texture, uniform, vec2, vec4 } from 'three/tsl';
import { octDecodeNormal, type GBufferPass } from '../gbuffer';
import { viewPositionAt, viewRayAt } from '../view-ray';
import type { BoolNode, FloatNode, Mat4Uniform, Vec2Node, Vec3Node } from '../../tsl-types';

// その画素の G バッファに面が写っているか。反転深度では遠平面が 0 なので、そのままの値は虚空を表す。
function isCovered(depthTexture: THREE.Texture, uv: Vec2Node): BoolNode {
  return texture(depthTexture, uv).r.greaterThan(0);
}

// 照度を組み立てる画素の uv。面が写っている画素はそのまま、虚空の画素は十字に隣接する面へ寄せる。
//
// TODO: 虚空の画素の照度は読まれないので寄せる根拠が無いが、外すと 1 画素幅の構造の陰影が動く
// (render-lab の 32/35 ケース、画素の 0.1% 未満、最大 67/255)。面が写っている画素で恒等写像に
// ならない理由が付くまで残す。
function shadingUV(depthTexture: THREE.Texture, uv: Vec2Node): Vec2Node {
  const texel: Vec2Node = vec2(1).div(screenSize);
  // 自分 → 左右 → 上下の順に、最初に面が写っている候補を採る。
  const candidates: readonly Vec2Node[] = [
    uv,
    uv.sub(vec2(texel.x, 0)), uv.add(vec2(texel.x, 0)),
    uv.sub(vec2(0, texel.y)), uv.add(vec2(0, texel.y)),
  ];
  return candidates.reduceRight(
    (rest, candidate) => select(isCovered(depthTexture, candidate), candidate, rest),
    uv,
  );
}

export class ShadingSample {
  // QuadMesh は固定直交カメラで描かれるため、実カメラの逆射影行列と描画座標→view の行列は
  // 毎フレーム自前で書き込む。
  private readonly projMatrixInverse: Mat4Uniform;
  private readonly viewMatrix: Mat4Uniform;
  // G バッファを引く uv。遮蔽度など、面に揃えて読むべきテクスチャはすべてこれで引く。
  public readonly uv: Vec2Node;
  // 十字の隣まで探しても面が無い虚空の画素では偽。照らす面が存在しないので、光源は寄与を
  // 0 にすること — 遠平面に置いた架空の面の明るさが縁へ滲む。
  public readonly lit: BoolNode;
  // view 空間の法線(正規化済み)。
  public readonly normal: Vec3Node;
  public readonly roughness: FloatNode;
  // 深度から復元した view 空間位置。
  public readonly position: Vec3Node;
  // 面から視点へ向かう向き = 視線の逆向き。「復元位置の逆向き」は透視投影でしか成り立たない
  // ので、投影方式に依らない形(view-ray.ts)から取る。
  public readonly viewDir: Vec3Node;

  // G バッファを引く uv を 1 度だけ組み、すべての入力をその uv から取る。
  public constructor(gbuffer: GBufferPass) {
    this.projMatrixInverse = uniform(new THREE.Matrix4());
    this.viewMatrix = uniform(new THREE.Matrix4());
    const shadeUV = shadingUV(gbuffer.depthTexture, screenUV);
    this.uv = shadeUV;
    this.lit = isCovered(gbuffer.depthTexture, shadeUV);
    this.normal = octDecodeNormal(texture(gbuffer.normalTexture, shadeUV).rg);
    this.roughness = texture(gbuffer.roughnessTexture, shadeUV).r;
    this.position = viewPositionAt(gbuffer.depthTexture, this.projMatrixInverse, shadeUV);
    this.viewDir = viewRayAt(this.projMatrixInverse, shadeUV).direction.negate();
  }

  // 描画座標の点を position・normal と同じ view 空間へ写す。光源の位置は描画座標で持たれる
  // ので、寄与を組む光源はこれを通して空間を揃える。
  public viewPositionOf(worldPosition: Vec3Node): Vec3Node {
    return this.viewMatrix.mul(vec4(worldPosition, 1)).xyz;
  }

  // 実カメラの行列を書き込む。光源を描く前に毎フレーム呼ぶこと。
  public sync(camera: THREE.Camera): void {
    this.projMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.viewMatrix.value.copy(camera.matrixWorldInverse);
  }
}
