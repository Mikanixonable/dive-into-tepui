// 被選択物(MapPickable)のプロパティウィンドウに出す行(PropertyRow)を種別ごとに組み立てる。
// entities/ephemeris の現在状態から毎回導出する表示専用の処理で、副作用は持たない。
import { fmtAmmoStatus, fmtDist, fmtEnergy, fmtSpeed, fmtTime } from './hud/utils';
import { orbitInfo, relativeInfo } from './hud/orbit/orbit-info';
import { autoOrbitReference } from './orbit-reference';
import { getApsisLabelSpec, ORBIT_ELEMENT_LABELS } from './hud/orbit/orbit-labels';
import { celestialBodyName } from './hud/frame/frame-labels';
import type { PropertyRow } from './hud/windows';
import type { MapPickable } from './map-pickable';
import type { EntityManager } from './simulation/entity-manager';
import type { ActivePlayerController } from './active-controllable-controller';
import type { NavTarget } from './nav-target';
import type { Ephemeris } from '../physics/ephemeris';
import type { GameEntity } from './game-entity/game-entity';
import { planExecutionLabel, type Player } from './player/player';
import { len, sub } from '../physics/vec3';
import { orbitalElementsOf, strongestAttractor, type CelestialBody } from '../physics/celestial-body';
import { apsisAltitudes } from '../physics/elements';
import { bodyDef, primaryOf } from '../physics/solar-system';
import * as C from './const';

export class MapPropertyRows {
  constructor(
    private readonly entities: EntityManager,
    private readonly activePlayers: ActivePlayerController,
    private readonly ephemeris: Ephemeris,
    private readonly navTarget: NavTarget,
  ) {}

  // 種別ごとのプロパティ行。値の導出は sync フェーズで毎フレーム呼び直す(表示専用のため)。
  rowsFor(
    target: MapPickable, celestialBodies: readonly CelestialBody[], player: Player | null, simTime: number,
  ): PropertyRow[] {
    switch (target.kind) {
      case 'player': return this.playerRows(target, celestialBodies);
      case 'ship': return this.shipRows(target, celestialBodies, player);
      case 'base': return this.baseRows(target, celestialBodies, player);
      case 'ammo': return this.ammoPickupRows(target, celestialBodies, player);
      case 'fuel': return this.rcsFuelPickupRows(target, celestialBodies, player);
      case 'body': return this.bodyRows(target, celestialBodies, player);
      case 'apsis': return this.apsisRows(target, celestialBodies, simTime);
      case 'relnode': case 'eqnode': return this.nodeRows(target, celestialBodies, simTime);
      case 'empty-space': return [];
    }
  }

  // 基準天体・高度・速度・AP/PE/INC/PRD の軌道要素一式。軌道上の実体種別間で共通化する。
  // 「軌道」グループにまとめ、ウィンドウ先頭の折り畳みセクションへ描かれる。
  private orbitRows(entity: GameEntity, celestialBodies: readonly CelestialBody[]): PropertyRow[] {
    const oi = orbitInfo(entity, autoOrbitReference(entity.state.r, celestialBodies));
    const apSpec = getApsisLabelSpec('ap', oi.centerId);
    const peSpec = getApsisLabelSpec('pe', oi.centerId);
    const group = '軌道';
    return [
      { key: 'center', label: '基準天体', value: oi.centerName, group },
      { key: 'alt', label: ORBIT_ELEMENT_LABELS.alt.full, value: fmtDist(oi.alt), group },
      { key: 'spd', label: ORBIT_ELEMENT_LABELS.spd.full, value: fmtSpeed(oi.spd), group },
      { key: 'ap', label: apSpec.full, value: fmtDist(oi.apAlt), group },
      { key: 'pe', label: peSpec.full, value: fmtDist(oi.peAlt), group },
      {
        key: 'inc', label: ORBIT_ELEMENT_LABELS.inc.full,
        value: isFinite(oi.incDeg) ? `${oi.incDeg.toFixed(2)}°` : '---', group,
      },
      { key: 'prd', label: ORBIT_ELEMENT_LABELS.prd.full, value: fmtTime(oi.period), group },
    ];
  }

