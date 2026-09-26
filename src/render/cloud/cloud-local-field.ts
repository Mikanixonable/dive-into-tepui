// 接平面上の局所光学場を、天体固定の方向と高度から読む共通契約。
// 中心/東/北の基底・球面半径・格子の原点とセル寸法・層境界・有効角距離を一つの snapshot として
// 持ち、地表・大気・影の三経路が同じ規則で同じ場を読む。既存の cap UV は転用せず、log-map 座標と
// 高度層選択で構成し、領域外は透明を返す。
import * as THREE from 'three/webgpu';
import {
  and, atan, clamp, cross, dot, exp, float, Fn, If, int, length, Loop, max, min, or, select, sqrt,
  texture, uniform, uniformArray, vec2, vec4,
} from 'three/tsl';
import { cross as crossCpu, dot as dotCpu, len as lenCpu, v3 } from '../../math/vec3';
import type { Vec3 } from '../../math/vec3';
import {
  sampleCloudOpticalVolumeCpu, type CloudOpticalVolumeData, type CloudOpticalVolumeSample,
} from './cloud-optical-volume';
import type {
  BoolNode, FloatNode, FloatUniform, IntNode, Vec2Node, Vec3Node, Vec3Uniform, Vec4Node,
} from '../tsl-types';

// 場を張る接平面の座標・高度の規則。テクスチャの内容ではなく座標の契約だけを持つ。
export interface CloudLocalFieldFrame {
  // 接平面の中心。天体固定の単位方向。
  readonly centerDirection: Vec3;
  // 接平面の東と北。center と直交する単位ベクトルの右手系。
  readonly eastDirection: Vec3;
  readonly northDirection: Vec3;
  // 高度 0 の基準半径 [m]。正規化空間の長さ 1 がこの実寸にあたる。
  readonly sphereRadiusM: number;
  // 格子の西端・南端 [m]。接平面上の格子原点。
  readonly gridOriginEastM: number;
  readonly gridOriginNorthM: number;
  readonly cellWidthM: number;
  readonly cellHeightM: number;
  readonly gridWidth: number;
  readonly gridHeight: number;
  // 場が有効な、中心からの角距離の上限 [rad]。これを超える方向は透明。
  readonly maxAngularDistanceRad: number;
  // 連続する層の境界 [m]。下端を含み、内部境界は上側の層に属する。
  readonly layerEdgesM: readonly number[];
}

// sampler へ結ぶ、焼いた場とそれを張った frame の組。texture の所有権は供給源に残る。
export interface CloudLocalFieldBinding {
  readonly texture: THREE.DataArrayTexture;
  readonly frame: CloudLocalFieldFrame;
}

// 表示時刻と天体固定の中心方向から局所場の内容を導出する口。実装は game 層に置き、
// render 側はこの契約だけを見る。null はその時刻・位置に場を出さないことを示す。
export interface CloudLocalFieldSupply {
  derive(displayTimeSeconds: number, centerDirection: Vec3): CloudLocalFieldSupplyResult | null;
}

// derive が返す、焼く場の内容とそれを張る frame の組。data の格子寸法・層境界は frame と
// 一致していなければならない。
export interface CloudLocalFieldSupplyResult {
  readonly frame: CloudLocalFieldFrame;
  readonly data: CloudOpticalVolumeData;
}

export interface CloudLocalFieldOpticalPath {
  readonly liquidTau: number;
  readonly iceTau: number;
  readonly totalTau: number;
  readonly transmittance: number;
}

// 層の上限。uniform 配列の長さとしてシェーダへ展開される。
const MAX_LOCAL_LAYERS = 8;
// 未結合時に sampler が読む退避テクスチャ。配列型が焼かれるので、初期値も DataArrayTexture でなければならない。
const EMPTY_LOCAL_VOLUME = new THREE.DataArrayTexture(new Float32Array([0, 0]), 1, 1, 1);
EMPTY_LOCAL_VOLUME.format = THREE.RGFormat;
EMPTY_LOCAL_VOLUME.type = THREE.FloatType;
EMPTY_LOCAL_VOLUME.minFilter = THREE.LinearFilter;
EMPTY_LOCAL_VOLUME.magFilter = THREE.LinearFilter;
EMPTY_LOCAL_VOLUME.needsUpdate = true;

