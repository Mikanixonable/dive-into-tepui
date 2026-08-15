import * as THREE from 'three/webgpu';
import { GameEntity } from './game-entity';
import { EntityIdAllocator } from './entity-id';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Attitude } from '../../physics/attitude';
import { qRotate } from '../../physics/attitude';
import { add, v3, Vec3 } from '../../physics/vec3';
import type { AnyPart, Part } from './parts';
import { partFromSaveData } from './parts';
import { Player } from '../player/player';
import { buildBaseModel } from '../../render/ships';
import type { Hud } from '../hud/hud';
import type { Sfx } from '../../audio/sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import { EquatorNodeMarkerPair } from '../marker/equator-node-marker-pair';
import { EntityMarker } from '../marker/entity-marker';
import { ENTITY_GLYPH } from '../marker/marker-glyphs';
import type { BaseSaveData } from '../save-data';
import { OrbitLine } from '../orbit-line';
import * as C from '../const';

// 基地のドッキングハッチのローカル位置および外向き法線ベクトル (中腹ドッキングパレット上部)
export const BASE_HATCH_LOCAL_POS: Vec3 = v3(0, 8.5, 0);
export const BASE_HATCH_LOCAL_NORMAL: Vec3 = v3(0, 1, 0);

export interface BaseDockSlot {
  readonly id: number;
  readonly localPos: Vec3;
  readonly localNormal: Vec3;
}

export const BASE_DOCK_SLOTS: readonly BaseDockSlot[] = [
  { id: 0, localPos: v3(22, 0, 0), localNormal: v3(1, 0, 0) },
  { id: 1, localPos: v3(0, 0, 26), localNormal: v3(0, 0, 1) },
  { id: 2, localPos: v3(-22, 0, 0), localNormal: v3(-1, 0, 0) },
  { id: 3, localPos: v3(0, 0, -26), localNormal: v3(0, 0, -1) },
];

// 収容中の艦のエントリ。parts は player.parts と同一参照(修理は艦へ直接反映される)。
// hp/maxHp は艦一覧タブ表示用の集計値で、修理のたびに書き戻す。
export interface DockedShipEntry {
  readonly id: string;
  readonly name: string;
  hp: number;
  maxHp: number;
  readonly parts: Part[];
  readonly player: Player;
  slotIndex: number;
}

export interface BaseState {
  money: number;
  inventory: AnyPart[];
  dockedShips: DockedShipEntry[];
}

const idAllocator = new EntityIdAllocator('base-');

// 新規配置は state/name/att をそのまま使い、スナップショットからの再開は saved を
// simTime の epoch で展開する。
export type BaseInit =
  | { readonly state: KinematicState; readonly name?: string; readonly att?: Attitude; readonly id?: string }
  | { readonly saved: BaseSaveData; readonly simTime: number };

export class Base extends GameEntity {
  // 計画軌道の衝突判定でも基地の未来位置を使う。現在位置を凍結すると、長時間計画では
  // 実際に移動した基地と計画線の衝突判定が食い違うため、通常の entity 予測列へ乗せる。
  readonly predictsFuture = true;
  declare readonly orbitLine: OrbitLine;
  public baseState: BaseState = {
    money: 100000,
    inventory: [],
    dockedShips: []
  };

