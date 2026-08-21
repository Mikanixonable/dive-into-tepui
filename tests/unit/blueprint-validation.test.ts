// 設計データの検証(§4-2)と、保存・読み込み・複製(§4-1)の回帰テスト。
import * as assert from 'node:assert/strict';
import { createPart } from '../../src/game/game-entity/parts';
import type { AnyPart } from '../../src/game/game-entity/parts';
import type { PartPlacement } from '../../src/game/vessel/assembly';
import type { TreeEdge, VesselTree } from '../../src/game/vessel/tree';
import { crewedAssembly } from '../../src/game/vessel/vessel-assemblies';
import type { VesselBlueprint } from '../../src/game/vessel/blueprint';
import {
  BLUEPRINT_FILE_VERSION, BLUEPRINT_VERSION, buildBlueprintFile, createBlueprint, duplicateBlueprint,
  parseBlueprintFile,
} from '../../src/game/vessel/blueprint';
import { EMPTY_FEED_NETWORK } from '../../src/game/vessel/feed-network';
import type { BlueprintArchive, BlueprintStore } from '../../src/game/vessel/blueprint-library';
import { BlueprintLibrary } from '../../src/game/vessel/blueprint-library';
import type { BlueprintIssue } from '../../src/game/vessel/blueprint-validation';
import { DEFAULT_BLUEPRINT_LIMITS, validateBlueprint } from '../../src/game/vessel/blueprint-validation';
import { test } from '../physics/harness';

// 既定の有人艦を設計にしたもの。個々の検証は、これの一部だけを崩して確かめる。既定の主機は
// 加圧式で自己加圧できない推進剤を使うため、加圧ガスタンクを足して成り立つ設計にする。
function baseBlueprint(): VesselBlueprint {
  const assembly = crewedAssembly(1000);
  const pressurant: PartPlacement = {
    kind: 'internal',
    part: part('pressurant_tank', { name: 'Pressurant Tank', weight: 20, volume: 0.2, maxPressure: 30, gas: 'nitrogen' }),
    edgeIds: ['mid'],
  };
  return createBlueprint({
    id: 'bp-base', name: '試験機', tree: assembly.tree, placements: [...assembly.placements, pressurant], now: 1000,
  });
}

function withPlacements(bp: VesselBlueprint, placements: readonly PartPlacement[]): VesselBlueprint {
  return { ...bp, placements };
}

function withTree(bp: VesselBlueprint, tree: VesselTree): VesselBlueprint {
  return { ...bp, tree };
}

// 指定した種別の搭載要素をすべて取り除く。
function without(bp: VesselBlueprint, ...types: readonly string[]): VesselBlueprint {
  return withPlacements(bp, bp.placements.filter((p) => !types.includes(p.part.type)));
}

function part(type: Parameters<typeof createPart>[0], props: object): AnyPart {
  return createPart(type, { maxHp: 10, hp: 10, ...props } as never);
}

function messages(issues: readonly BlueprintIssue[]): string {
  return issues.map((i) => `${i.severity} ${i.targetId}: ${i.message}`).join(' | ');
}

// 指摘の中に、与えた重大度を持ち、与えた語をすべて含む一件があること。
function assertIssue(
  issues: readonly BlueprintIssue[],
  severity: BlueprintIssue['severity'],
  ...needles: readonly string[]
): void {
  const hit = issues.some((i) =>
    i.severity === severity && needles.every((n) => i.message.includes(n) || i.targetId === n));
  assert.ok(hit, `期待した ${severity} の指摘が出ていない (${needles.join(', ')}): ${messages(issues)}`);
}

class MemoryStore implements BlueprintStore {
  public raw: string | null = null;

  public read(): BlueprintArchive | null {
    return this.raw === null ? null : (JSON.parse(this.raw) as BlueprintArchive);
  }

  public write(archive: BlueprintArchive): void {
    this.raw = JSON.stringify(archive);
  }
}