const VECTOR_TOLERANCE = 1e-10;
const NEG_INF = -1e30;
const POS_INF = 1e30;

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function validateUnitVector(vector: Vec3, name: string): void {
  requireFinite(vector.x, `${name}.x`);
  requireFinite(vector.y, `${name}.y`);
  requireFinite(vector.z, `${name}.z`);
  if (Math.abs(lenCpu(vector) - 1) > VECTOR_TOLERANCE) {
    throw new RangeError(`${name} must be a unit vector`);
  }
}

// frame の座標規則を検証する。格子寸法とテクスチャ深度の一致は bind 側で格子・場と突き合わせる。
export function validateCloudLocalFieldFrame(frame: CloudLocalFieldFrame): void {
  validateUnitVector(frame.centerDirection, 'centerDirection');
  validateUnitVector(frame.eastDirection, 'eastDirection');
  validateUnitVector(frame.northDirection, 'northDirection');
  requireFinite(frame.sphereRadiusM, 'sphereRadiusM');
  if (frame.sphereRadiusM <= 0) throw new RangeError('sphereRadiusM must be positive');
  requireFinite(frame.gridOriginEastM, 'gridOriginEastM');
  requireFinite(frame.gridOriginNorthM, 'gridOriginNorthM');
  requireFinite(frame.cellWidthM, 'cellWidthM');
  requireFinite(frame.cellHeightM, 'cellHeightM');
  if (frame.cellWidthM <= 0 || frame.cellHeightM <= 0) {
    throw new RangeError('cell dimensions must be positive');
  }
  if (!Number.isSafeInteger(frame.gridWidth) || frame.gridWidth <= 0
    || !Number.isSafeInteger(frame.gridHeight) || frame.gridHeight <= 0
    || !Number.isSafeInteger(frame.gridWidth * frame.gridHeight)) {
    throw new RangeError('grid dimensions must be positive safe integers');
  }
  requireFinite(frame.maxAngularDistanceRad, 'maxAngularDistanceRad');
  if (frame.maxAngularDistanceRad <= 0 || frame.maxAngularDistanceRad >= Math.PI / 2) {
    throw new RangeError('maxAngularDistanceRad must be between zero and π/2');
  }
  const { centerDirection: center, eastDirection: east, northDirection: north } = frame;
  if (Math.abs(dotCpu(center, east)) > VECTOR_TOLERANCE
    || Math.abs(dotCpu(center, north)) > VECTOR_TOLERANCE
    || Math.abs(dotCpu(east, north)) > VECTOR_TOLERANCE
    || dotCpu(crossCpu(east, north), center) < 1 - VECTOR_TOLERANCE) {
    throw new RangeError('frame basis must be orthogonal and right-handed');
  }
  if (!Array.isArray(frame.layerEdgesM) && !(frame.layerEdgesM instanceof Float32Array)) {
    throw new RangeError('layerEdgesM must be an array of boundaries');
  }
  if (frame.layerEdgesM.length < 2 || frame.layerEdgesM.length - 1 > MAX_LOCAL_LAYERS) {
    throw new RangeError(`layerEdgesM must describe between 1 and ${MAX_LOCAL_LAYERS} layers`);
  }
  for (let index = 0; index < frame.layerEdgesM.length; index += 1) {
    const edge = frame.layerEdgesM[index]!;
    if (!Number.isFinite(edge) || edge < 0
      || (index > 0 && edge <= frame.layerEdgesM[index - 1]!)) {
      throw new RangeError('layerEdgesM must be finite, non-negative, and strictly increasing');
    }
  }
}

// 方向の log-map 座標。cloud-event-local-deposition の投影と同じ式 — 距離は球面の角距離で、
// 高度は水平位置へ寄与しない。領域(有効角距離)の外では null を返し、読み手は透明とする。
export function cloudLocalUvAt(
  direction: Vec3, frame: CloudLocalFieldFrame,
): { readonly u: number; readonly v: number; readonly eastM: number; readonly northM: number } | null {
  validateUnitVector(direction, 'direction');
  const { centerDirection: center, eastDirection: east, northDirection: north } = frame;
  const sine = lenCpu(crossCpu(center, direction));
  const cosine = Math.max(-1, Math.min(1, dotCpu(center, direction)));
  const angle = Math.atan2(sine, cosine);
  if (angle > frame.maxAngularDistanceRad) return null;
  const distanceM = frame.sphereRadiusM * angle;
  const scale = angle === 0 ? 0 : distanceM / sine;
  const eastM = scale * dotCpu(direction, east);
  const northM = scale * dotCpu(direction, north);
  return {
    u: (eastM - frame.gridOriginEastM) / (frame.gridWidth * frame.cellWidthM),
    v: (northM - frame.gridOriginNorthM) / (frame.gridHeight * frame.cellHeightM),
    eastM,
    northM,
  };
}