  // 名前は既にウィンドウのタイトルにあるので行には含めない。装甲・電力・弾薬を主要行とし、
  // それ以外(操作対象か・計画追従)は詳細トグル、軌道要素は「軌道」グループの下に畳む。
  private playerRows(target: MapPickable, celestialBodies: readonly CelestialBody[]): PropertyRow[] {
    const ship = this.entities.findPlayer(target.id);
    if (!ship) return [];
    return [
      {
        key: 'operated', label: '操作対象か', value: ship === this.activePlayers.current ? 'はい' : 'いいえ', collapsible: true,
      },
      { key: 'follow', label: '計画実行', value: planExecutionLabel(ship.planExecution), collapsible: true },
      { key: 'hp', label: '装甲', value: `${Math.floor(ship.hp)} / ${ship.maxHp}` },
      { key: 'temp', label: '温度', value: `${ship.temperature.toFixed(0)} K` },
      { key: 'power', label: '電力', value: fmtEnergy(ship.power.chargeJ) },
      { key: 'ammo', label: '弾薬', value: fmtAmmoStatus(ship.roundsInMag, ship.magsLeft, ship.reloadTimer) },
      ...this.orbitRows(ship, celestialBodies),
    ];
  }

  // 自艦がいなければ距離・接近速度・相対速度・相対傾斜角の行はそもそも出さない。
  // 装甲・距離・接近速度を主要行とし、相対速度は詳細トグル、軌道要素・相対傾斜角は「軌道」グループの下に畳む。
  private shipRows(target: MapPickable, celestialBodies: readonly CelestialBody[], player: Player | null): PropertyRow[] {
    const enemy = this.entities.findEnemy(target.id);
    if (!enemy) return [];
    const rel = player ? relativeInfo(player, enemy, celestialBodies) : null;
    const rows: PropertyRow[] = [{ key: 'hp', label: '装甲', value: `${Math.floor(enemy.hp)} / ${enemy.maxHp}` }];
    if (rel) {
      rows.push(
        { key: 'dist', label: '距離', value: fmtDist(rel.dist) },
        { key: 'closing', label: '接近速度', value: fmtSpeed(rel.closing) },
        { key: 'relspeed', label: '相対速度', value: fmtSpeed(rel.relSpeed), collapsible: true },
      );
    }
    rows.push(...this.orbitRows(enemy, celestialBodies));
    if (rel) {
      rows.push({
        key: 'relinc', label: '相対傾斜 [AN/DN]',
        value: isFinite(rel.relIncDeg) ? `${rel.relIncDeg.toFixed(2)}°` : '---', group: '軌道',
      });
    }
    return rows;
  }

  // 自艦がいなければ距離の行は出さない。軌道要素は「軌道」グループの下に畳む。
  private baseRows(target: MapPickable, celestialBodies: readonly CelestialBody[], player: Player | null): PropertyRow[] {
    const base = this.entities.findBase(target.id);
    if (!base) return [];
    const isControlled = this.activePlayers.controlledBase === base;
    const rows: PropertyRow[] = [
      { key: 'operated', label: '操作対象か', value: isControlled ? 'はい' : 'いいえ', collapsible: true },
      { key: 'money', label: '所持金', value: `${base.baseState.money.toLocaleString()} Cr` },
      { key: 'vessels', label: '格納艦艇数', value: `${base.baseState.dockedVessels.length}` },
    ];
    if (player) rows.push({ key: 'dist', label: '距離', value: fmtDist(len(sub(base.state.r, player.state.r))) });
    rows.push(...this.orbitRows(base, celestialBodies));
    return rows;
  }

  // 自艦がいなければ距離の行は出さない。軌道要素は「軌道」グループの下に畳む。
  private ammoPickupRows(
    target: MapPickable,
    celestialBodies: readonly CelestialBody[],
    player: Player | null,
  ): PropertyRow[] {
    const ammoPickup = this.entities.ammoPickups.find((candidate) => candidate.id === target.id);
    if (!ammoPickup) return [];
    const rows: PropertyRow[] = [];
    if (player) {
      rows.push({
        key: 'dist',
        label: '距離',
        value: fmtDist(len(sub(ammoPickup.state.r, player.state.r))),
      });
    }
    rows.push(...this.orbitRows(ammoPickup, celestialBodies));
    return rows;
  }