  // hud/sfx/fx/markerManager は格納艦(Player)の組み立てに要る。格納艦は entities.players へ
  // 入らない — それが「格納中」の定義であり、艦自身の状態としては何も倒さない。
  constructor(
    init: BaseInit,
    scene: THREE.Scene,
    hud: Hud,
    sfx: Sfx,
    fx: EffectsSystem,
    markerManager: MarkerManager,
  ) {
    const { state, name, att, id } = 'saved' in init
      ? {
        state: kinematicState(init.simTime, v3(init.saved.r.x, init.saved.r.y, init.saved.r.z), v3(init.saved.v.x, init.saved.v.y, init.saved.v.z)),
        name: init.saved.name || '基地',
        att: undefined,
        id: init.saved.id,
      }
      : { state: init.state, name: init.name ?? '基地', att: init.att, id: init.id };
    super(state, buildBaseModel(), scene, att, idAllocator.next(id));
    this.mass = 1e6;
    this.radius = 110;
    this.collides = true;
    this.name = name;
    this.orbitLine = new OrbitLine(C.COLOR_BASE_ORBIT_LINE, 0.35, C.LINE_RENDER_ORDER.shipOrbit);
    this.equatorNodes = new EquatorNodeMarkerPair(this, markerManager);
    this.marker = new EntityMarker(this, markerManager, 'mk-base', ENTITY_GLYPH.ship);
    scene.add(this.orbitLine.line);

    if ('saved' in init) {
      this.baseState.money = init.saved.money;
      this.baseState.inventory = init.saved.inventory.map(partFromSaveData);
      this.baseState.dockedShips = init.saved.dockedShips.map((shipData, idx) => {
        const player = new Player(hud, sfx, scene, fx, markerManager, { saved: shipData, simTime: init.simTime });
        const slotIndex = idx < C.BASE_MAX_SHIPS ? idx : 0;
        this.attachDockedShipMesh(player, slotIndex);
        return {
          id: player.id,
          name: player.name,
          hp: player.hp,
          maxHp: player.maxHp,
          parts: player.parts,
          player,
          slotIndex,
        };
      });
    }
  }

  // 基地のドッキングハッチのワールド座標を取得する
  getHatchWorldPos(): Vec3 {
    return add(this.state.r, qRotate(this.att.q, BASE_HATCH_LOCAL_POS));
  }

  // 基地のドッキングハッチのワールド正面法線ベクトルを取得する
  getHatchWorldNormal(): Vec3 {
    return qRotate(this.att.q, BASE_HATCH_LOCAL_NORMAL);
  }

  // 指定スロットのワールド位置を取得する
  getSlotWorldPos(slotIndex: number): Vec3 {
    const slot = BASE_DOCK_SLOTS[slotIndex] ?? BASE_DOCK_SLOTS[0]!;
    return add(this.state.r, qRotate(this.att.q, slot.localPos));
  }

  // 指定スロットの外向き法線ベクトルを取得する
  getSlotWorldNormal(slotIndex: number): Vec3 {
    const slot = BASE_DOCK_SLOTS[slotIndex] ?? BASE_DOCK_SLOTS[0]!;
    return qRotate(this.att.q, slot.localNormal);
  }

  // 利用可能な空きスロット番号(0..3)を返す。満杯なら null。
  getAvailableSlotIndex(): number | null {
    const occupied = new Set(this.baseState.dockedShips.map((s) => s.slotIndex));
    for (let i = 0; i < C.BASE_MAX_SHIPS; i++) {
      if (!occupied.has(i)) return i;
    }
    return null;
  }

  // 格納艦の 3D メッシュを基地ドックスロットへアタッチ表示する
  attachDockedShipMesh(ship: Player, slotIndex: number): void {
    const slot = BASE_DOCK_SLOTS[slotIndex] ?? BASE_DOCK_SLOTS[0]!;
    const shipObj = ship.renderObject;
    shipObj.visible = true;
    shipObj.position.set(slot.localPos.x, slot.localPos.y, slot.localPos.z);

    const dir = new THREE.Vector3(slot.localNormal.x, slot.localNormal.y, slot.localNormal.z);
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir);
    shipObj.quaternion.copy(q);

    if (shipObj.parent !== this.renderObject) {
      this.renderObject.add(shipObj);
    }
  }

  // 発行時、格納艦の 3D メッシュを基地ドックスロットから分離する
  detachDockedShipMesh(ship: Player): void {
    const shipObj = ship.renderObject;
    if (shipObj.parent === this.renderObject) {
      this.renderObject.remove(shipObj);
    }
  }

  dispose(): void {
    super.dispose();
    this.scene?.remove(this.orbitLine.line);
    this.orbitLine.dispose();
  }

  // セーブデータへ変換する。格納艦は player.serialize() に委ねる。
  serialize(): BaseSaveData {
    return {
      id: this.id,
      name: this.name,
      r: { ...this.state.r },
      v: { ...this.state.v },
      money: this.baseState.money,
      inventory: this.baseState.inventory.map(p => ({ ...p })),
      dockedShips: this.baseState.dockedShips.map(entry => entry.player.serialize()),
    };
  }
}