// log-map の逆写像。接平面上の (eastM, northM) へ置かれた方向を返す。
export function cloudLocalDirectionAt(eastM: number, northM: number, frame: CloudLocalFieldFrame): Vec3 {
  requireFinite(eastM, 'eastM');
  requireFinite(northM, 'northM');
  const distanceM = Math.hypot(eastM, northM);
  const angle = distanceM / frame.sphereRadiusM;
  requireFinite(angle, 'angle');
  if (angle > frame.maxAngularDistanceRad) {
    throw new RangeError('local position is outside the field domain');
  }
  if (angle === 0) return v3(frame.centerDirection.x, frame.centerDirection.y, frame.centerDirection.z);
  const sine = Math.sin(angle);
  const cosine = Math.cos(angle);
  const scale = sine / distanceM;
  return v3(
    frame.centerDirection.x * cosine + (frame.eastDirection.x * eastM + frame.northDirection.x * northM) * scale,
    frame.centerDirection.y * cosine + (frame.eastDirection.y * eastM + frame.northDirection.y * northM) * scale,
    frame.centerDirection.z * cosine + (frame.eastDirection.z * eastM + frame.northDirection.z * northM) * scale,
  );
}

// 高度の層番号。下端を含み、内部境界は上側の層へ属し、最上端は最終層。領域外は null。
export function cloudLocalLayerIndexAt(altitudeM: number, frame: CloudLocalFieldFrame): number | null {
  requireFinite(altitudeM, 'altitudeM');
  const edges = frame.layerEdgesM;
  if (altitudeM < edges[0]! || altitudeM > edges[edges.length - 1]!) return null;
  if (altitudeM === edges[edges.length - 1]) return edges.length - 2;
  let layer = 0;
  for (let index = 1; index < edges.length - 1; index += 1) {
    if (altitudeM >= edges[index]!) layer = index;
  }
  return layer;
}

// 場の層境界と frame の層境界の一致を検査する。層選びの正本は frame 側なので、
// ずれていれば読む層が食い違う。
function requireMatchingLayerEdges(data: CloudOpticalVolumeData, frame: CloudLocalFieldFrame): void {
  const baked = data.layerEdgesM;
  const framed = frame.layerEdgesM;
  if (baked.length !== framed.length) {
    throw new RangeError('volume layer edges must match the frame layer edges');
  }
  for (let index = 0; index < baked.length; index += 1) {
    if (baked[index] !== framed[index]) {
      throw new RangeError('volume layer edges must match the frame layer edges');
    }
  }
}

// 方向と高度の消散を CPU で読む。領域外・高度外は透明。
export function sampleCloudLocalFieldCpu(
  data: CloudOpticalVolumeData,
  direction: Vec3,
  altitudeM: number,
  frame: CloudLocalFieldFrame,
): CloudOpticalVolumeSample {
  requireMatchingLayerEdges(data, frame);
  const uv = cloudLocalUvAt(direction, frame);
  const layer = cloudLocalLayerIndexAt(altitudeM, frame);
  if (uv === null || uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1 || layer === null) {
    return { liquidExtinctionPerM: 0, iceExtinctionPerM: 0 };
  }
  return sampleCloudOpticalVolumeCpu(data, uv.u, uv.v, altitudeM);
}

interface SlabInterval {
  readonly start: number;
  readonly end: number;
}