export function register(): void {
  // --- 正しい設計 ---

  test('blueprint: 既定の有人艦の設計は検証を通る', () => {
    assert.deepEqual(validateBlueprint(baseBlueprint()), []);
  });

  // --- §4-2 の検証項目 ---

  test('blueprint: ツリーが連結していないと指摘される', () => {
    const bp = baseBlueprint();
    const stray = { ...bp.tree.nodes[0]!, id: 'stray', pos: { ...bp.tree.nodes[0]!.pos, x: 50 } as never };
    const issues = validateBlueprint(withTree(bp, { nodes: [...bp.tree.nodes, stray], edges: bp.tree.edges }));
    assertIssue(issues, 'error', '繋がっていません');
  });

  test('blueprint: 複合断面の貼り合わせ面の長さが違うと指摘される', () => {
    const bp = baseBlueprint();
    const node = bp.tree.nodes[0]!;
    // 一辺の長さが違う多角形を貼り合わせる。placeSectionPrimitives が辺長の不一致を述べる。
    const broken = {
      ...node,
      section: {
        primitives: [
          { id: 'p0', shape: { kind: 'polygon', sides: 4, radius: 1 } as const, phaseAngle: 0, attachment: null },
          {
            id: 'p1', shape: { kind: 'polygon', sides: 4, radius: 2 } as const, phaseAngle: 0,
            attachment: { parentId: 'p0', parentFaceIndex: 0, childFaceIndex: 2 },
          },
        ],
      },
    };
    const issues = validateBlueprint(withTree(bp, { nodes: [broken, ...bp.tree.nodes.slice(1)], edges: bp.tree.edges }));
    assertIssue(issues, 'error', '断面が組めません');
  });

  test('blueprint: 側面の口に収まらない断面のエッジが指摘される', () => {
    const bp = baseBlueprint();
    // トラスの先端の断面を口より大きくすると、周方向にも軸方向にもはみ出す。
    const nodes = bp.tree.nodes.map((n) => (n.id !== 'truss-l-tip' ? n : {
      ...n,
      section: { primitives: [{ id: 'p0', shape: { kind: 'polygon', sides: 4, radius: 4 } as const, phaseAngle: 0, attachment: null }] },
    }));
    const issues = validateBlueprint(withTree(bp, { nodes, edges: bp.tree.edges }));
    assertIssue(issues, 'error', '側面の口の周方向の幅');
    assertIssue(issues, 'error', '側面の口の軸方向の幅');
  });

  test('blueprint: 隣接する側面の口が重なると指摘される', () => {
    // 口の開口は外接円半径に比例する固定寸法なので、辺がそれより短い多角形では隣の口とぶつかる。
    // 八角形(辺長 0.765 < 開口 1.0)の隣り合う2面に口を取り、四角形(辺長 1.414 > 1.0)と比べる。
    const antenna = (name: string): AnyPart => part('communication', { name, weight: 5, range: 1e7 });
    const onFaces = (sides: 3 | 4 | 5 | 6 | 8): readonly BlueprintIssue[] => {
      const tree: VesselTree = {
        nodes: [{
          id: 'n', pos: { x: 0, y: 0, z: 0 } as never, axis: { x: 0, y: 0, z: 1 } as never, phaseAngle: 0,
          section: { primitives: [{ id: 'p0', shape: { kind: 'polygon', sides, radius: 1 }, phaseAngle: 0, attachment: null }] },
        }],
        edges: [],
      };
      const at = (faceIndex: number, name: string): PartPlacement => ({
        kind: 'external', part: antenna(name),
        mount: { kind: 'port', nodeId: 'n', port: { kind: 'lateral', primitiveId: 'p0', faceIndex } },
      });
      return validateBlueprint(createBlueprint({
        id: 'bp-ports', name: '口の試験', tree, placements: [at(0, 'A'), at(1, 'B')], now: 1000,
      }));
    };
    assertIssue(onFaces(8), 'error', '断面の上で重なっています');
    assert.ok(!onFaces(4).some((i) => i.message.includes('断面の上で重なっています')), messages(onFaces(4)));
  });

  test('blueprint: 接続口にエッジと外装要素が同時に付くと指摘される', () => {
    const bp = baseBlueprint();
    const antenna = part('communication', { name: 'Antenna', weight: 5, range: 1e7 });
    // 'mid-node' の側面の口 0 は既に truss-l が使っている。
    const issues = validateBlueprint(withPlacements(bp, [...bp.placements, {
      kind: 'external', part: antenna,
      mount: { kind: 'port', nodeId: 'mid-node', port: { kind: 'lateral', primitiveId: 'p0', faceIndex: 0 } },
    }]));
    assertIssue(issues, 'error', 'エッジ "truss-l" が使っているので');
  });

  test('blueprint: トラス上で外装要素が軸に沿って重なると指摘される', () => {
    const bp = baseBlueprint();
    const placements = bp.placements.map((p) => (
      p.kind === 'external' && p.mount.kind === 'truss' && p.mount.edgeId === 'truss-l'
        ? { ...p, mount: { ...p.mount, along: 1 } } : p));
    assertIssue(validateBlueprint(withPlacements(bp, placements)), 'error', '軸方向に重なっています');
  });

  test('blueprint: 外表面の RCS が他の外装要素と干渉すると指摘される', () => {
    const bp = baseBlueprint();
    // 既定の設計では外表面の要素が along と around で散らばっている。すべて同じ位置へ寄せる。
    const placements = bp.placements.map((p) => (
      p.kind === 'external' && p.mount.kind === 'surface'
        ? { ...p, mount: { ...p.mount, along: 1, around: 0 } } : p));
    assertIssue(validateBlueprint(withPlacements(bp, placements)), 'error', 'RCS スラスタが');
  });

  test('blueprint: 内容積を超える割り当てが指摘される', () => {
    const bp = baseBlueprint();
    const huge = part('water_tank', { name: 'Huge Tank', weight: 100, volume: 100 });
    const issues = validateBlueprint(withPlacements(bp, [...bp.placements, { kind: 'internal', part: huge, edgeIds: ['mid'] }]));
    assertIssue(issues, 'error', 'が割り当てられています', 'mid');
  });

  test('blueprint: 軸方向に連ならないエッジをまたぐ内装要素が指摘される', () => {
    const bp = baseBlueprint();
    const tank = part('water_tank', { name: 'Split Tank', weight: 10, volume: 0.1 });
    // 'fore' と 'aft' は 'mid' を挟んで離れている。
    const issues = validateBlueprint(withPlacements(bp, [...bp.placements, { kind: 'internal', part: tank, edgeIds: ['fore', 'aft'] }]));
    assertIssue(issues, 'error', '軸方向に連なっていません');
  });

  test('blueprint: 推進剤に適合しないタンク材料が指摘される', () => {
    const bp = baseBlueprint();
    const placements = bp.placements.map((p) => (
      p.part.type === 'rcs_tank' ? { ...p, part: { ...p.part, material: 'titanium' } } as PartPlacement : p));
    assertIssue(validateBlueprint(withPlacements(bp, placements)), 'error', 'ヒドラジン', 'titanium');
  });

  test('blueprint: コックピットも自動操縦装置も無い設計が指摘される', () => {
    assertIssue(validateBlueprint(without(baseBlueprint(), 'cockpit')), 'error', 'コックピットも自動操縦装置もありません');
  });

  test('blueprint: 自動操縦装置だけの機体に通信モジュールが無いと指摘される', () => {
    const bp = without(baseBlueprint(), 'cockpit', 'communication');
    const autopilot = part('autopilot', { name: 'Autopilot', weight: 20, powerDraw: 30 });
    const issues = validateBlueprint(withPlacements(bp, [...bp.placements, { kind: 'internal', part: autopilot, edgeIds: ['mid'] }]));
    assertIssue(issues, 'error', '通信モジュールが要ります');
    // 通信モジュールを戻せば、その指摘は消える。
    const comm = part('communication', { name: 'Antenna', weight: 5, range: 1e7 });
    const fixed = validateBlueprint(withPlacements(bp, [
      ...bp.placements,
      { kind: 'internal', part: autopilot, edgeIds: ['mid'] },
      { kind: 'external', part: comm, mount: { kind: 'surface', edgeId: 'fore', along: 0.5, around: Math.PI / 2 } },
    ]));
    assert.ok(!fixed.some((i) => i.message.includes('通信モジュールが要ります')), messages(fixed));
  });

  test('blueprint: 推力軸が重心から外れると指摘される', () => {
    const bp = baseBlueprint();
    // 主機を機体の側面へ移すと、推力の作用線が重心を外れる。
    const moved = (mount: object): readonly PartPlacement[] => bp.placements.map((p) => (
      p.part.type === 'engine' ? { ...p, mount } as PartPlacement : p));
    assertIssue(
      validateBlueprint(withPlacements(bp, moved({ kind: 'surface', edgeId: 'aft', along: 0.04, around: 0 }))),
      'warning', '推力軸が重心から');
    // トラスの先端まで離すと許容を超え、警告ではなく誤りになる。
    assertIssue(
      validateBlueprint(withPlacements(bp, moved({ kind: 'truss', edgeId: 'truss-l', along: 2.5, around: 0 }))),
      'error', '推力軸が重心から', '許容');
  });

  test('blueprint: ノード数・総質量・最大寸法・断面の構成要素数の上限が効く', () => {
    const bp = baseBlueprint();
    const issues = validateBlueprint(bp, { ...DEFAULT_BLUEPRINT_LIMITS, maxNodes: 3, maxMass: 10, maxDimension: 1 });
    assertIssue(issues, 'error', 'ノードが');
    assertIssue(issues, 'error', '最大寸法');
    assertIssue(issues, 'error', '総質量');
    // 断面の構成要素数だけは、幾何を解く前に打ち切る側の上限として別に効く。
    assertIssue(validateBlueprint(bp, { ...DEFAULT_BLUEPRINT_LIMITS, maxSectionPrimitives: 0 }), 'error', '複合断面の構成要素');
    // 既定の上限では、いずれも指摘されない。
    assert.deepEqual(validateBlueprint(bp, DEFAULT_BLUEPRINT_LIMITS), []);
  });

  test('blueprint: タンクからエンジンまで配管が繋がっていないと指摘される', () => {
    // 既定の主タンク・配管('aft')を外し、自前のタンク・配管だけで繋がりを確かめる。
    const bp = without(baseBlueprint(), 'reductant_tank', 'plumbing');
    const tank = part('reductant_tank', {
      name: 'Hydrazine Tank', weight: 50, propellant: 'hydrazine', volume: 0.01, material: 'structural-metal',
      fuel: 0, insulationGrade: 1, requiredPressure: 0,
    });
    const pipe = part('plumbing', { name: 'Feed Line', weight: 5, propellant: 'hydrazine', bore: 0.02, maxFlowRate: 5 });
    // タンクは 'fore'、配管は 'fore' だけ。主機は 'tail' にあり、'aft' を通らないので届かない。
    const disconnected = withPlacements(bp, [...bp.placements,
      { kind: 'internal', part: tank, edgeIds: ['fore'] },
      { kind: 'internal', part: pipe, edgeIds: ['fore'] },
    ]);
    assertIssue(validateBlueprint(disconnected), 'error', '配管が繋がっていません');
    // 'mid' と 'aft' にも配管を敷けば繋がる。
    const pipe2 = part('plumbing', { name: 'Feed Line 2', weight: 5, propellant: 'hydrazine', bore: 0.02, maxFlowRate: 5 });
    const connected = withPlacements(bp, [...bp.placements,
      { kind: 'internal', part: tank, edgeIds: ['fore'] },
      { kind: 'internal', part: pipe2, edgeIds: ['fore', 'mid', 'aft'] },
    ]);
    assert.ok(!validateBlueprint(connected).some((i) => i.message.includes('配管が繋がっていません')),
      messages(validateBlueprint(connected)));
  });

  test('blueprint: 加圧式エンジンに加圧ガスが無いと指摘される', () => {
    // 既定の主機は加圧式・ヒドラジンで、自己加圧できない。加圧ガスタンクを外すと成り立たなくなる。
    const stripped = without(baseBlueprint(), 'pressurant_tank');
    assertIssue(validateBlueprint(stripped), 'error', '加圧ガスタンクも自己加圧の条件もありません');
  });

  test('blueprint: 武器と弾薬庫が別の段にあると指摘される', () => {
    const bp = baseBlueprint();
    const magazine = part('magazine', { name: 'Magazine', weight: 30, ammoCapacity: 100 });
    // 左のトラスを分離機構にすると、その先端が別の段になる。トラスは内容積を持たないので、
    // 段を切っても内装要素の割り当ては動かない。
    const edges: readonly TreeEdge[] = bp.tree.edges.map((e) => (
      e.id !== 'truss-l' ? e : { ...e, kind: { kind: 'decoupler', separationImpulse: 100 } as const }));
    const staged = withTree(bp, { nodes: bp.tree.nodes, edges });
    // 既定の武器は機首にあり、弾薬庫と同じ段に属する。
    const same = withPlacements(staged, [...bp.placements, { kind: 'internal', part: magazine, edgeIds: ['fore'] }]);
    assert.ok(!validateBlueprint(same).some((i) => i.message.includes('弾薬庫がありません')), messages(validateBlueprint(same)));
    // 切り離される側の先端に武器を足すと、その武器の段には弾薬庫が無い。
    const gun = part('weapon', { name: 'Detached Gun', weight: 40, weaponType: 'gatling' });
    const bad = withPlacements(same, [...same.placements, {
      kind: 'external', part: gun, mount: { kind: 'port', nodeId: 'truss-l-tip', port: { kind: 'axial', sign: 1 } },
    }]);
    assertIssue(validateBlueprint(bad), 'error', '同じ段に弾薬庫がありません');
  });

  test('blueprint: 分離順が分離機構でないエッジを指すと指摘される', () => {
    const bp = { ...baseBlueprint(), stageOrder: ['mid'] };
    assertIssue(validateBlueprint(bp), 'error', '分離機構ではないエッジ');
    assertIssue(validateBlueprint({ ...bp, stageOrder: ['nowhere'] }), 'error', '存在しないエッジ');
  });

  test('blueprint: 熱シールドの覆う向きが開きすぎていると指摘される', () => {
    const bp = baseBlueprint();
    const shield = (name: string): AnyPart => part('heat_shield', { name, weight: 200, solidAngle: 3, ablatorMass: 100 });
    const opposed = withPlacements(bp, [...bp.placements,
      { kind: 'external', part: shield('Shield A'), mount: { kind: 'surface', edgeId: 'mid', along: 0.5, around: 0 } },
      { kind: 'external', part: shield('Shield B'), mount: { kind: 'surface', edgeId: 'mid', along: 1.0, around: Math.PI } },
    ]);
    assertIssue(validateBlueprint(opposed), 'error', '覆う向きが開きすぎていて');
    // 同じ向きに並べたぶんには成り立つ。
    const aligned = withPlacements(bp, [...bp.placements,
      { kind: 'external', part: shield('Shield A'), mount: { kind: 'surface', edgeId: 'mid', along: 0.5, around: 0 } },
      { kind: 'external', part: shield('Shield B'), mount: { kind: 'surface', edgeId: 'mid', along: 1.0, around: 0.2 } },
    ]);
    assert.ok(!validateBlueprint(aligned).some((i) => i.message.includes('覆う向き')), messages(validateBlueprint(aligned)));
  });

  // --- 保存・読み込み・複製 ---

  test('blueprint: 保存して読み直すと内容が保たれる', () => {
    const store = new MemoryStore();
    const library = new BlueprintLibrary(store, () => 2000);
    const saved = library.save(baseBlueprint());
    const reopened = new BlueprintLibrary(store, () => 3000).get(saved.id);
    assert.ok(reopened !== null);
    assert.deepEqual(JSON.parse(JSON.stringify(reopened)), JSON.parse(JSON.stringify(saved)));
    assert.deepEqual(validateBlueprint(reopened!), []);
  });

  test('blueprint: 複製は新しい id を持ち、元を変えない', () => {
    const store = new MemoryStore();
    const library = new BlueprintLibrary(store, () => 2000);
    const original = library.save(baseBlueprint());
    const copy = library.duplicate(original.id);
    assert.ok(copy !== null);
    assert.notEqual(copy!.id, original.id);
    assert.notEqual(copy!.name, original.name);
    assert.deepEqual(library.get(original.id), original);
    assert.equal(library.list().length, 2);
  });

  test('blueprint: 改名と削除が保存に残る', () => {
    const store = new MemoryStore();
    const library = new BlueprintLibrary(store, () => 2000);
    const saved = library.save(baseBlueprint());
    assert.equal(library.rename(saved.id, '二番機')!.name, '二番機');
    assert.equal(new BlueprintLibrary(store).get(saved.id)!.name, '二番機');
    assert.equal(library.remove(saved.id), true);
    assert.equal(new BlueprintLibrary(store).get(saved.id), null);
    assert.equal(library.remove(saved.id), false);
  });

  test('blueprint: 版の合わない保存は取り込まない', () => {
    const store = new MemoryStore();
    store.write({ version: BLUEPRINT_VERSION + 1, blueprints: [baseBlueprint()] });
    assert.deepEqual(new BlueprintLibrary(store).list(), []);
  });

  test('blueprint: 設計ファイルでない JSON と、壊れた設計ファイルを言い分ける', () => {
    const alien = parseBlueprintFile({ hello: 'world' });
    assert.equal(alien.ok, false);
    assert.match((alien as { reason: string }).reason, /設計ファイルではありません/);

    const file = buildBlueprintFile([baseBlueprint()], 1000);
    const oldVersion = parseBlueprintFile({ ...file, blueprints: [{ version: 0, blueprint: baseBlueprint() }] });
    assert.equal(oldVersion.ok, false);
    assert.match((oldVersion as { reason: string }).reason, /設計データのバージョン/);

    const good = parseBlueprintFile(JSON.parse(JSON.stringify(file)));
    assert.equal(good.ok, true);
    assert.equal((good as { blueprints: readonly VesselBlueprint[] }).blueprints.length, 1);
  });

  test('blueprint: 骨格の条件はどれか1つでも崩れれば壊れていると判定される', () => {
    // 骨格の検査は条件を並べたものなので、1つずつ崩して、どの条件も単独で効いていることを確かめる。
    const mutations: Record<string, (raw: Record<string, unknown>) => void> = {
      'id が空': (raw) => { raw.id = ''; },
      'name が文字列でない': (raw) => { raw.name = 7; },
      'tree が無い': (raw) => { delete raw.tree; },
      'nodes の要素がノードでない': (raw) => { (raw.tree as { nodes: unknown }).nodes = [1, 2]; },
      'edges の要素がエッジでない': (raw) => { (raw.tree as { edges: unknown }).edges = ['fore']; },
      'placements の要素が配置でない': (raw) => { raw.placements = [{ kind: 'external' }]; },
      'stageOrder が配列でない': (raw) => { raw.stageOrder = 'mid'; },
      'createdAt が数値でない': (raw) => { raw.createdAt = '1000'; },
      'feedNetwork の routes が配列でない': (raw) => { raw.feedNetwork = { routes: 1 }; },
    };
    const fileOf = (blueprint: unknown): unknown => ({
      ...buildBlueprintFile([], 1000), blueprints: [{ version: BLUEPRINT_VERSION, blueprint }],
    });
    const clone = (): Record<string, unknown> =>
      JSON.parse(JSON.stringify(baseBlueprint())) as Record<string, unknown>;

    // 崩していない複製は通る。以降の失敗は、崩した条件そのものによる。
    assert.equal(parseBlueprintFile(fileOf(clone())).ok, true);
    for (const [name, mutate] of Object.entries(mutations)) {
      const raw = clone();
      mutate(raw);
      const parsed = parseBlueprintFile(fileOf(raw));
      assert.equal(parsed.ok, false, name);
      assert.match((parsed as { reason: string }).reason, /壊れています/, name);
    }
  });

  test('blueprint: 形式のバージョンが数でなければ受け取らない', () => {
    const file = buildBlueprintFile([baseBlueprint()], 1000);
    for (const formatVersion of [Number.NaN, 1.5, 0, BLUEPRINT_FILE_VERSION + 1]) {
      assert.equal(parseBlueprintFile({ ...file, formatVersion }).ok, false, String(formatVersion));
    }
    assert.equal(parseBlueprintFile({ ...file, formatVersion: BLUEPRINT_FILE_VERSION }).ok, true);
  });

  test('blueprint: 取り込みは常に新しい id を振り、既存を上書きしない', () => {
    const store = new MemoryStore();
    const library = new BlueprintLibrary(store, () => 2000);
    const saved = library.save(baseBlueprint());
    const added = library.importBlueprints([saved, saved]);
    assert.equal(added.length, 2);
    assert.equal(new Set(library.list().map((b) => b.id)).size, 3);
  });

  test('blueprint: 手動で敷いた流路が保存から読み戻される', () => {
    const store = new MemoryStore();
    const library = new BlueprintLibrary(store, () => 2000);
    const bp = baseBlueprint();
    // 設計が持つのは手動で敷いた区間だけであり、既定では空である。
    assert.deepEqual(bp.feedNetwork.routes, []);
    const route = {
      id: 'r0', propellant: 'hydrazine' as const, edgeIds: ['fore', 'mid'], manual: true as const,
    };
    library.save({ ...bp, feedNetwork: { routes: [route] } });
    assert.deepEqual(new BlueprintLibrary(store).get(bp.id)!.feedNetwork.routes, [route]);
    // 流路を空にして保存し直せば消える。
    library.save({ ...bp, feedNetwork: EMPTY_FEED_NETWORK });
    assert.deepEqual(new BlueprintLibrary(store).get(bp.id)!.feedNetwork.routes, []);
  });

  test('blueprint: 複製した設計はファイルへ書き出して読み戻せる', () => {
    const original = baseBlueprint();
    const copy = duplicateBlueprint(original, 'bp-copy', '写し', 5000);
    const file = JSON.parse(JSON.stringify(buildBlueprintFile([original, copy], 5000)));
    const parsed = parseBlueprintFile(file);
    assert.equal(parsed.ok, true);
    const list = (parsed as { blueprints: readonly VesselBlueprint[] }).blueprints;
    assert.deepEqual(list.map((b) => b.id), ['bp-base', 'bp-copy']);
    assert.deepEqual(validateBlueprint(list[1]!), []);
  });
}
