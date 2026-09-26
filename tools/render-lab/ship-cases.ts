// モジュール船のケース。基地へ寄港した船と建造ゴースト、分離の前後を、ゲーム本体と同じ組み立てと
// モデルで組む。
import * as THREE from 'three/webgpu';
import { Q_IDENTITY } from '../../src/math/quat';
import { v3 } from '../../src/math/vec3';
import { SHIP_MODULE_CATALOG } from '../../src/game/ship/ship-module-catalog';
import { createShipModuleInstance } from '../../src/game/ship/ship-module-instance';
import { ShipAssembly } from '../../src/game/ship/ship-assembly';
import { createBasePreset, createDefaultCombatPreset } from '../../src/game/ship/ship-presets';
import { splitAtDecoupler } from '../../src/game/ship/ship-decoupling';
import { DockSnapGuideView } from '../../src/render/dynamic/ship/dock-snap-guide-view';
import { buildShipModuleModel } from '../../src/render/dynamic/ship/ship-module-models';
import { ShipGhostView } from '../../src/render/dynamic/ship/ship-ghost-view';
import { labCamera, shipObject, type CaseBuilder, type LabCase } from './lab-case';

// カタログの定義 definitionId から、識別子 id のモジュールを1つ作る。
function module(definitionId: string, id: string) {
  return createShipModuleInstance(SHIP_MODULE_CATALOG.require(definitionId), id);
}

// 分離機を挟んでブースターを付けた船。
function separationPreset(): ShipAssembly {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(module('cockpit-standard', 'cockpit'));
  assembly.append(module('tank-3-main', 'tank'));
  assembly.append(module('decoupler-standard', 'decoupler'));
  assembly.append(module('booster-standard', 'booster'));
  return assembly;
}

// 基地の左の寄港口へ、小さな船を寄港させた組み。
function dockedPreset(): ShipAssembly {
  const vessel = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  vessel.addRoot(module('cockpit-standard', 'docked-cockpit'));
  vessel.prepend(module('docking-port-standard', 'docked-port'));
  vessel.append(module('tank-3-main', 'docked-tank'));
  return createBasePreset().mergedAtDock(vessel, 'dock-left', 'docked-port', 'docked').assembly;
}

// 物体を (x, y, z) [m] へ置き、機軸の端と側面の両方が見える姿勢へ回して返す。
function at(object: THREE.Object3D, x: number, y: number, z: number): THREE.Object3D {
  object.position.set(x, y, z);
  object.rotation.set(-0.35, 0.45, 0.08);
  return object;
}

// 基地: 船を寄港させた基地と、その右に建造ゴーストと吸着ガイドを置く。
function base(): LabCase {
  const docked = at(shipObject(dockedPreset()), -7, 0, -42);
  const ghost = new ShipGhostView(undefined, buildShipModuleModel, false);
  const guide = new DockSnapGuideView(undefined, false);
  // ゴーストは寄港した船にも基地にも重ならない位置に離し、ガイドはゴーストの奥の面へ付ける。
  ghost.sync({ modelId: 'tank-6-main', position: v3(12, 0, -36), rotation: Q_IDENTITY, valid: true });
  guide.sync({ position: v3(12, 0, -39.5), rotation: Q_IDENTITY, radius: 3, valid: true });
  return {
    objects: [docked, ghost.object, guide.object],
    camera: labCamera(),
    viewTarget: new THREE.Vector3(2, 0, -40),
  };
}

// 分離: 分離前の船と、分離機で分けた 2 隻を並べる。
function separation(): LabCase {
  const source = separationPreset();
  const split = splitAtDecoupler(source, 'decoupler');
  return {
    // 互いに重ならないよう、左から横一列に並べる。
    objects: [
      at(shipObject(source), -17, 0, -40),
      at(shipObject(split.retained), 1, 0, -40),
      at(shipObject(split.detached), 16, 0, -40),
    ],
    camera: labCamera(),
    viewTarget: new THREE.Vector3(0, 0, -40),
  };
}

// 太陽電池とラジエーターを展開度 deployed にした既定戦闘船。
function combatShipDeployed(deployed: number): ShipAssembly {
  const combatShip = createDefaultCombatPreset();
  for (const m of combatShip.modules) {
    if (m.kind === 'solar_panel' || m.kind === 'radiator') combatShip.setDeployment(m.id, deployed);
  }
  return combatShip;
}

// 戦闘艦: 展開された太陽電池とラジエーター、コックピット、タンク、推進器が美しく見える構図。
// 船尾の推進器と船首の機関砲へ寄った撮影も持つ。
function combat(): LabCase {
  const obj = at(shipObject(combatShipDeployed(1)), 0, -1, -25);
  obj.rotation.set(0.35, -2.35, 0.1);
  return {
    objects: [obj],
    camera: labCamera(),
    viewTarget: new THREE.Vector3(0, -1, -25),
    shots: {
      'modular-ship-combat': { view: {} },
      'modular-ship-combat-aft': { view: { cameraAzimuthDeg: 20, cameraElevationDeg: -10, cameraDistanceLog: 0 } },
      'modular-ship-combat-bow': { view: { cameraAzimuthDeg: -120, cameraElevationDeg: 25, cameraDistanceLog: -0.1, sunAzimuthDeg: -100, sunElevationDeg: 35 } },
    },
  };
}