// 正規化空間の直線光路が、frame の有効角距離の円錐内を通る区間。円錐の内側判定は
// (p·center)² >= cos²A·|p|² かつ p·center > 0 の二次式で、交差しない光路や狭角域を外れる
// 光路を切る — 切らないと、格子域を含まない数百 km の弦を少数の標本で分割してしまう。
function coneSegments(
  b: number, cSq: number, positionCenter: number, directionCenter: number, maxAngularRad: number,
): readonly SlabInterval[] {
  const cosineSq = Math.cos(maxAngularRad) ** 2;
  // f(t) = (pc + dc t)² - cos²A·(pp + 2 b t + t²) = a t² + 2·halfB·t + c。円錐内は f >= 0。
  const a = directionCenter * directionCenter - cosineSq;
  const halfB = positionCenter * directionCenter - cosineSq * b;
  const c = positionCenter * positionCenter - cosineSq * cSq;
  const inside: SlabInterval[] = [];
  const EPS = 1e-12;
  if (Math.abs(a) < EPS) {
    if (Math.abs(halfB) >= EPS) {
      const root = -c / (2 * halfB);
      inside.push(halfB > 0
        ? { start: root, end: POS_INF } : { start: NEG_INF, end: root });
    } else if (c >= 0) {
      inside.push({ start: NEG_INF, end: POS_INF });
    }
  } else {
    const discriminant = halfB * halfB - a * c;
    if (discriminant < 0) {
      // 境界を一度も切らない。a > 0 は放物線が上に開くので全線が内側。
      if (a > 0 && positionCenter > 0) inside.push({ start: NEG_INF, end: POS_INF });
    } else {
      const half = Math.sqrt(discriminant);
      const r0 = (-halfB - half) / a;
      const r1 = (-halfB + half) / a;
      const low = Math.min(r0, r1);
      const high = Math.max(r0, r1);
      if (a < 0) inside.push({ start: low, end: high });
      else inside.push({ start: NEG_INF, end: low }, { start: high, end: POS_INF });
    }
  }
  // 頂点前方の半空間 pc + dc t > 0 でさらに切る。
  const front = directionCenter > EPS ? { start: -positionCenter / directionCenter, end: POS_INF }
    : directionCenter < -EPS ? { start: NEG_INF, end: -positionCenter / directionCenter }
      : positionCenter > 0 ? { start: NEG_INF, end: POS_INF } : null;
  if (front === null) return [];
  return inside
    .map((segment) => ({
      start: Math.max(segment.start, front.start),
      end: Math.min(segment.end, front.end),
    }))
    .filter((segment) => segment.end > segment.start);
}

