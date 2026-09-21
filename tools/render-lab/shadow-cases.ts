// 自機の影のケース。艦の自己影と遠い艦が落とす半影、影の枠を上回る艦の群れと小片群、環を持つ
// 小天体と艦のあいだに落ちる影を組む。
import * as THREE from 'three/webgpu';
import { createAnnulusRing, type RingMaterials } from '../../src/render/celestial/ring';
import { InstancedPool } from '../../src/render/instanced-pool';
import { sphereShadowBody } from '../../src/render/pipeline/shadow/body-shadow';
import { ringShadowBands } from '../../src/render/pipeline/shadow/ring-shadow';
import { randSym } from '../../src/math/random';
import {
  detachPoolMesh, GREY_SPHERE_ALBEDO, labCamera, OBLIQUE_SUN_DIR, SHIP_ROTATION_PORT, shipAt, sphere,
  type CaseBuilder, type LabCase,
} from './lab-case';
import type { RingBandDef } from '../../src/physics/celestial-body-def';
import type { RenderStyle } from '../../src/render/render-style';

// 環の面のローカル法線。帯のメッシュはこの向きが環軸へ重なる姿勢で組まれる。
const RING_LOCAL_AXIS = new THREE.Vector3(0, 1, 0);
// 環の帯を本体より後に描くための描画順。
const RING_RENDER_ORDER = 1;

// 環の帯を面として組み、中心 center・軸 axis(どちらも描画座標)の姿勢へ置く。帯の半径は
// 天体の中心から測ったメートルで受ける。
function ringDisc(
  bands: readonly RingBandDef[], bodyRadius: number, center: THREE.Vector3, axis: THREE.Vector3,
  ringMaterials: RingMaterials,
): THREE.Object3D {
  // 帯は「本体半径 = 1」の単位で組み、群の拡大で本体半径へ戻す。
  const group = new THREE.Group();
  group.position.copy(center);
  group.scale.setScalar(bodyRadius);
  group.quaternion.setFromUnitVectors(RING_LOCAL_AXIS, axis);
  for (const band of bands) {
    const visual = createAnnulusRing(
      band.optics, band.innerRadius / bodyRadius, band.outerRadius / bodyRadius, ringMaterials,
    );
    visual.object.traverse((object) => {
      object.renderOrder = RING_RENDER_ORDER;
      object.userData.ownsGeometry = true;
    });
    group.add(visual.object);
  }
  return group;
}

// 機軸の片端と側面の両方が見える姿勢を、左右に映したもの。
const SHIP_ROTATION_STARBOARD = new THREE.Euler(SHIP_ROTATION_PORT.x, -SHIP_ROTATION_PORT.y, -SHIP_ROTATION_PORT.z);
// 操縦席側の端を右上の手前へ向けた姿勢。OBLIQUE_SUN_DIR のもとで、操縦席まわりの放熱器と
// 太陽電池の影が、見えている船体の面へ落ちる。
const SHIP_ROTATION_SELF_SHADOW = new THREE.Euler(1.85, -0.93, 1.0);

// 小片 1 個の一辺 [m] と、散らばる範囲の半幅 [m]。
const DEBRIS_SIZE = 0.12;
const DEBRIS_SPREAD = 100;

// 決定的な擬似乱数(同じ絵を毎回撮るため)。
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

// 薬莢や破片と同じ形の枝(1 本の InstancedMesh に個体を詰めたプール)を、center のまわりへ
// 散らして返す。ゲーム本体と同じ InstancedPool を通すので、影パスから見た姿も同じになる。
function debrisPool(center: THREE.Vector3, count: number): THREE.Object3D {
  const host = new THREE.Scene();
  const geometry = new THREE.BoxGeometry(DEBRIS_SIZE, DEBRIS_SIZE, DEBRIS_SIZE);
  const material = new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 0.8, metalness: 0 });
  const pool = new InstancedPool(host, geometry, material, count);
  // 1 フレームぶんの個体を、決定的な乱数で位置と姿勢を散らして積む。
  const random = lcg(20260825);
  const piece = new THREE.Object3D();
  pool.beginFrame();
  for (let i = 0; i < count; i++) {
    piece.position.set(
      center.x + randSym(DEBRIS_SPREAD, random),
      center.y + randSym(DEBRIS_SPREAD, random),
      center.z + randSym(DEBRIS_SPREAD, random),
    );
    piece.rotation.set(random() * Math.PI, random() * Math.PI, random() * Math.PI);
    pool.push(piece);
  }
  pool.endFrame();
  return detachPoolMesh(host);
}