  private rcsFuelPickupRows(
    target: MapPickable,
    celestialBodies: readonly CelestialBody[],
    player: Player | null,
  ): PropertyRow[] {
    const pickup = this.entities.rcsFuelPickups.find((candidate) => candidate.id === target.id);
    if (!pickup) return [];
    const rows: PropertyRow[] = [];
    if (player) {
      rows.push({
        key: 'dist',
        label: '距離',
        value: fmtDist(len(sub(pickup.state.r, player.state.r))),
      });
    }
    rows.push({ key: 'amount', label: '補給量', value: `${C.RCS_FUEL_PICKUP_AMOUNT.toLocaleString()} kg` });
    rows.push(...this.orbitRows(pickup, celestialBodies));
    return rows;
  }

  // 実在の天体(現在のレジストリに登録された ID)なら種別・μ・半径・(公転していれば)軌道要素を、
  // ラグランジュ点なら種別のみを出す。
  private bodyRows(target: MapPickable, celestialBodies: readonly CelestialBody[], player: Player | null): PropertyRow[] {
    const registry = this.ephemeris.registry;
    const rows: PropertyRow[] = [];
    if (player) rows.push({ key: 'dist', label: '自艦からの距離', value: fmtDist(len(sub(target.pos, player.state.r))) });
    if (!(target.id in registry)) {
      rows.push({ key: 'kind', label: '種別', value: 'ラグランジュ点' });
      return rows;
    }
    const def = bodyDef(registry, target.id);
    const kindLabel = def.kind === 'star' ? '恒星' : def.kind === 'planet' ? '惑星' : '衛星';
    rows.push(
      { key: 'kind', label: '種別', value: kindLabel },
      { key: 'mu', label: 'μ', value: `${def.mu.toExponential(3)} m³/s²` },
      { key: 'radius', label: '半径', value: fmtDist(def.radius) },
    );
    if (def.kind === 'star') return rows;
    const primary = celestialBodies.find((b) => b.id === primaryOf(registry, def.id));
    const self = celestialBodies.find((b) => b.id === def.id);
    const el = primary && self ? orbitalElementsOf(self.state, primary) : null;
    if (!el) return rows;
    const apsis = apsisAltitudes(el);
    const apSpec = getApsisLabelSpec('ap', el.center.id);
    const peSpec = getApsisLabelSpec('pe', el.center.id);
    rows.push(
      { key: 'ap', label: apSpec.full, value: fmtDist(apsis.ap), group: '軌道' },
      { key: 'pe', label: peSpec.full, value: fmtDist(apsis.pe), group: '軌道' },
      { key: 'inc', label: ORBIT_ELEMENT_LABELS.inc.full, value: `${el.incDeg.toFixed(2)}°`, group: '軌道' },
      { key: 'prd', label: ORBIT_ELEMENT_LABELS.prd.full, value: fmtTime(el.period), group: '軌道' },
    );
    return rows;
  }

  // Pe/Ap の別・AN/DN の別はタイトル側(header)に既に出ているので、ここには乗せない。
  private apsisRows(target: MapPickable, celestialBodies: readonly CelestialBody[], simTime: number): PropertyRow[] {
    const center = strongestAttractor(target.pos, celestialBodies);
    const alt = len(sub(target.pos, center.state.r)) - center.radius;
    const rows: PropertyRow[] = [];
    if (target.ownerName) rows.push({ key: 'owner', label: '所属軌道', value: target.ownerName });
    rows.push({ key: 'alt', label: '高度', value: fmtDist(alt) });
    if (target.time !== undefined) rows.push({ key: 'time', label: '通過まで', value: `T+${fmtTime(target.time - simTime)}` });
    return rows;
  }

  // AN/DN の別はタイトル側(header)に既に出ているので、ここでは対象名と通過時刻のみ出す。
  private nodeRows(target: MapPickable, celestialBodies: readonly CelestialBody[], simTime: number): PropertyRow[] {
    const targetName = target.kind === 'relnode'
      ? (this.navTarget.name ?? '対象')
      : celestialBodyName(strongestAttractor(target.pos, celestialBodies).id);
    const rows: PropertyRow[] = [];
    if (target.ownerName) rows.push({ key: 'owner', label: '所属軌道', value: target.ownerName });
    rows.push({ key: 'target', label: '対象', value: targetName });
    if (target.time !== undefined) rows.push({ key: 'time', label: '通過まで', value: `T+${fmtTime(target.time - simTime)}` });
    return rows;
  }
}