// positionN から directionN へ向かう正規化空間(|位置|=1 が地表)の直線光路を、等分中点細分で
// 積分する。GPU の localOpticalPathAt と同じ規則 — 各標本の log-map・層選択・領域判定が揃う
// ことが CPU/GPU 一致の検査対象で、積分の刻み方は実装側の共通定義。
export function integrateCloudLocalFieldRayCpu(
  positionN: Vec3,
  directionN: Vec3,
  data: CloudOpticalVolumeData,
  frame: CloudLocalFieldFrame,
  steps = 32,
): CloudLocalFieldOpticalPath {
  validateCloudLocalFieldFrame(frame);
  validateUnitVector(directionN, 'directionN');
  requireFinite(positionN.x, 'positionN.x');
  requireFinite(positionN.y, 'positionN.y');
  requireFinite(positionN.z, 'positionN.z');
  if (!Number.isSafeInteger(steps) || steps <= 0) throw new RangeError('steps must be a positive integer');
  if (data.width !== frame.gridWidth || data.height !== frame.gridHeight) {
    throw new RangeError('volume dimensions must match the frame grid');
  }
  requireMatchingLayerEdges(data, frame);
  const radius = frame.sphereRadiusM;
  const edges = frame.layerEdgesM;
  const innerRadiusN = 1 + edges[0]! / radius;
  const outerRadiusN = 1 + edges[edges.length - 1]! / radius;
  const b = dotCpu(positionN, directionN);
  const cSq = dotCpu(positionN, positionN);

  // 殻区間は外側球の弦から内側球の弦を引いた差集合で、高々 2 区間になる。内側球の中から
  // 出てくる光路(地表の受け手から立ち上がるもの)は後半の区間だけを取る。
  const outerDisc = b * b - (cSq - outerRadiusN * outerRadiusN);
  const innerDisc = b * b - (cSq - innerRadiusN * innerRadiusN);
  const slab: SlabInterval[] = [];
  if (outerDisc > 0) {
    const outerHalf = Math.sqrt(outerDisc);
    const outer0 = -b - outerHalf;
    const outer1 = -b + outerHalf;
    const inner0 = innerDisc > 0 ? -b - Math.sqrt(innerDisc) : POS_INF;
    const inner1 = innerDisc > 0 ? -b + Math.sqrt(innerDisc) : NEG_INF;
    slab.push({ start: Math.max(0, outer0), end: Math.min(outer1, inner0) });
    if (innerDisc > 0) {
      slab.push({ start: Math.max(0, outer0, inner1), end: outer1 });
    }
  }
  const cone = coneSegments(
    b, cSq,
    dotCpu(positionN, frame.centerDirection), dotCpu(directionN, frame.centerDirection),
    frame.maxAngularDistanceRad,
  );
  const intervals: SlabInterval[] = [];
  for (const slabSegment of slab) {
    for (const coneSegment of cone) {
      const start = Math.max(0, slabSegment.start, coneSegment.start);
      const end = Math.min(slabSegment.end, coneSegment.end);
      if (end > start) intervals.push({ start, end });
    }
  }

  let liquidTau = 0;
  let iceTau = 0;
  for (const interval of intervals) {
    const stepLengthM = (interval.end - interval.start) * radius / steps;
    for (let index = 0; index < steps; index += 1) {
      const t = interval.start + (index + 0.5) / steps * (interval.end - interval.start);
      const point = v3(
        positionN.x + directionN.x * t,
        positionN.y + directionN.y * t,
        positionN.z + directionN.z * t,
      );
      const pointLength = lenCpu(point);
      const direction = v3(point.x / pointLength, point.y / pointLength, point.z / pointLength);
      const altitudeM = (pointLength - 1) * radius;
      const uv = cloudLocalUvAt(direction, frame);
      const layer = cloudLocalLayerIndexAt(altitudeM, frame);
      if (uv === null || uv.u < 0 || uv.u > 1 || uv.v < 0 || uv.v > 1 || layer === null) continue;
      const sample = sampleCloudOpticalVolumeCpu(data, uv.u, uv.v, altitudeM);
      liquidTau += sample.liquidExtinctionPerM * stepLengthM;
      iceTau += sample.iceExtinctionPerM * stepLengthM;
    }
  }
  const totalTau = liquidTau + iceTau;
  if (!Number.isFinite(totalTau)) throw new RangeError('local field optical depth must be finite');
  return { liquidTau, iceTau, totalTau, transmittance: Math.exp(-totalTau) };
}

// 局所場を GPU から読む sampler。frame の値は uniform で保持し、焼いた側と同じ座標規則で読む。
// 差し込まれたテクスチャは借り物で、解放は差し込んだ側が行う。
export class CloudLocalFieldSampler {
  private readonly volume = texture(EMPTY_LOCAL_VOLUME);
  private readonly enabled = uniform(0);
  private readonly center: Vec3Uniform = uniform(new THREE.Vector3(0, 0, 1));
  private readonly east: Vec3Uniform = uniform(new THREE.Vector3(1, 0, 0));
  private readonly north: Vec3Uniform = uniform(new THREE.Vector3(0, 1, 0));
  private readonly sphereRadiusM: FloatUniform = uniform(1);
  private readonly gridOriginEastM: FloatUniform = uniform(0);
  private readonly gridOriginNorthM: FloatUniform = uniform(0);
  private readonly inverseSpanEast: FloatUniform = uniform(1);
  private readonly inverseSpanNorth: FloatUniform = uniform(1);
  private readonly maxAngularDistanceRad: FloatUniform = uniform(0);
  private readonly layerCount = uniform(0);
  private readonly layerEdges = uniformArray(
    Array.from({ length: MAX_LOCAL_LAYERS + 1 }, () => 0),
  );

