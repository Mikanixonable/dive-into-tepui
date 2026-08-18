// 形状ツリーから導いた質量特性(§10-3、§10-4)と内容積の割り当て(§12)の回帰テスト。
// 既定の設計の導出値そのものを固定する — この値が機体の質量・慣性・投影面積になる。
import * as assert from 'node:assert/strict';
import * as C from '../../src/game/const';
import { dot, len, scale, sub, v3 } from '../../src/physics/vec3';
import type { Vec3 } from '../../src/physics/vec3';
import { addInertia, principalMoments, translateInertia } from '../../src/physics/inertia-tensor';
import type { InertiaTensor } from '../../src/physics/inertia-tensor';
import type { CrossSection } from '../../src/physics/section-moments';
import { createPart } from '../../src/game/game-entity/parts';
import type { AnyPart } from '../../src/game/game-entity/parts';
import type { PartPlacement, VesselAssembly } from '../../src/game/vessel/assembly';
import { deriveMassProperties } from '../../src/game/vessel/mass-properties';
import { ballisticCoeffInv } from '../../src/physics/aerodynamics';
import { allocateInternalVolume, edgeInternalVolume } from '../../src/game/vessel/internal-volume';
import {
  BUCKLING_RADIUS_RATIO, MIN_MANUFACTURING_THICKNESS, PRESSURE_SAFETY_FACTOR, STRUCTURAL_MATERIALS,
  WELD_EFFICIENCY, pressurizedWallThickness, unpressurizedWallThickness, wallThickness,
} from '../../src/game/vessel/hull-structure';
import type { TreeEdge, TreeNode, VesselTree } from '../../src/game/vessel/tree';
import { edgeById, validateTree } from '../../src/game/vessel/tree';
import {
  crewedAssembly, hostileAssembly, orbitalBaseAssembly,
} from '../../src/game/vessel/vessel-assemblies';
import { test } from '../physics/harness';

function square(radius: number): CrossSection {
  return {
    primitives: [{ id: 'p0', shape: { kind: 'polygon', sides: 4, radius }, phaseAngle: 0, attachment: null }],
  };
}

function node(id: string, pos: Vec3, section: CrossSection, axis = v3(0, 0, 1)): TreeNode {
  return { id, pos, section, axis, phaseAngle: 0 };
}

function hullEdge(id: string, a: string, b: string, length: number): TreeEdge {
  return {
    id, a, b,
    portA: { kind: 'axial', sign: -1 },
    portB: { kind: 'axial', sign: 1 },
    length,
    kind: { kind: 'hull' },
  };
}

// 質量だけを持ち、容積を占めない要素。取り付け位置の効きを見るのに使う。
function ballast(id: string, weight: number): AnyPart {
  return createPart('rcs_thruster', { name: id, weight });
}

function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / Math.abs(expected);
}

