// ライティングパスの全光源が共有する、1 画素ぶんのシェーディング入力。法線・粗さ・深度は
// 同じ 1 つの面から揃って引く必要があるので、G バッファの読み出しはすべてここの uv を通す。
import * as THREE from 'three/webgpu';
import { screenSize, screenUV, select, texture, uniform, vec2, vec4 } from 'three/tsl';
import type { BoolNode, FloatNode, Mat4Uniform, Vec2Node, Vec3Node } from '../../tsl-types';
import { octDecodeNormal, type GBufferPass } from '../gbuffer';
import { viewPositionAt, viewRayAt } from '../view-ray';

// その画素の G バッファに面が写っているか。反転深度では遠平面が 0 なので、そのままの値は虚空を表す。
function isCovered(depthTexture: THREE.Texture, uv: Vec2Node): BoolNode {
  return texture(depthTexture, uv).r.greaterThan(0);
}

// 照度を組み立てる画素の uv。面が写っている画素はそのまま、虚空の画素は十字に隣接する面へ寄せる。
//
// **寄せるのはマルチサンプルとの辻褄合わせである。** 照度を読む側はマルチサンプルされた被覆で
// 断片を出すため、画素の中心が面の外に落ちた断片が縁に生じる。その断片が読む先へ隣の面の照度を
// 置いておかないと、材質だけが面から来て照度が虚空のものになり、縁が1画素だけ別の明るさになる。
function shadingUV(depthTexture: THREE.Texture, uv: Vec2Node): Vec2Node {
  const texel: Vec2Node = vec2(1).div(screenSize);
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
  // 毎フレーム自前で書き込む(render-pipeline.ts の depthDebugNear/Far と同じ理由)。
  private readonly projMatrixInverse: Mat4Uniform;
  private readonly viewMatrix: Mat4Uniform;
  // G バッファを引く uv。遮蔽度など、面に揃えて読むべきテクスチャはすべてこれで引く。
  readonly uv: Vec2Node;
  // 十字の隣まで探しても面が無い虚空の画素では偽。照らす面が存在しないので、光源は寄与を
  // 0 にする — 遠平面に置いた架空の面の明るさが縁へ滲むため。
  readonly lit: BoolNode;
  // view 空間の法線(正規化済み)。
  readonly normal: Vec3Node;
  readonly roughness: FloatNode;
  // 深度から復元した view 空間位置。
  readonly position: Vec3Node;
  // 面から視点へ向かう向き = 視線の逆向き。「復元位置の逆向き」は透視投影でしか成り立たない
  // ので、投影方式に依らない形(view-ray.ts)から取る。
  readonly viewDir: Vec3Node;

  constructor(gbuffer: GBufferPass) {
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
  viewPositionOf(worldPosition: Vec3Node): Vec3Node {
    return this.viewMatrix.mul(vec4(worldPosition, 1)).xyz;
  }

  // 実カメラの行列を書き込む。ライティングパスが光源を描く前に毎フレーム呼ぶ。
  sync(camera: THREE.Camera): void {
    this.projMatrixInverse.value.copy(camera.projectionMatrixInverse);
    this.viewMatrix.value.copy(camera.matrixWorldInverse);
  }
}