  // 焼いた場と、その座標規則を写し取る。テクスチャの所有権は移らない。
  public bind(binding: CloudLocalFieldBinding | null): void {
    if (binding === null) {
      this.enabled.value = 0;
      // sampleLocalOptical は結んだ側がテクスチャを破棄したあともフェッチを残すので、
      // 参照ごと退避テクスチャへ戻す。
      this.volume.value = EMPTY_LOCAL_VOLUME;
      return;
    }
    validateCloudLocalFieldFrame(binding.frame);
    const image = binding.texture.image as {
      readonly width: number; readonly height: number; readonly depth: number;
    };
    if (image.depth !== binding.frame.layerEdgesM.length - 1) {
      throw new RangeError('local field texture depth must match the frame layer count');
    }
    if (image.width !== binding.frame.gridWidth || image.height !== binding.frame.gridHeight) {
      throw new RangeError('local field texture dimensions must match the frame grid');
    }
    const frame = binding.frame;
    this.volume.value = binding.texture;
    this.center.value.set(frame.centerDirection.x, frame.centerDirection.y, frame.centerDirection.z);
    this.east.value.set(frame.eastDirection.x, frame.eastDirection.y, frame.eastDirection.z);
    this.north.value.set(frame.northDirection.x, frame.northDirection.y, frame.northDirection.z);
    this.sphereRadiusM.value = frame.sphereRadiusM;
    this.gridOriginEastM.value = frame.gridOriginEastM;
    this.gridOriginNorthM.value = frame.gridOriginNorthM;
    this.inverseSpanEast.value = 1 / (frame.gridWidth * frame.cellWidthM);
    this.inverseSpanNorth.value = 1 / (frame.gridHeight * frame.cellHeightM);
    this.maxAngularDistanceRad.value = frame.maxAngularDistanceRad;
    this.layerCount.value = frame.layerEdgesM.length - 1;
    for (let index = 0; index < this.layerEdges.array.length; index += 1) {
      this.layerEdges.array[index] = frame.layerEdgesM[index] ?? 0;
    }
    this.enabled.value = 1;
  }

  // 方向の log-map 座標と、領域内かの判定。CPU の cloudLocalUvAt と同じ式。
  // 中間を .toVar() へ逃がさない純粋式にしておくと、Fn のスタックの外(診断グラフの組み立て
  // だけの文脈)からも組める。
  public localUvAt(direction: Vec3Node): { readonly uv: Vec2Node; readonly inside: BoolNode } {
    const cosine = clamp(dot(direction, this.center), -1, 1);
    const sine = length(cross(this.center, direction));
    // atan(sine, cosine) は atan2。acos(cosine) は小さい角度で桁落ちして位置誤差が
    // セル幅を超えるので使わない。
    const angle = atan(sine, cosine);
    const scale = this.sphereRadiusM.mul(angle).div(max(sine, 1e-9));
    const eastM = scale.mul(dot(direction, this.east));
    const northM = scale.mul(dot(direction, this.north));
    const u = eastM.sub(this.gridOriginEastM).mul(this.inverseSpanEast);
    const v = northM.sub(this.gridOriginNorthM).mul(this.inverseSpanNorth);
    const inside = and(
      angle.lessThanEqual(this.maxAngularDistanceRad),
      and(
        and(u.greaterThanEqual(0), u.lessThanEqual(1)),
        and(v.greaterThanEqual(0), v.lessThanEqual(1)),
      ),
    );
    return { uv: vec2(u, v), inside };
  }

  // uniformArray の要素は unknown 型で返るので、float の層境界として読む口だけここへ集める。
  private edgeAt(index: number | IntNode): FloatNode {
    return this.layerEdges.element(index) as unknown as FloatNode;
  }

  // 高度の層番号。下端を含み内部境界は上側の層へ — { i in [1,count) : edge[i] <= altitude }。
  private localLayerAt(altitudeM: FloatNode): FloatNode {
    let layer: FloatNode = float(0);
    for (let index = 1; index < MAX_LOCAL_LAYERS; index += 1) {
      layer = layer.add(select(
        and(int(index).lessThan(int(this.layerCount)),
          altitudeM.greaterThanEqual(this.edgeAt(index))),
        float(1), float(0),
      ));
    }
    return layer;
  }

  // 範囲外の高度が読み取る層を層数-1へ留める。
  private localLayerClamped(altitudeM: FloatNode): FloatNode {
    return min(this.localLayerAt(altitudeM), this.layerCount.sub(1));
  }

