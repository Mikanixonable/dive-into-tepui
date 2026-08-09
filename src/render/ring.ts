// 惑星の環を構成する3つの見た目の builder。半径は天体半径を1とする単位で与え、天体メッシュと
// 同じスケールを継承する呼び出し側(game/celestial/ring-view.ts)に合わせている。環はいずれも
// 軸対称配置(モデル座標の +Y が自転軸)なので、RingGeometry/自作の円周ジオメトリの法線 +Z を
// +Y へ倒す RING_TILT を共通で使う。
import * as THREE from 'three/webgpu';
import { RingArcDef } from '../physics/solar-system';

const RING_TILT = -Math.PI / 2;
const D2R = Math.PI / 180;
// アークを持つ帯の基準部(アーク以外の部分)の不透明度は、アーク本体の何割か。
const ARC_BASE_OPACITY_RATIO = 0.35;

// 内縁から外縁への放射方向をテクスチャの u 0→1 に対応させる。
function mapRadialUv(geo: THREE.RingGeometry, innerRadius: number, outerRadius: number): void {
  const pos = geo.getAttribute('position');
  const uv = geo.getAttribute('uv');
  for (let i = 0; i < pos.count; i++) {
    const r = Math.hypot(pos.getX(i), pos.getY(i));
    uv.setXY(i, (r - innerRadius) / (outerRadius - innerRadius), 0.5);
  }
}

// テクスチャ1枚に環全体を焼き込んだ annulus(土星の D〜A 環)。間隙はテクスチャのアルファで表す。
export function createTexturedRing(textureUrl: string, innerRadius: number, outerRadius: number): THREE.Mesh {
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, 128, 1);
  mapRadialUv(geo, innerRadius, outerRadius);
  const texture = new THREE.TextureLoader().load(textureUrl);
  texture.colorSpace = THREE.SRGBColorSpace;
  const mat = new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = RING_TILT;
  mesh.frustumCulled = false;
  return mesh;
}

function buildAnnulusMesh(color: number, opacity: number, innerRadius: number, outerRadius: number, thetaStart: number, thetaLength: number): THREE.Mesh {
  const geo = new THREE.RingGeometry(innerRadius, outerRadius, 128, 1, thetaStart, thetaLength);
  const mat = new THREE.MeshBasicMaterial({ color, opacity, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.x = RING_TILT;
  mesh.frustumCulled = false;
  return mesh;
}

// 経度範囲 [fromDeg, toDeg) を、環ジオメトリの thetaStart/thetaLength [rad] へ変換する。
function arcTheta(arc: RingArcDef): { thetaStart: number; thetaLength: number } {
  const thetaStart = arc.fromDeg * D2R;
  const span = ((arc.toDeg - arc.fromDeg) % 360 + 360) % 360 || 360;
  return { thetaStart, thetaLength: span * D2R };
}

// 単色半透明の annulus。幅が視角で解像できる帯(土星 G 環、木星主環、天王星/海王星の各環など)
// を面として描く。arcs を渡すと、全周を低い不透明度の基準面で塗った上に、各アークだけ
// 指定の不透明度の面を重ねる(海王星アダムス環)。
export function createAnnulusRing(color: number, opacity: number, innerRadius: number, outerRadius: number, arcs?: readonly RingArcDef[]): THREE.Object3D {
  if (arcs === undefined || arcs.length === 0) return buildAnnulusMesh(color, opacity, innerRadius, outerRadius, 0, Math.PI * 2);
  const group = new THREE.Group();
  group.add(buildAnnulusMesh(color, opacity * ARC_BASE_OPACITY_RATIO, innerRadius, outerRadius, 0, Math.PI * 2));
  for (const arc of arcs) {
    const { thetaStart, thetaLength } = arcTheta(arc);
    group.add(buildAnnulusMesh(color, opacity, innerRadius, outerRadius, thetaStart, thetaLength));
  }
  return group;
}

const RING_LINE_SEGMENTS = 256;
const ARC_LINE_SEGMENTS = 32;

function buildRingLineSegment(color: number, opacity: number, radius: number, thetaStart: number, thetaLength: number, segments: number): THREE.Line {
  const positions = new Float32Array((segments + 1) * 3);
  for (let i = 0; i <= segments; i++) {
    const a = thetaStart + (i / segments) * thetaLength;
    positions[i * 3] = Math.cos(a) * radius;
    positions[i * 3 + 1] = Math.sin(a) * radius;
    positions[i * 3 + 2] = 0;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({ color, opacity, transparent: true });
  // WebGPU レンダラーは LineLoop 未対応なので、始点を終端に重ねた THREE.Line で閉じる。
  const line = new THREE.Line(geo, mat);
  line.rotation.x = RING_TILT;
  line.frustumCulled = false;
  return line;
}

// 幅がサブピクセルになる細環を、半径 radius(内縁・外縁の中間)の円1本の線として描く。
// arcs の扱いは createAnnulusRing と対称 — 全周を低い不透明度の基準線で描いた上に、
// 各アークだけ別の線分を重ねる。
export function createRingLine(color: number, opacity: number, radius: number, arcs?: readonly RingArcDef[]): THREE.Object3D {
  if (arcs === undefined || arcs.length === 0) return buildRingLineSegment(color, opacity, radius, 0, Math.PI * 2, RING_LINE_SEGMENTS);
  const group = new THREE.Group();
  group.add(buildRingLineSegment(color, opacity * ARC_BASE_OPACITY_RATIO, radius, 0, Math.PI * 2, RING_LINE_SEGMENTS));
  for (const arc of arcs) {
    const { thetaStart, thetaLength } = arcTheta(arc);
    group.add(buildRingLineSegment(color, opacity, radius, thetaStart, thetaLength, ARC_LINE_SEGMENTS));
  }
  return group;
}

// 厚みを持つ帯(木星のハロー環・ゴサマー環、土星の E 環)を、半透明の扁平球殻(Y 方向だけ
// 厚み分に潰した球)として描く。annulus のような内径のくり抜きは表現しないが、この規模の環は
// いずれも拡散した塵の雲でしかないので殻の見え方で足りる。
export function createTorusRing(color: number, opacity: number, innerRadius: number, outerRadius: number, thickness: number): THREE.Mesh {
  const meanRadius = (innerRadius + outerRadius) / 2;
  const geo = new THREE.SphereGeometry(1, 32, 16);
  const mat = new THREE.MeshBasicMaterial({ color, opacity, transparent: true, side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.scale.set(meanRadius, thickness / 2, meanRadius);
  mesh.frustumCulled = false;
  return mesh;
}