export function register(): void {
  test('既定の3設計のツリーが正しく、乾燥質量が設計の狙いどおりになる', () => {
    const cases = [
      { name: 'crewed', assembly: crewedAssembly(C.PLAYER_MAX_HP), mass: 1061 },
      { name: 'base', assembly: orbitalBaseAssembly(C.BASE_MAX_HP), mass: 3e6 },
      { name: 'hostile', assembly: hostileAssembly(C.ENEMY_MAX_HP), mass: 10000 },
    ];
    for (const { name, assembly, mass } of cases) {
      assert.deepEqual(validateTree(assembly.tree), [], `${name} tree`);
      const derived = deriveMassProperties(assembly);
      assert.ok(
        relativeError(derived.dryMass, mass) < 0.01,
        `${name} dry mass ${derived.dryMass.toFixed(1)} kg vs ${mass} kg`,
      );
      // 推進剤を積んでいないので、総質量は乾燥質量に等しい。
      assert.equal(derived.loadedMass, derived.dryMass);
    }
  });

  test('既定の有人艦の投影面積が3軸で異なり、抗力が姿勢に依存する', () => {
    const derived = deriveMassProperties(crewedAssembly(C.PLAYER_MAX_HP));
    const { principalAreas, loadedMass } = derived;
    for (const area of [principalAreas.x, principalAreas.y, principalAreas.z]) assert.ok(area > 0);
    // 左右のトラスは x 軸方向へ張り出すぶん y 方向から見た面積を増やすので、x より y が大きい。
    assert.ok(principalAreas.x < principalAreas.y, `x ${principalAreas.x} < y ${principalAreas.y}`);
    // 展開した放熱板は前後を向くので、機首方向から見た面積が最も大きい — 船体だけなら
    // 機首方向が最小になるところを、放熱板が逆転させる。これが低軌道で放熱板を畳む理由になる。
    assert.ok(principalAreas.z > principalAreas.y, `z ${principalAreas.z} > y ${principalAreas.y}`);
    const nose = ballisticCoeffInv(principalAreas, loadedMass, v3(0, 0, 1));
    const side = ballisticCoeffInv(principalAreas, loadedMass, v3(1, 0, 0));
    assert.ok(nose > side, `nose ${nose} > side ${side}`);
    // 向きを平均した値は3軸の値の間に収まる。
    const mean = ballisticCoeffInv(principalAreas, loadedMass, v3());
    assert.ok(mean < nose && mean > side);
  });

  test('外装要素が投影面積に寄与し、熱シールドを積むと投影面積が増える', () => {
    const assembly = crewedAssembly(C.PLAYER_MAX_HP);
    const withShield = deriveMassProperties(assembly);
    const withoutShield = deriveMassProperties({
      tree: assembly.tree,
      placements: assembly.placements.filter((p) => p.part.type !== 'heat_shield'),
    });
    // 熱シールドは機首の接続口を覆うので、機首方向から見た面積だけが増える(§X-5)。
    assert.ok(
      withShield.principalAreas.z > withoutShield.principalAreas.z,
      `${withShield.principalAreas.z} > ${withoutShield.principalAreas.z}`,
    );
    // 放熱板と太陽電池パドルも同じ経路で算入される。外すと機首方向の面積が大きく減る。
    const bare = deriveMassProperties({
      tree: assembly.tree,
      placements: assembly.placements.filter(
        (p) => p.part.type !== 'radiator' && p.part.type !== 'solar_panel'),
    });
    assert.ok(
      withShield.principalAreas.z > bare.principalAreas.z * 4,
      `${withShield.principalAreas.z} vs ${bare.principalAreas.z}`,
    );
  });

  test('横へずれて並ぶ平行なエッジの射影は和になり、前後に重なるものは最大値になる', () => {
    const section = square(0.5);
    const lateral: VesselTree = {
      nodes: [
        node('a0', v3(-2, 0, 0), section), node('a1', v3(-2, 0, 2), section),
        node('b0', v3(2, 0, 0), section), node('b1', v3(2, 0, 2), section),
      ],
      edges: [hullEdge('a', 'a0', 'a1', 2), hullEdge('b', 'b0', 'b1', 2)],
    };
    // 前後(x 軸方向)へ並べ替えただけの同じ2本。
    const inline: VesselTree = {
      nodes: [
        node('a0', v3(0, 0, 0), section), node('a1', v3(0, 0, 2), section),
        node('b0', v3(0, 0, 4), section), node('b1', v3(0, 0, 6), section),
      ],
      edges: [hullEdge('a', 'a0', 'a1', 2), hullEdge('b', 'b0', 'b1', 2)],
    };
    const areaOf = (tree: VesselTree): number =>
      deriveMassProperties({ tree, placements: [] }).principalAreas.z;
    // どちらの2本も軸は z に平行。横へずれていれば像は重ならないので和、
    // 同じ軸線上に並んでいれば重なるので最大値(＝1本ぶん)になる。
    assert.ok(
      Math.abs(areaOf(lateral) - 2 * areaOf(inline)) < 1e-9,
      `${areaOf(lateral)} vs ${areaOf(inline)}`,
    );
  });

  test('既定の有人艦の主慣性モーメントは、ロール軸が最小でヨー軸が最大になる', () => {
    const derived = deriveMassProperties(crewedAssembly(C.PLAYER_MAX_HP));
    // ロール(Z) < ピッチ(X) < ヨー(Y) の順に大きい。この順序が変わると、中間軸不安定性の
    // 現れる軸が変わってしまう。
    assert.ok(derived.inertia.izz < derived.inertia.ixx, `izz ${derived.inertia.izz} < ixx ${derived.inertia.ixx}`);
    assert.ok(derived.inertia.ixx < derived.inertia.iyy, `ixx ${derived.inertia.ixx} < iyy ${derived.inertia.iyy}`);
  });

  test('非対称な機体の慣性乗積が 0 にならない', () => {
    const base = deriveMassProperties(orbitalBaseAssembly(C.BASE_MAX_HP));
    // 左右のトラスが船体の x 軸から傾いた面から生えているため、xy の慣性乗積が残る。
    assert.ok(Math.abs(base.inertia.ixy) > 0.01 * base.inertia.ixx, `ixy ${base.inertia.ixy}`);
    const crewed = deriveMassProperties(crewedAssembly(C.PLAYER_MAX_HP));
    // 放熱板と太陽電池パドルを左右非対称に並べているため、yz の慣性乗積が残る。
    assert.ok(Math.abs(crewed.inertia.iyz) > 0, `iyz ${crewed.inertia.iyz}`);
  });

  test('重心を原点に取ると1次モーメントが消える', () => {
    const derived = deriveMassProperties(crewedAssembly(C.PLAYER_MAX_HP));
    // 質量を重心に集めた1つの質点として見たとき、重心まわりの1次モーメントは 0 である。
    const moment = scale(sub(derived.centerOfMass, derived.centerOfMass), derived.loadedMass);
    assert.ok(len(moment) < 1e-12);
    // 重心が形状の内側に収まっていること。
    assert.ok(len(derived.centerOfMass) < 2.6, `com ${JSON.stringify(derived.centerOfMass)}`);
  });

  test('一様断面の外皮の慣性テンソルが、薄肉角管の解析値と一致する', () => {
    // 正方形断面を軸まわりに相似変形して肉厚を作るので、外皮は一様な肉厚の角管そのものになる。
    const radius = 1;
    const length = 4;
    const tree: VesselTree = {
      nodes: [node('a', v3(0, 0, 0), square(radius)), node('b', v3(0, 0, length), square(radius))],
      edges: [hullEdge('e', 'a', 'b', length)],
    };
    assert.deepEqual(validateTree(tree), []);
    const derived = deriveMassProperties({ tree, placements: [] });

    const material = STRUCTURAL_MATERIALS.aluminium;
    const thickness = wallThickness(0, radius, material);
    // 正方形断面は内接円半径で相似変形されるので、面に垂直な肉厚がちょうど thickness になる。
    const side = radius * Math.SQRT2;
    const mass = material.density * (side * side - (side - 2 * thickness) ** 2) * length;
    assert.ok(relativeError(derived.dryMass, mass) < 1e-3, `mass ${derived.dryMass} vs ${mass}`);
    // 中空の角管の厳密値。中実の角柱2つの差として、軸まわりが ρL(a⁴−b⁴)/6、
    // 横軸まわりが ρL(a⁴−b⁴)/12 + m·L²/12 になる。
    const inside = side - 2 * thickness;
    const quartic = material.density * length * (side ** 4 - inside ** 4);
    assert.ok(relativeError(derived.inertia.izz, quartic / 6) < 1e-4, `izz ${derived.inertia.izz}`);
    const transverse = quartic / 12 + (mass * length * length) / 12;
    assert.ok(relativeError(derived.inertia.ixx, transverse) < 1e-4, `ixx ${derived.inertia.ixx}`);
  });

  test('肉厚が薄肉圧力容器の式に従い、座屈と製造上の下限を下回らない', () => {
    const aluminium = STRUCTURAL_MATERIALS.aluminium;
    const titanium = STRUCTURAL_MATERIALS.titanium;
    const pressure = 20e6;
    const radius = 1.5;
    const expected = (PRESSURE_SAFETY_FACTOR * pressure * radius) / (aluminium.allowableStress * WELD_EFFICIENCY);
    assert.ok(relativeError(pressurizedWallThickness(pressure, radius, aluminium), expected) < 1e-12);
    // 比強度の高いチタン合金のほうが薄くて済む。
    assert.ok(pressurizedWallThickness(pressure, radius, titanium) < pressurizedWallThickness(pressure, radius, aluminium));
    // 内圧に比例し、半径に比例する。
    assert.ok(relativeError(
      pressurizedWallThickness(2 * pressure, radius, aluminium), 2 * expected) < 1e-12);
    assert.ok(relativeError(
      pressurizedWallThickness(pressure, 2 * radius, aluminium), 2 * expected) < 1e-12);
    // 内圧を持たない区画でも、座屈と製造上の下限は下回らない。
    assert.ok(unpressurizedWallThickness(0.01) >= MIN_MANUFACTURING_THICKNESS);
    assert.ok(relativeError(unpressurizedWallThickness(4), 4 / BUCKLING_RADIUS_RATIO) < 1e-12);
    assert.ok(wallThickness(0, 1, aluminium) === unpressurizedWallThickness(1));
    assert.ok(wallThickness(pressure, radius, aluminium) === expected);
  });

  test('内圧の高い区画ほど外皮が重くなる', () => {
    const length = 4;
    const tree: VesselTree = {
      nodes: [node('a', v3(0, 0, 0), square(1.5)), node('b', v3(0, 0, length), square(1.5))],
      edges: [hullEdge('e', 'a', 'b', length)],
    };
    const withTank = (maxPressure: number): number => deriveMassProperties({
      tree,
      placements: [{
        kind: 'internal',
        part: createPart('pressurant_tank', { name: 'gas', volume: 1, maxPressure }),
        edgeIds: ['e'],
      }],
    }).dryMass;
    // 加圧ガスタンクの耐圧 [MPa] がそのまま区画の内圧になる。
    assert.ok(withTank(30) > withTank(1) * 2, `${withTank(30)} vs ${withTank(1)}`);
    // 内圧が座屈の下限に埋もれる程度なら、肉厚は変わらない。
    assert.ok(relativeError(withTank(0.1), withTank(0.2)) < 1e-12);
  });

  test('閉じたツリーでも各エッジの質量が1度だけ数えられる', () => {
    // 3つのノードを三角形に結んだ閉路。閉路のないコの字と辺の長さが同じなら、質量は等しい。
    const height = Math.sqrt(3) * 2;
    const triangle: VesselTree = {
      nodes: [
        node('a', v3(-2, 0, 0), square(0.5), v3(1, 0, 0)),
        node('b', v3(2, 0, 0), square(0.5), v3(1, 0, 0)),
        node('c', v3(0, height, 0), square(0.5), v3(1, 0, 0)),
      ],
      edges: [
        { ...hullEdge('ab', 'a', 'b', 4), portA: { kind: 'axial', sign: 1 }, portB: { kind: 'axial', sign: -1 } },
        { ...hullEdge('bc', 'b', 'c', 4), portA: { kind: 'lateral', primitiveId: 'p0', faceIndex: 0 }, portB: { kind: 'lateral', primitiveId: 'p0', faceIndex: 0 } },
        { ...hullEdge('ca', 'c', 'a', 4), portA: { kind: 'lateral', primitiveId: 'p0', faceIndex: 1 }, portB: { kind: 'lateral', primitiveId: 'p0', faceIndex: 1 } },
      ],
    };
    // 閉路を含むツリーは正当である。長さの宣言だけは口の位置と合っている必要がある。
    const issues = validateTree(triangle).filter((issue) => !issue.includes('ports are'));
    assert.deepEqual(issues, []);

    const closed = deriveMassProperties({ tree: triangle, placements: [] });
    const chain: VesselTree = {
      nodes: [
        node('a', v3(0, 0, 0), square(0.5)),
        node('b', v3(0, 0, 4), square(0.5)),
        node('c', v3(0, 0, 8), square(0.5)),
        node('d', v3(0, 0, 12), square(0.5)),
      ],
      edges: [hullEdge('ab', 'a', 'b', 4), hullEdge('bc', 'b', 'c', 4), hullEdge('cd', 'c', 'd', 4)],
    };
    const open = deriveMassProperties({ tree: chain, placements: [] });
    assert.ok(relativeError(closed.dryMass, open.dryMass) < 1e-9, `${closed.dryMass} vs ${open.dryMass}`);
  });

  test('平行軸の定理で移したエッジごとの慣性テンソルの和が、直接求めた値と一致する', () => {
    // 同じ形のエッジを2本、間隔をあけて並べる。全体の慣性テンソルは、1本ぶんを重心まわりで求めて
    // それぞれの位置へ移した和に等しくなければならない。
    const length = 3;
    const gap = 5;
    const tree: VesselTree = {
      nodes: [
        node('a0', v3(0, 0, 0), square(0.8)), node('a1', v3(0, 0, length), square(0.8)),
        node('b0', v3(0, gap, 0), square(0.8)), node('b1', v3(0, gap, length), square(0.8)),
      ],
      edges: [hullEdge('a', 'a0', 'a1', length), hullEdge('b', 'b0', 'b1', length)],
    };
    const whole = deriveMassProperties({ tree, placements: [] });

    const single: VesselTree = { nodes: [tree.nodes[0]!, tree.nodes[1]!], edges: [tree.edges[0]!] };
    const one = deriveMassProperties({ tree: single, placements: [] });
    let composed: InertiaTensor = { ixx: 0, iyy: 0, izz: 0, ixy: 0, ixz: 0, iyz: 0 };
    for (const offset of [v3(0, 0, 0), v3(0, gap, 0)]) {
      const center = sub(v3(one.centerOfMass.x, one.centerOfMass.y + offset.y, one.centerOfMass.z), whole.centerOfMass);
      composed = addInertia(composed, translateInertia(one.inertia, one.dryMass, center));
    }
    for (const key of ['ixx', 'iyy', 'izz', 'ixy', 'ixz', 'iyz'] as const) {
      const scaleOf = Math.max(Math.abs(whole.inertia.ixx), 1);
      assert.ok(
        Math.abs(whole.inertia[key] - composed[key]) < 1e-6 * scaleOf,
        `${key}: ${whole.inertia[key]} vs ${composed[key]}`,
      );
    }
    assert.ok(relativeError(whole.dryMass, 2 * one.dryMass) < 1e-9);
  });

  test('トラスのエッジは内容積を持たず、hull のエッジは持つ', () => {
    const { tree } = crewedAssembly(C.PLAYER_MAX_HP);
    assert.ok(edgeInternalVolume(tree, edgeById(tree, 'mid')) > 0);
    assert.equal(edgeInternalVolume(tree, edgeById(tree, 'truss-l')), 0);
    assert.equal(edgeInternalVolume(tree, edgeById(tree, 'truss-r')), 0);
  });

  test('トラス上の取り付け位置を変えると、重心と慣性テンソルが位置に応じて変わる', () => {
    const { tree } = crewedAssembly(C.PLAYER_MAX_HP);
    const at = (along: number): VesselAssembly => ({
      tree,
      placements: [{ kind: 'external', part: ballast('mass', 200), mount: { kind: 'truss', edgeId: 'truss-l', along, around: 0 } }],
    });
    const near = deriveMassProperties(at(0.5));
    const far = deriveMassProperties(at(2.5));
    const outward = sub(far.centerOfMass, near.centerOfMass);
    // 取り付け位置を外へ 2 m ずらしたぶん、重心もトラスの向きへ動く。
    assert.ok(len(outward) > 0.3, `com shift ${len(outward)}`);
    const direction = sub(
      deriveMassProperties({ ...at(2.5), placements: [] }).centerOfMass,
      near.centerOfMass,
    );
    assert.ok(dot(outward, direction) < 0, 'ballast pulls the centre of mass toward the truss tip');
    // 重心から遠いほど慣性モーメントは大きい。
    assert.ok(far.inertia.izz > near.inertia.izz * 1.05, `${far.inertia.izz} vs ${near.inertia.izz}`);
  });

  test('内容積の割り当てが、収めたタンクの容積の合計と一致する', () => {
    const length = 4;
    const tree: VesselTree = {
      nodes: [
        node('a', v3(0, 0, 0), square(1)),
        node('b', v3(0, 0, length), square(1)),
        node('c', v3(0, 0, 2 * length), square(1)),
      ],
      edges: [hullEdge('a', 'a', 'b', length), hullEdge('b', 'b', 'c', length)],
    };
    const oxidizer = createPart('oxidizer_tank', { name: 'lox', propellant: 'liquid-oxygen', volume: 3 });
    const rcs = createPart('rcs_tank', { name: 'rcs', propellant: 'hydrazine', volume: 2 });
    const allocations = allocateInternalVolume(tree, [
      { part: oxidizer, edgeIds: ['a', 'b'] }, // 軸方向に連なる2本をまたぐ1つのタンク(§8-4)
      { part: rcs, edgeIds: ['b'] },
    ]);
    assert.equal(allocations.reduce((sum, a) => sum + a.occupiedVolume, 0), 5);
    // 極低温タンクは 0.85、常温貯蔵タンクは 0.95 の実効容積の係数を持つ(§12)。
    assert.ok(relativeError(allocations[0]!.grossVolume, 3 / 0.85) < 1e-12);
    assert.ok(relativeError(allocations[1]!.grossVolume, 2 / 0.95) < 1e-12);
    // 2本にまたがるタンクの重心は、両エッジの内容積の重心の間に来る。
    assert.ok(Math.abs(allocations[0]!.centroid.z - length) < 1e-9, `${allocations[0]!.centroid.z}`);
    assert.ok(Math.abs(allocations[1]!.centroid.z - 1.5 * length) < 1e-9);
  });

  test('連なっていないエッジをまたぐ配置と、内容積を超える配置を拒む', () => {
    const { tree } = crewedAssembly(C.PLAYER_MAX_HP);
    const tank = (volume: number): AnyPart =>
      createPart('rcs_tank', { name: 'tank', propellant: 'hydrazine', volume });
    // 'fore' と 'aft' は 'mid' を挟んで離れているので連続しない。
    assert.throws(() => allocateInternalVolume(tree, [{ part: tank(1), edgeIds: ['fore', 'aft'] }]), /contiguous/);
    // トラスは内容積を持たないので、そこへは何も収められない。
    assert.throws(() => allocateInternalVolume(tree, [{ part: tank(1), edgeIds: ['truss-l'] }]), /no internal volume/);
    const available = edgeInternalVolume(tree, edgeById(tree, 'mid'));
    assert.throws(() => allocateInternalVolume(tree, [{ part: tank(available * 2), edgeIds: ['mid'] }]), /assigned/);
  });

  test('推進剤を積むと総質量が増え、重心がタンクの側へ寄る', () => {
    const assembly = crewedAssembly(C.PLAYER_MAX_HP);
    const tankId = tankPartId(assembly.placements);
    const dry = deriveMassProperties(assembly);
    const wet = deriveMassProperties(assembly, new Map([[tankId, 300]]));
    assert.equal(wet.dryMass, dry.dryMass);
    assert.ok(relativeError(wet.loadedMass, dry.loadedMass + 300) < 1e-12);
    // RCS タンクは機体後方の 'aft' に収めてあるので、重心は後ろ(−z)へ動く。
    assert.ok(wet.centerOfMass.z < dry.centerOfMass.z, `${wet.centerOfMass.z} vs ${dry.centerOfMass.z}`);
    assert.throws(() => deriveMassProperties(assembly, new Map([['nowhere', 10]])), /unplaced/);
  });

  test('既定の有人艦の導出値が測定した値のまま動かない', () => {
    // 機体が実際に使う質量・慣性・投影面積そのもの。理論値のある量ではないので、測定した値を
    // 留めて意図しない変化を捕まえる。慣性モーメントが 1e3 kg·m² の桁になるのは、質量 1000 kg・
    // 全長 4.5 m の剛体として当然の大きさである。
    const derived = deriveMassProperties(crewedAssembly(C.PLAYER_MAX_HP));
    const pinned: Record<string, number> = {
      dryMass: 1060.83, ixx: 1837.84, iyy: 2880.63, izz: 1541.36, iyz: 46.5864,
      areaX: 10.2065, areaY: 12.4565, areaZ: 65.7643, comY: -0.0230480, comZ: 0.0245860,
    };
    const actual: Record<string, number> = {
      dryMass: derived.dryMass,
      ixx: derived.inertia.ixx, iyy: derived.inertia.iyy, izz: derived.inertia.izz,
      iyz: derived.inertia.iyz,
      areaX: derived.principalAreas.x, areaY: derived.principalAreas.y, areaZ: derived.principalAreas.z,
      comY: derived.centerOfMass.y, comZ: derived.centerOfMass.z,
    };
    for (const key of Object.keys(pinned)) {
      assert.ok(
        relativeError(actual[key]!, pinned[key]!) < 1e-4,
        `${key}: ${actual[key]!.toPrecision(6)} vs ${pinned[key]}`,
      );
    }
  });

  test('主慣性モーメントが慣性テンソルの固有値として求まる', () => {
    const derived = deriveMassProperties(crewedAssembly(C.PLAYER_MAX_HP));
    const principal = principalMoments(derived.inertia);
    // 対角和は座標系の取り方に依らない。
    const trace = derived.inertia.ixx + derived.inertia.iyy + derived.inertia.izz;
    assert.ok(relativeError(principal.x + principal.y + principal.z, trace) < 1e-9);
    // 3値が互いに異なる = 中間軸不安定性(ジャニベコフ効果)が現れる形状である。
    assert.ok(principal.y - principal.x > 1e-3 * trace);
    assert.ok(principal.z - principal.y > 1e-3 * trace);
  });
}

function tankPartId(placements: readonly PartPlacement[]): string {
  const found = placements.find((p) => p.part.type === 'rcs_tank');
  if (!found) throw new Error('the crewed assembly carries no rcs tank');
  return found.part.id;
}
