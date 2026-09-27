// 主推進器の体積プルーム(PlumeVolume)のケース。実機と同じ部品を、thruster モジュールの
// 噴射口 anchor(+Z が排気方向)へ実機と同じ形で同期して置く。外気密度・出力比・天体の
// 影の違いで、自由膨張の扇・外圧に絞られた流れ・散乱光の消失を見る。
import * as THREE from 'three/webgpu';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { PlumeVolume } from '../../src/render/dynamic/player/plume-volume';
import { sphereShadowBody } from '../../src/render/pipeline/shadow/body-shadow';
import { buildShipModuleModel } from '../../src/render/dynamic/ship/ship-module-models';
import { ShipModuleView } from '../../src/render/dynamic/ship/ship-module-view';
import { labCamera, SUN_DIR } from './lab-case';
import type { BodyShadow, ShadowBody } from '../../src/render/pipeline/shadow/body-shadow';
import type { SunLight } from '../../src/render/pipeline/sun-light';
import type { RenderStyle } from '../../src/render/render-style';
import type { RingMaterials } from '../../src/render/celestial/ring';
import type { CaseBuilder, LabCase, LabShot } from './lab-case';

// 噴射口 1 基の置き方。position は噴射口(プルームの根元)の描画座標、exhaust は排気方向、
// ratio は出力比 0..1。
interface NozzlePlacement {
  readonly position: THREE.Vector3;
  readonly exhaust: THREE.Vector3;
  readonly ratio: number;
}

// thruster モジュールとその噴射口 anchor、anchor へ同期するプルームの1組。
interface PlumeNozzle {
  readonly view: ShipModuleView;
  readonly anchor: THREE.Object3D;
  readonly volume: PlumeVolume;
  readonly ratio: number;
}

// thruster モジュール 1 基を組み、その噴射口 anchor に同期するプルームを器 effects へ登録する。
// プルームのメッシュは PlumeVolume が引数の scene へ直接足すので、lab のシーンにはこの器を
// objects 経由で載せる。
function nozzle(
  effects: THREE.Scene, id: string, nozzleIndex: number, ratio: number,
  sunLight: SunLight, bodyShadow: BodyShadow,
): PlumeNozzle {
  const definition = SHIP_MODULE_CATALOG.require('thruster-standard');
  const view = new ShipModuleView({
    id, modelId: definition.modelId, kind: 'thruster',
    hp: definition.maxHp, maxHp: definition.maxHp,
    deployed: null, burning: null,
    transform: { position: v3(), rotation: Q_IDENTITY },
  }, buildShipModuleModel);
  const anchor = view.semanticAnchor('thrust');
  if (anchor === null) throw new Error('thruster-standard module has no "thrust" anchor');
  return {
    view, anchor, ratio,
    volume: new PlumeVolume(effects, `plume-lab-${id}`, nozzleIndex, sunLight, bodyShadow),
  };
}

// object 配下の噴射口 anchor を、描画座標の position へ、anchor の +Z(排気方向)が
// direction を向くよう object を置き直す。
function aimNozzle(
  object: THREE.Object3D, anchor: THREE.Object3D,
  position: THREE.Vector3, direction: THREE.Vector3,
): void {
  object.updateMatrixWorld(true);
  const current = new THREE.Vector3(0, 0, 1)
    .applyQuaternion(anchor.getWorldQuaternion(new THREE.Quaternion()));
  const correction = new THREE.Quaternion()
    .setFromUnitVectors(current.normalize(), direction.clone().normalize());
  const arm = anchor.getWorldPosition(new THREE.Vector3()).sub(object.position);
  object.quaternion.premultiply(correction);
  object.position.copy(position).sub(arm.applyQuaternion(correction));
}

// placements の噴射口を置き、外気密度 ambientDensity [kg/m³] のプルームを撮るケースを組む。
// 噴射口と出力比は固定で、syncMotion(表示時刻)だけが揺れと明滅の位相を進める。
function plumeCase(
  placements: readonly NozzlePlacement[], ambientDensity: number,
  target: THREE.Vector3, cameraPosition: THREE.Vector3,
  shots: Readonly<Record<string, LabShot>>, shadowBodies: readonly ShadowBody[],
  sunLight: SunLight, bodyShadow: BodyShadow,
): LabCase {
  const effects = new THREE.Scene();
  const nozzles = placements.map((placement, index) => {
    const placed = nozzle(effects, `plume-${index}`, index, placement.ratio, sunLight, bodyShadow);
    aimNozzle(placed.view.object, placed.anchor, placement.position, placement.exhaust);
    return placed;
  });
  const syncMotion = (displayTime: number): void => {
    for (const placed of nozzles) {
      // anchor の world matrix を確定させてから実機と同じ sync の形へ渡す。
      placed.view.object.updateMatrixWorld(true);
      placed.volume.sync(placed.anchor, placed.ratio, ambientDensity, displayTime);
    }
  };
  syncMotion(0);
  const camera = labCamera();
  camera.position.copy(cameraPosition);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);
  return {
    objects: [...nozzles.map((placed) => placed.view.object), effects],
    camera,
    viewTarget: target,
    syncMotion,
    shadowBodies,
    shots,
    dispose: () => {
      for (const placed of nozzles) {
        placed.volume.dispose(effects);
        placed.view.dispose();
      }
    },
  };
}

