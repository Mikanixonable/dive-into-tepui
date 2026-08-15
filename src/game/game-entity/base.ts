import * as THREE from 'three/webgpu';
import { GameEntity } from './game-entity';
import { EntityIdAllocator } from './entity-id';
import { KinematicState, kinematicState } from '../../physics/kinematic-state';
import { Attitude } from '../../physics/attitude';
import { v3 } from '../../physics/vec3';
import type { AnyPart, Part } from './parts';
import { partFromSaveData } from './parts';
import { Player } from '../player/player';
import { buildBaseModel } from '../../render/ships';
import type { Hud } from '../hud/hud';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import type { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import { EquatorNodeMarkerPair } from '../marker/equator-node-marker-pair';
import { EntityMarker } from '../marker/entity-marker';
import { ENTITY_GLYPH } from '../marker/marker-glyphs';
import type { BaseSaveData } from '../save-data';
import { OrbitLine } from '../orbit-line';
import * as C from '../const';

// 収容中の艦のエントリ。parts は player.parts と同一参照(修理は艦へ直接反映される)。
// hp/maxHp は艦一覧タブ表示用の集計値で、修理のたびに書き戻す。
export interface DockedShipEntry {
  readonly id: string;
  readonly name: string;
  hp: number;
  maxHp: number;
  readonly parts: Part[];
  readonly player: Player;
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

  // hud/worldSfx/fx/markerManager は格納艦(Player)の組み立てに要る。格納艦は entities.players へ
  // 入らない — それが「格納中」の定義であり、艦自身の状態としては何も倒さない。
  constructor(
    init: BaseInit,
    scene: THREE.Scene,
    hud: Hud,
    worldSfx: WorldSfx,
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
    this.radius = 100;
    this.collides = true;
    this.name = name;
    this.orbitLine = new OrbitLine(C.COLOR_BASE_ORBIT_LINE, 0.35, C.LINE_RENDER_ORDER.shipOrbit);
    this.equatorNodes = new EquatorNodeMarkerPair(this, markerManager);
    this.marker = new EntityMarker(this, markerManager, 'mk-base', ENTITY_GLYPH.ship);
    scene.add(this.orbitLine.line);

    if ('saved' in init) {
      this.baseState.money = init.saved.money;
      this.baseState.inventory = init.saved.inventory.map(partFromSaveData);
      this.baseState.dockedShips = init.saved.dockedShips.map((shipData) => {
        const player = new Player(hud, worldSfx, scene, fx, markerManager, { saved: shipData, simTime: init.simTime });
        player.renderObject.visible = false;
        return {
          id: player.id,
          name: player.name,
          hp: player.hp,
          maxHp: player.maxHp,
          parts: player.parts,
          player,
        };
      });
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
