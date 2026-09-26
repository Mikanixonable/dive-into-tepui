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
import { ModularShipView } from '../../src/render/dynamic/ship/modular-ship-view';
import { WeaponDrives, type WeaponRecoilInput } from '../../src/render/dynamic/ship/weapon-drives';
import type { ShipModuleRenderInput } from '../../src/render/dynamic/ship/ship-render-contract';
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

// ドック寄り: 側面の建造ドック・ドッキングポートの取付構造と、船首のドッキングポートを
// 近距離で観察する。機軸を -Z へ向けた素直な姿勢で置き、側面ドックは main-tank の ±x、
// 上面のポートは +y、船首ポートはコックピット前端へ付く。
function dock(): LabCase {
  const assembly = new ShipAssembly(SHIP_MODULE_CATALOG, true);
  assembly.addRoot(module('cockpit-standard', 'cockpit'));
  assembly.prepend(module('docking-port-standard', 'bow-port'), 'cockpit');
  assembly.append(module('tank-6-main', 'main-tank'));
  assembly.connectSide(module('dock-standard', 'dock-left'), 'main-tank', 'side:-x');
  assembly.connectSide(module('docking-port-standard', 'port-top'), 'main-tank', 'side:+y');
  const obj = shipObject(assembly);
  obj.position.set(0, 0, -14);
  return {
    objects: [obj],
    camera: labCamera(),
    // 側面ドックの取付部(左舷 -x、main-tank 中央)をターゲットに据える。
    viewTarget: new THREE.Vector3(-3.5, 0, -9.5),
    shots: {
      // 側面ドックの取付構造: 左舷の斜め下から、脚と座板が船体曲面へ伏せる様子を見る。
      'modular-ship-dock-mount': {
        view: { cameraAzimuthDeg: -105, cameraElevationDeg: -5, cameraDistanceLog: -0.05,
          sunAzimuthDeg: -70, sunElevationDeg: 40 },
      },
      // 船体軸に沿って見る: ポート下面と船体曲面の隙間(浮き)が最も読める向き。
      'modular-ship-dock-gap': {
        view: { cameraAzimuthDeg: 170, cameraElevationDeg: 10, cameraDistanceLog: -0.15,
          sunAzimuthDeg: -85, sunElevationDeg: 45 },
      },
      // 結合面の機構: ポート正面から捕捉環・ペタル・気閘を見る。
      'modular-ship-dock-face': {
        view: { cameraAzimuthDeg: -85, cameraElevationDeg: 8, cameraDistanceLog: -0.2,
          sunAzimuthDeg: -75, sunElevationDeg: 20 },
      },
      // 船全体: 船首ポートと両側のドックの位置関係を一望する。
      'modular-ship-dock-wide': {
        view: { cameraAzimuthDeg: -50, cameraElevationDeg: 20, cameraDistanceLog: 0.45,
          sunAzimuthDeg: -60, sunElevationDeg: 30 },
      },
    },
  };
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

// 主推進器だけを切り出し、開放された機械部とノズルを後方から観察する。
function engine(): LabCase {
  const model = buildShipModuleModel('thruster-standard');
  model.position.set(0, 0, -25);
  return {
    objects: [model],
    camera: labCamera(),
    viewTarget: new THREE.Vector3(0, 0, -25),
    shots: {
      'modular-ship-engine-aft': {
        view: {
          cameraAzimuthDeg: 165, cameraElevationDeg: 20, cameraDistanceLog: -0.55,
          sunAzimuthDeg: 155, sunElevationDeg: 35,
        },
      },
      'modular-ship-engine-side': {
        view: {
          cameraAzimuthDeg: 105, cameraElevationDeg: 15, cameraDistanceLog: -0.55,
          sunAzimuthDeg: 125, sunElevationDeg: 30,
        },
      },
    },
  };
}

// 機関砲の砲架、砲身束、給弾部を同じ照明で多方向から観察する。
function weapon(): LabCase {
  const definition = SHIP_MODULE_CATALOG.require('weapon-gatling');
  const modules: readonly ShipModuleRenderInput[] = [{
    id: 'weapon', modelId: definition.modelId, kind: 'weapon', hp: definition.maxHp, maxHp: definition.maxHp,
    transform: { position: v3(), rotation: Q_IDENTITY }, deployed: null, burning: null,
  }];
  const view = new ModularShipView(buildShipModuleModel, undefined, false);
  view.sync(modules);
  view.object.position.set(0, 0, -20);
  const syncMotion = weaponMotion(view, modules, definition.abilities.fireRate ?? 0);
  return {
    objects: [view.object],
    camera: labCamera(),
    viewTarget: new THREE.Vector3(0, 0, -19.2),
    syncMotion,
    dispose: () => view.dispose(),
    shots: {
      'weapon-cradle-oblique': {
        view: { cameraAzimuthDeg: -35, cameraElevationDeg: 25, cameraDistanceLog: -0.22,
          sunAzimuthDeg: -30, sunElevationDeg: 45 },
      },
      'weapon-cradle-side': {
        view: { cameraAzimuthDeg: -85, cameraElevationDeg: 12, cameraDistanceLog: -0.22,
          sunAzimuthDeg: -60, sunElevationDeg: 35 },
      },
      'weapon-cradle-feed': {
        view: { cameraAzimuthDeg: 55, cameraElevationDeg: -20, cameraDistanceLog: -0.22,
          sunAzimuthDeg: 40, sunElevationDeg: -35 },
      },
      'weapon-feed-mouth': {
        view: { cameraAzimuthDeg: 75, cameraElevationDeg: -8, cameraDistanceLog: -0.5,
          sunAzimuthDeg: 80, sunElevationDeg: 40 },
      },
      'weapon-feed-exit': {
        view: { cameraAzimuthDeg: -75, cameraElevationDeg: 15, cameraDistanceLog: -0.5,
          sunAzimuthDeg: -80, sunElevationDeg: 45 },
      },
      'weapon-cradle-recoil': {
        displayTime: 0.562,
        view: { cameraAzimuthDeg: -65, cameraElevationDeg: 25, cameraDistanceLog: -0.32,
          sunAzimuthDeg: -30, sunElevationDeg: 45 },
      },
      'weapon-cradle-return': {
        displayTime: 0.59,
        view: { cameraAzimuthDeg: -65, cameraElevationDeg: 25, cameraDistanceLog: -0.32,
          sunAzimuthDeg: -30, sunElevationDeg: 45 },
      },
      'weapon-cradle-rest': {
        displayTime: 2.5,
        view: { cameraAzimuthDeg: -65, cameraElevationDeg: 25, cameraDistanceLog: -0.32,
          sunAzimuthDeg: -30, sunElevationDeg: 45 },
      },
    },
  };
}

// 静止姿勢から同じ射撃列を再生し、任意の時刻を同じ駆動履歴で観察できるようにする。
function weaponMotion(
  view: ModularShipView, modules: readonly ShipModuleRenderInput[], rate: number,
): (displayTime: number) => void {
  const anchors = view.semanticAnchors('weapon', '');
  const rest = anchors.map(anchor => ({ anchor, position: anchor.position.clone(), rotation: anchor.quaternion.clone() }));
  const interval = 1 / rate;
  return (displayTime) => {
    for (const pose of rest) {
      pose.anchor.position.copy(pose.position);
      pose.anchor.quaternion.copy(pose.rotation);
    }
    const drives = new WeaponDrives();
    const steps = Math.ceil(Math.max(0, displayTime) * 120);
    // 起動遅延のあとに連射し、離したあとの復座と惰性回転まで見る。
    for (let step = 0; step <= steps; step++) {
      const time = Math.min(step / 120, Math.max(0, displayTime));
      const firing = time >= 0.4 && time < 1.6;
      const shotIndex = Math.floor((Math.min(time, 1.59) - 0.55) / interval + 1e-9);
      const shots: readonly WeaponRecoilInput[] = shotIndex < 0 ? [] : [{
        moduleId: 'weapon', muzzleIndex: 0, firedAt: 0.55 + shotIndex * interval, cycleDuration: interval,
      }];
      drives.sync(view, modules, firing ? rate : 0, time, shots);
    }
    view.object.updateMatrixWorld(true);
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
  'modular-ship-dock': dock,
  'modular-ship-base': base,
  'modular-ship-separation': separation,
  'modular-ship-combat': combat,
  'modular-ship-engine': engine,
  'modular-ship-weapon': weapon,
  'modular-ship-deploying': deploying,
  'modular-ship-deployables': deployables,
  'modular-ship-deployables-stowed': deployablesStowed,
} as const satisfies Record<string, CaseBuilder>;