// RCS タンクを単体で置き、赤い円筒トラス・銀箔球・配管と非対称な機器を多方向から観察する。
function rcsTank(): LabCase {
  const model = buildShipModuleModel('tank-3-rcs');
  model.position.set(0, 0, -25);
  return {
    objects: [model],
    camera: labCamera(),
    viewTarget: new THREE.Vector3(0, 0, -25),
    // トラス外周、配管側、タンク列上面を確認する3方向を登録する。
    shots: {
      'rcs-tank-truss-oblique': {
        view: { cameraAzimuthDeg: -42, cameraElevationDeg: 22, cameraDistanceLog: -0.42,
          sunAzimuthDeg: -35, sunElevationDeg: 38 },
      },
      'rcs-tank-truss-side': {
        view: { cameraAzimuthDeg: -88, cameraElevationDeg: 12, cameraDistanceLog: -0.42,
          sunAzimuthDeg: -50, sunElevationDeg: 32 },
      },
      'rcs-tank-truss-overhead': {
        view: { cameraAzimuthDeg: -20, cameraElevationDeg: 55, cameraDistanceLog: -0.42,
          sunAzimuthDeg: -45, sunElevationDeg: 35 },
      },
    },
  };
}

// 展開途中: 太陽電池とラジエーターの展開度を変えた戦闘艦を並べ、ヒンジの繋がりと収納時の重なりを見る。
function deploying(): LabCase {
  const objects = [0, 0.4, 0.8].map((deployed, index) => {
    const obj = at(shipObject(combatShipDeployed(deployed)), -22 + index * 22, 0, -45);
    obj.rotation.set(0.9, 0.3, 0.1);
    return obj;
  });
  return {
    objects,
    camera: labCamera(),
    viewTarget: new THREE.Vector3(0, 0, -45),
  };
}

// 展開部品の取付面(コックピット)が来る描画座標の高さ。機軸は +Z が艦首で、重心は取付面より
// 5.1 m 艦尾寄りにある — 物体を (0, 0, -14) へ置くと取付面が z = -8.9 に来る。
const DEPLOYABLES_SHIP_Z = -14;
const DEPLOYABLES_TARGET = new THREE.Vector3(0, 0, -8.9);

// 展開部品の寄り: 全展開の戦闘艦 1 隻を取付面へ寄せ、太陽電池翼のセル面・取付構造と
// ラジエーターの蛇腹・取付構造を大きく写す。
// 機軸を視線へ向けると、太陽電池の面は船体の ±x、蛇腹の面は船体の ±z を向く。だから
// 上の翼のセル面は左舷前方(方位 -50 度)、左の蛇腹の面は艦首側(方位 0 付近)から、
// 右の蛇腹の面は艦尾側(方位 +140 度)から見ると正面になる。
function deployables(): LabCase {
  const ship = shipObject(combatShipDeployed(1));
  ship.position.set(0, 0, DEPLOYABLES_SHIP_Z);
  return {
    objects: [ship],
    camera: labCamera(),
    viewTarget: DEPLOYABLES_TARGET,
    shots: {
      // 取付面の少し斜め前。機首の砲身を画面中央から外し、両舷の蛇腹と上下の翼の付け根を見る。
      'modular-ship-deployables': { view: { cameraAzimuthDeg: -20, cameraElevationDeg: 12 } },
      // 上の太陽電池翼: 面が -x を向くので左舷前方から、セル面とマウントを写す。
      'modular-ship-deployables-solar': {
        view: {
          cameraAzimuthDeg: -50, cameraElevationDeg: 22, cameraDistanceLog: 0.2,
          sunAzimuthDeg: -60, sunElevationDeg: 25,
        },
      },
      // 左の蛇腹: 上から降りて折り目の凹凸と配管を見る。面は艦首側を向くので既定の恒星で当たる。
      'modular-ship-deployables-radiator': {
        view: { cameraAzimuthDeg: -15, cameraElevationDeg: 50, cameraDistanceLog: 0.1 },
      },
      // 艦尾側: 面が -z を向く右の蛇腹と右舷の取付を後方から。恒星も艦尾側へ回す。
      'modular-ship-deployables-aft': {
        view: {
          cameraAzimuthDeg: 140, cameraElevationDeg: 15, cameraDistanceLog: 0.15,
          sunAzimuthDeg: 170, sunElevationDeg: 25,
        },
      },
    },
  };
}

// 収納の寄り: 同じ位置に収納した戦闘艦を置き、取付面へ積まれたパネル山とマウントを見る。
function deployablesStowed(): LabCase {
  const ship = shipObject(combatShipDeployed(0));
  ship.position.set(0, 0, DEPLOYABLES_SHIP_Z);
  return {
    objects: [ship],
    camera: labCamera(),
    viewTarget: DEPLOYABLES_TARGET,
    shots: {
      // 取付面の少し斜め前。左右の蛇腹山と上下のパネル山が並ぶ。
      'modular-ship-deployables-stowed': { view: { cameraAzimuthDeg: -20, cameraElevationDeg: 12 } },
      // さらに寄って、左舷側のパネル山とマウントを写す。
      'modular-ship-deployables-stowed-mount': {
        view: { cameraAzimuthDeg: -45, cameraElevationDeg: 20, cameraDistanceLog: -0.25 },
      },
    },
  };
}

export const SHIP_CASES = {
  'modular-ship-base': base,
  'modular-ship-separation': separation,
  'modular-ship-combat': combat,
  'modular-ship-rcs-tank': rcsTank,
  'modular-ship-deploying': deploying,
  'modular-ship-deployables': deployables,
  'modular-ship-deployables-stowed': deployablesStowed,
} as const satisfies Record<string, CaseBuilder>;