  // 単位方向 direction と高度 altitudeM [m] の消散。領域外・高度外・未結合では透明を返す
  // — 縁の値が外へ伸びないよう領域判定で 0 を選ぶ。
  public sampleLocalOptical(
    direction: Vec3Node, altitudeM: FloatNode,
  ): { readonly liquidExtinctionPerM: FloatNode; readonly iceExtinctionPerM: FloatNode } {
    const { uv, inside } = this.localUvAt(direction);
    const edgeLow = this.edgeAt(0);
    const edgeHigh = this.edgeAt(int(this.layerCount));
    const inAltitude = and(
      altitudeM.greaterThanEqual(edgeLow), altitudeM.lessThanEqual(edgeHigh),
    );
    const texel = this.volume.sample(uv).depth(int(this.localLayerClamped(altitudeM))).level(float(0));
    const present = and(
      and(this.enabled.greaterThan(0.5), inside), inAltitude,
    );
    return {
      liquidExtinctionPerM: select(present, texel.r, float(0)),
      iceExtinctionPerM: select(present, texel.g, float(0)),
    };
  }

  // 正規化空間(|位置|=1 が地表)の直線光路を、体積の球殻との交差区間を有効角距離の円錐で
  // 切ったあと等分中点細分で積分する。CPU の integrateCloudLocalFieldRayCpu と同じ規則。
  // 戻り値は (液水 tau, 氷 tau, 合計 tau, 透過率)。
  public localOpticalPathAt(positionN: Vec3Node, directionN: Vec3Node, steps = 32): Vec4Node {
    const sampler = this;
    return Fn(() => {
      const liquidTau = float(0).toVar();
      const iceTau = float(0).toVar();
      If(sampler.enabled.greaterThan(0.5), () => {
        const radius = sampler.sphereRadiusM;
        const innerRadiusN = float(1).add(sampler.edgeAt(0).div(radius)).toVar();
        const outerRadiusN = float(1)
          .add(sampler.edgeAt(int(sampler.layerCount)).div(radius)).toVar();
        const b = dot(positionN, directionN).toVar();
        const cSq = dot(positionN, positionN).toVar();
        const outerDisc = b.mul(b).sub(cSq.sub(outerRadiusN.mul(outerRadiusN))).toVar();
        const innerDisc = b.mul(b).sub(cSq.sub(innerRadiusN.mul(innerRadiusN))).toVar();
        const outerHalf = sqrt(max(outerDisc, 0));
        const innerHalf = sqrt(max(innerDisc, 0));
        const outer0 = b.negate().sub(outerHalf);
        const outer1 = b.negate().add(outerHalf);
        const inner0 = b.negate().sub(innerHalf);
        const inner1 = b.negate().add(innerHalf);
        // 殻区間は外側球の弦 - 内側球の弦。内側球の中から出る光路は後半の区間を取る。
        const insideInner = innerDisc.greaterThan(0);
        const slabIntervals: Vec2Node[] = [
          vec2(max(outer0, 0), select(insideInner, min(outer1, inner0), outer1)),
          vec2(max(max(outer0, 0), inner1), outer1),
        ];
        const slabValid = [
          outerDisc.greaterThan(0),
          and(outerDisc.greaterThan(0), insideInner),
        ];

        // 円錐区間。CPU の coneSegments と同じ係数で、退化は select で空区間へ潰す。
        const positionCenter = dot(positionN, sampler.center).toVar();
        const directionCenter = dot(directionN, sampler.center).toVar();
        const cosineSq = this.maxAngularDistanceRadCosineSq().toVar();
        const a = directionCenter.mul(directionCenter).sub(cosineSq).toVar();
        const halfB = positionCenter.mul(directionCenter).sub(cosineSq.mul(b)).toVar();
        const c = positionCenter.mul(positionCenter).sub(cosineSq.mul(cSq)).toVar();
        const discriminant = halfB.mul(halfB).sub(a.mul(c)).toVar();
        const rootHalf = sqrt(max(discriminant, 0));
        const safeA = select(a.abs().greaterThan(1e-12), a, float(1e-12));
        const r0 = halfB.negate().sub(rootHalf).div(safeA);
        const r1 = halfB.negate().add(rootHalf).div(safeA);
        const low = min(r0, r1);
        const high = max(r0, r1);
        // 退化判定: 線形根は halfB != 0 のときだけ意味を持つ。
        const linearRoot = select(halfB.abs().greaterThan(1e-12),
          c.negate().div(halfB.mul(2)), float(POS_INF));
        const coneInsideCandidates: Vec2Node[] = [
          // a < 0 の放物線が根の間で正: [low, high]
          vec2(low, high).toVar(),
          // a > 0 の放物線が根の外側で正: [-INF, low] と [high, INF]
          vec2(float(NEG_INF), low).toVar(),
          vec2(high, float(POS_INF)).toVar(),
          // a ≈ 0 の線形退化
          vec2(
            select(halfB.greaterThan(1e-12), linearRoot, float(NEG_INF)),
            select(halfB.greaterThan(1e-12), float(POS_INF), linearRoot),
          ).toVar(),
          // discriminant <= 0 かつ a > 0 かつ前方: 全線が内側
          vec2(float(NEG_INF), float(POS_INF)).toVar(),
        ];
        const aNeg = a.lessThan(-1e-12);
        const aPos = a.greaterThan(1e-12);
        const aFlat = a.abs().lessThanEqual(1e-12);
        const discPos = discriminant.greaterThan(0);
        const halfBPos = halfB.abs().greaterThan(1e-12);
        const coneValid = [
          and(discPos, aNeg),
          and(discPos, aPos),
          and(discPos, aPos),
          // a ≈ 0 の線形退化は discriminant に関わらず線形根で切る(CPU と同じ枝)。
          and(aFlat, halfBPos),
          // 交差なしで全線が内側になるのは、線形退化の c >= 0 か、a > 0 で前方のときだけ。
          or(
            and(aFlat, and(halfBPos.not(), c.greaterThanEqual(0))),
            and(discPos.not(), and(aPos, positionCenter.greaterThan(0))),
          ),
        ];
        // 頂点前方の半空間 pc + dc t > 0。
        const frontStart = select(directionCenter.greaterThan(1e-12),
          positionCenter.negate().div(directionCenter), float(NEG_INF));
        const frontEnd = select(directionCenter.lessThan(-1e-12),
          positionCenter.negate().div(directionCenter), float(POS_INF));
        const frontEmpty = and(directionCenter.abs().lessThanEqual(1e-12),
          positionCenter.lessThanEqual(0));

        for (let slabIndex = 0; slabIndex < slabIntervals.length; slabIndex += 1) {
          for (let coneIndex = 0; coneIndex < coneInsideCandidates.length; coneIndex += 1) {
            const slabSegment = slabIntervals[slabIndex]!;
            const coneSegment = coneInsideCandidates[coneIndex]!;
            const start = max(max(slabSegment.x, coneSegment.x), max(frontStart, 0));
            const end = min(min(slabSegment.y, coneSegment.y), frontEnd);
            const usable = and(
              and(slabValid[slabIndex]!, coneValid[coneIndex]!), frontEmpty.not(),
            );
            If(and(usable, end.greaterThan(start)), () => {
              const stepLength = end.sub(start).div(steps).mul(radius);
              Loop({ start: 0, end: steps, type: 'int', condition: '<' }, ({ i }) => {
                const t = start.add(float(i).add(0.5).div(steps).mul(end.sub(start)));
                const point = positionN.add(directionN.mul(t)).toVar();
                const pointLength = max(length(point), 1e-9);
                const direction = point.div(pointLength);
                const altitudeM = pointLength.sub(1).mul(radius);
                const { uv, inside } = sampler.localUvAt(direction);
                const texel = sampler.volume.sample(uv)
                  .depth(int(sampler.localLayerClamped(altitudeM))).level(float(0));
                liquidTau.addAssign(select(inside, texel.r, float(0)).mul(stepLength));
                iceTau.addAssign(select(inside, texel.g, float(0)).mul(stepLength));
              });
            });
          }
        }
      });
      const totalTau = liquidTau.add(iceTau);
      return vec4(liquidTau, iceTau, totalTau, exp(totalTau.negate()));
    })() as Vec4Node;
  }

  // cos²A は円錐区間の係数で毎回使う。uniform の cos をそのまま使う。
  private maxAngularDistanceRadCosineSq(): FloatNode {
    const cosine = this.maxAngularDistanceRad.cos();
    return cosine.mul(cosine);
  }
}