// 自機のケースで影を受ける艦の位置(描画座標)。艦の全体が画面に収まり、近い端が near 面より
// 奥に来る距離に置く。
const SHIP_RECEIVER_POSITION = new THREE.Vector3(0, 0, -28);
// 影を落とす 2 隻目を、受け手から +X へ離す距離 [m]。
const SHIP_FAR_CASTER_DISTANCE = 3000;

// 自機: 影を受ける艦と、+X へ遠く離した 2 隻目。2 隻目はどの撮影でも影の枠を求めるので、枠を
// 奪われて受け手の自己影が消えないかもここで読む。
function ship(): LabCase {
  const receiver = SHIP_RECEIVER_POSITION;
  return {
    objects: [
      shipAt(receiver, SHIP_ROTATION_SELF_SHADOW),
      shipAt(receiver.clone().setX(receiver.x + SHIP_FAR_CASTER_DISTANCE), SHIP_ROTATION_SELF_SHADOW),
    ],
    camera: labCamera(),
    sunDirection: OBLIQUE_SUN_DIR,
    viewTarget: receiver,
    shots: {
      // 斜光。突起の影が船体へ落ちる。
      'ship-selfshadow': { view: {} },
      // 逆光(被写体の向こう側の低い空から)。暗い船体の縁が背景の虚空と接する 1 画素を見る。**照度は
      // 画素の中心でしか求まらない**ので、縁を跨ぐ画素の材質と照度が食い違うと、ここに輪郭が浮く。
      'ship-backlit': { view: { sunAzimuthDeg: 180, sunElevationDeg: 5.14 } },
      // +X から差す恒星で、2 隻目の影が受け手へ届く。本影は影を落とす断面の最も細い幅(船体の直径
      // 6.2 m)の 1/(太陽の視直径 9.3e-3 rad) = 107.5 倍、約 670 m で消えるので、3 km 先に届くのは
      // 半影だけ。濃さは +X から見た艦の断面積(約 86 m²)を、3 km 先での太陽円盤の広がり
      // π(4.65e-3 × 3000 m)² ≈ 610 m² で割った 0.14 ほどまで落ちていなければならない。
      'ship-far-shadow': { view: { sunAzimuthDeg: 90, sunElevationDeg: 0 } },
    },
  };
}

// 艦の群れ: 影の枠の上限(MAX_SHADOW_SLOTS)より多い艦を、画面の上で互いを隠さない間隔に散らし、
// **枠が尽きたときに何が捨てられるか**を見る — 艦の数が枠の数を上回っていなければ意味がない。
// 先頭の艦のまわりには小片群を 1 本の枝として散らし、広い小片群の中でも自己影が残るかを読む。
function shipCrowd(): LabCase {
  // 画面上の向き(視線に対する横・縦の正接)と奥行き [m] の組で置く。
  const placements: readonly (readonly [number, number, number])[] = [
    [0, -0.02, 45],
    [0.52, 0.24, 65],
    [-0.52, 0.22, 60],
    [0.5, -0.26, 80],
    [-0.56, -0.26, 90],
    [0.02, 0.34, 100],
    [0.02, -0.36, 110],
  ];
  const positions = placements.map(([u, v, depth]) => new THREE.Vector3(u * depth, v * depth, -depth));
  return {
    objects: [
      ...positions.map((position) => shipAt(position, SHIP_ROTATION_SELF_SHADOW)),
      debrisPool(positions[0]!, 512),
    ],
    camera: labCamera(),
    sunDirection: OBLIQUE_SUN_DIR,
    viewTarget: positions[0]!,
  };
}

// 小天体のケースの寸法 [m]。艦(全長 16 m)と天体が同じ画面へ収まる大きさに取る。
const SMALL_BODY_RADIUS = 60;
const SMALL_BODY_DISTANCE = 260;

// 小天体の環の帯。半径は天体の中心から [m]。**帯の影は環軸と恒星のなす角の余弦(0.55)ぶんへ
// 縮む**ので、内縁 80 m の帯の影は中心から 44 m — 天体の半径 60 m の内側 — へ落ちる。
const SMALL_BODY_RING_BANDS: readonly RingBandDef[] = [
  {
    innerRadius: 80, outerRadius: 96, thickness: 0,
    optics: { normalOpticalDepth: 0.8, singleScatteringAlbedo: 0.6, phaseG: 0.3 },
  },
  {
    innerRadius: 104, outerRadius: 116, thickness: 0,
    optics: { normalOpticalDepth: 1.6, singleScatteringAlbedo: 0.6, phaseG: 0.3 },
  },
];