// 外気密度 [kg/m³]。真空と地球の海面級(plume-shape が飽和する端)。
const VACUUM_DENSITY = 0;
const DENSE_DENSITY = 1.2;

// 真空: 外気 0 の自由膨張。全力 1 基の排気が半角 40° 級の広く短い扇になる。
function vacuum(_style: RenderStyle, _ringMaterials: RingMaterials, sunLight: SunLight, bodyShadow: BodyShadow): LabCase {
  const target = new THREE.Vector3(0, 0, -9);
  return plumeCase(
    [{ position: new THREE.Vector3(0, 0, 0), exhaust: new THREE.Vector3(0, 0, -1), ratio: 1 }],
    VACUUM_DENSITY, target, new THREE.Vector3(30, 10, 28),
    {
      // 側面: 扇の広がりと軸方向の減衰が読める向き。
      'plume-vacuum-side': {
        view: { cameraAzimuthDeg: 88, cameraElevationDeg: 5 },
      },
      // 後方: 排気の行く先からノズルを覗く。扇が正面へ開く。
      'plume-vacuum-aft': {
        view: { cameraAzimuthDeg: 178, cameraElevationDeg: 3, cameraDistanceLog: -0.05 },
      },
      // 斜め後方: 揺れの位相をずらした 1 枚。
      'plume-vacuum-oblique': {
        displayTime: 0.83,
        view: { cameraAzimuthDeg: 140, cameraElevationDeg: 18 },
      },
    },
    [], sunLight, bodyShadow,
  );
}

// 稠密(海面級): 外圧に絞られた細く長い流れ。低出力と全力を並べて出力比の違いを見る。
function dense(_style: RenderStyle, _ringMaterials: RingMaterials, sunLight: SunLight, bodyShadow: BodyShadow): LabCase {
  const target = new THREE.Vector3(0, 0, -32);
  return plumeCase(
    [
      { position: new THREE.Vector3(-10, 0, 0), exhaust: new THREE.Vector3(0, 0, -1), ratio: 0.3 },
      { position: new THREE.Vector3(10, 0, 0), exhaust: new THREE.Vector3(0, 0, -1), ratio: 1 },
    ],
    DENSE_DENSITY, target, new THREE.Vector3(60, 22, 55),
    {
      // 俯瞰: 2 本の流れが並び、出力比による長さ・濃さの違いが読める。
      'plume-dense-overhead': {
        view: { cameraAzimuthDeg: 95, cameraElevationDeg: 55 },
      },
      // 側面: 流れの輪郭を追う向き。手前は全力側。
      'plume-dense-side': {
        view: { cameraAzimuthDeg: 72, cameraElevationDeg: 10 },
      },
      // 後方: 排気の行く先から 2 基のノズルを覗く。
      'plume-dense-aft': {
        view: { cameraAzimuthDeg: 176, cameraElevationDeg: 4, cameraDistanceLog: -0.2 },
      },
    },
    [], sunLight, bodyShadow,
  );
}

// 影: 稠密の流れへ、恒星との間に置いた見えない天体の影を落とす。流れのほぼ全体が影へ
// 入る位置に球を置く — 残るのは出口近傍の自発光だけになり、流れが散乱光であることが
// そのまま見える。
function shadowed(_style: RenderStyle, _ringMaterials: RingMaterials, sunLight: SunLight, bodyShadow: BodyShadow): LabCase {
  const target = new THREE.Vector3(0, 0, -30);
  // 影は球から恒星方向と反対へ伸びる。流れの中点から恒星側へ 80 m の位置へ半径 25 m の球を
  // 置くと、排気軸との距離が噴射口 27 m・流れの中点 0 m・末端 27 m なので、噴射口のモジュールは
  // 日に当たったまま、流れのほぼ全体(z ≈ -3 〜 -58)が影へ入る。
  const shadowCenter = target.clone().addScaledVector(SUN_DIR, 80);
  return plumeCase(
    [{ position: new THREE.Vector3(0, 0, 0), exhaust: new THREE.Vector3(0, 0, -1), ratio: 1 }],
    DENSE_DENSITY, target, new THREE.Vector3(60, 22, 55),
    {
      'plume-shadow-side': {
        view: { cameraAzimuthDeg: 88, cameraElevationDeg: 5 },
      },
      'plume-shadow-aft': {
        view: { cameraAzimuthDeg: 176, cameraElevationDeg: 4, cameraDistanceLog: -0.2 },
      },
    },
    [sphereShadowBody(shadowCenter, 25)], sunLight, bodyShadow,
  );
}

export const PLUME_CASES = {
  'plume-vacuum': vacuum,
  'plume-dense': dense,
  'plume-shadow': shadowed,
} as const satisfies Record<string, CaseBuilder>;
