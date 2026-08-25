// 模式図スタイルの合成: G バッファの深度・法線だけから物体の外形と稜線を輪郭線として抽出し、
// それ以外を背景色で塗った1枚の色を組む。マテリアルパス以降を経ないため、色・陰影の情報は
// 一切読まない。
import * as THREE from 'three/webgpu';
import { dot, greaterThan, lessThanEqual, max, screenUV, select, texture, uniform, vec2, vec3, vec4 } from 'three/tsl';
import {
  SCHEMATIC_BACKGROUND, SCHEMATIC_DEPTH_RATIO, SCHEMATIC_EDGE_WIDTH_PX, SCHEMATIC_LINE, SCHEMATIC_NORMAL_DOT,
} from '../schematic-style';
import type { Mat4Uniform, Vec2Node, Vec3Node, Vec4Node } from '../tsl-types';
import { octDecodeNormal, type GBufferPass } from './gbuffer';
import { viewPositionAt } from './view-ray';

const BACKGROUND_COLOR = new THREE.Color(SCHEMATIC_BACKGROUND);
const LINE_COLOR = new THREE.Color(SCHEMATIC_LINE);
const backgroundNode: Vec3Node = vec3(BACKGROUND_COLOR.r, BACKGROUND_COLOR.g, BACKGROUND_COLOR.b);
const lineNode: Vec3Node = vec3(LINE_COLOR.r, LINE_COLOR.g, LINE_COLOR.b);

export class SchematicComposite {
  // 隣接画素を探す距離 [screenUV]。画面解像度が変わるたびに render() 側が書き込む。
  private readonly texelSize: THREE.UniformNode<'vec2', THREE.Vector2>;
  readonly colorNode: Vec4Node;

  // 深度・法線を読む距離1画素ぶんの隣接判定を4方向ぶん組み、輪郭色/背景色を選ぶ1枚の
  // カラーグラフを一度だけ構築する。projectionMatrixInverse は composite パスの固定直交カメラ
  // ではなく実カメラのものを毎フレーム書き込む必要があるため、呼び出し側が保持する uniform を
  // そのまま受ける。
  constructor(gbuffer: GBufferPass, projectionMatrixInverse: Mat4Uniform) {
    this.texelSize = uniform(new THREE.Vector2());

    const viewZAt = (uv: Vec2Node): Vec3Node['z'] =>
      viewPositionAt(gbuffer.depthTexture, projectionMatrixInverse, uv).z;
    const normalAt = (uv: Vec2Node): Vec3Node => octDecodeNormal(texture(gbuffer.normalTexture, uv).rg);

    const rawDepth = texture(gbuffer.depthTexture, screenUV).r;
    const z0 = viewZAt(screenUV);
    const n0 = normalAt(screenUV);

    const neighborUvs: readonly Vec2Node[] = [
      screenUV.add(vec2(this.texelSize.x, 0)),
      screenUV.sub(vec2(this.texelSize.x, 0)),
      screenUV.add(vec2(0, this.texelSize.y)),
      screenUV.sub(vec2(0, this.texelSize.y)),
    ];
    const edges = neighborUvs.map((uv) => {
      const depthRatio = z0.sub(viewZAt(uv)).abs().div(max(z0.abs(), 1e-6));
      const normalDot = dot(n0, normalAt(uv));
      return greaterThan(depthRatio, SCHEMATIC_DEPTH_RATIO).or(normalDot.lessThan(SCHEMATIC_NORMAL_DOT));
    });
    const isEdge = edges.reduce((acc, edge) => acc.or(edge));

    // 反転深度(near=1/far=0)なので、far のクリア値は 0。物体の無い画素は近傍比較にかけず
    // 背景色にする — far どうしの隣接でも比の分母が 0 に近づき、意味のない値が edge を立てうる。
    const noObject = lessThanEqual(rawDepth, 0);
    this.colorNode = vec4(select(noObject, backgroundNode, select(isEdge, lineNode, backgroundNode)), 1);
  }

  // 画面解像度が変わったフレームで隣接画素までの距離を引き直す。
  update(width: number, height: number): void {
    this.texelSize.value.set(SCHEMATIC_EDGE_WIDTH_PX / width, SCHEMATIC_EDGE_WIDTH_PX / height);
  }
}