// 小天体のケースの恒星の向き。カメラ側の成分を 0.55 に取ると、昼面が画面へ大きく入りつつ
// 昼夜境界も残る。
const SMALL_BODY_SUN_DIR = new THREE.Vector3(0.479, 0.684, 0.550).normalize();

// 環の軸を恒星から傾ける角 [rad]。**倒す向きをカメラ側へ取ると環面が「視線と恒星の両方に
// 直交する向き」を含む**ので、その向きへ寄せた艦は環の帯の影から外れ、天体の球の影だけを受ける。
const SMALL_BODY_RING_TILT = 0.9885;

// 影を落とす艦を浮かべる高さ [m] と、その直下点の太陽天頂角・方位 [rad](方位 0 がカメラ側)。
// 天頂角 0 の直下点はカメラから見て縁へ寄るので倒し、方位は帯の影を避ける側へ振る。
const SMALL_BODY_SHIP_ALTITUDE = 40;
const SMALL_BODY_SHIP_ZENITH = 0.7;
const SMALL_BODY_SHIP_AZIMUTH = 0.68;

// 影を受ける艦を天体の後方へ置く距離 [m]。
const SMALL_BODY_SHADOW_DISTANCE = 200;

// 小天体と艦: 環を持つ小天体のまわりへ艦を 2 隻置き、**影の 2 つの経路を同じ絵で読む**。昼面へ
// 浮かべた艦は影の深度マップを通って天体の表面へ影を落とし、後方へ置いた艦は天体の球が解析式で
// 解く影の柱の縁をまたぐ。環の帯の影は昼面を横切る縞として出る。
function shipBodyShadow(_style: RenderStyle, ringMaterials: RingMaterials): LabCase {
  const camera = labCamera();
  const center = new THREE.Vector3(0, 0, -SMALL_BODY_DISTANCE);
  const sun = SMALL_BODY_SUN_DIR;
  // 恒星に直交する 2 つの向き。lateral はカメラ側を向き、edge は視線にも直交するので画面内で真横。
  const toCamera = new THREE.Vector3().subVectors(camera.position, center).normalize();
  const lateral = toCamera.clone().projectOnPlane(sun).normalize();
  const edge = new THREE.Vector3().crossVectors(toCamera, sun).normalize();
  const axis = sun.clone().multiplyScalar(Math.cos(SMALL_BODY_RING_TILT))
    .addScaledVector(lateral, -Math.sin(SMALL_BODY_RING_TILT));
  // 影を落とす艦は、直下点を天頂角・方位で決めてから恒星方向へ浮かせる。
  const subShip = sun.clone().multiplyScalar(Math.cos(SMALL_BODY_SHIP_ZENITH))
    .addScaledVector(lateral, Math.sin(SMALL_BODY_SHIP_ZENITH) * Math.cos(SMALL_BODY_SHIP_AZIMUTH))
    .addScaledVector(edge, Math.sin(SMALL_BODY_SHIP_ZENITH) * Math.sin(SMALL_BODY_SHIP_AZIMUTH));
  const caster = center.clone()
    .addScaledVector(subShip, SMALL_BODY_RADIUS)
    .addScaledVector(sun, SMALL_BODY_SHIP_ALTITUDE);
  // 影を受ける艦は、影の柱の縁(軸から天体の半径ぶん)へ重ねる。
  const receiver = center.clone()
    .addScaledVector(sun, -SMALL_BODY_SHADOW_DISTANCE)
    .addScaledVector(edge, SMALL_BODY_RADIUS);
  return {
    objects: [
      sphere(GREY_SPHERE_ALBEDO, SMALL_BODY_RADIUS, center),
      ringDisc(SMALL_BODY_RING_BANDS, SMALL_BODY_RADIUS, center, axis, ringMaterials),
      shipAt(caster, SHIP_ROTATION_STARBOARD),
      shipAt(receiver, SHIP_ROTATION_STARBOARD),
    ],
    camera,
    sunDirection: sun,
    viewTarget: center,
    shadowBodies: [sphereShadowBody(center, SMALL_BODY_RADIUS)],
    rings: { center, axis, bands: ringShadowBands(SMALL_BODY_RING_BANDS) },
  };
}

export const SHADOW_CASES = {
  'ship': ship,
  'ship-crowd': shipCrowd,
  'ship-body-shadow': shipBodyShadow,
} as const satisfies Record<string, CaseBuilder>;
