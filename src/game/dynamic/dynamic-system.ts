// エンティティの保持・追加・上限管理・寿命回収・描画同期。
import * as THREE from 'three/webgpu';
import { Vec3 } from '../../math/vec3';
import type { Viewpoint } from '../../math/projection';
import { CelestialMotion } from '../../physics/celestial-motion';
import type { FrameAnchorSource } from '../../physics/frame';
import { FloatingOrigin } from '../camera/floating-origin';
import { DynamicEntity } from './dynamic-entity/dynamic-entity';
import { ENTITY_CAP, type CapKind } from './dynamic-entity/entity-kind';
import { isControllable, type Controllable } from './dynamic-entity/controllable';
import { AmmoPickup } from './dynamic-entity/ammo-pickup';
import { RcsFuelPickup } from './dynamic-entity/rcs-fuel-pickup';
import { DebrisPiece } from './dynamic-entity/debris-piece';
import { Enemy } from './dynamic-entity/enemy';
import { restorationFor } from './dynamic-entity/entity-dictionary';
import { ProteinEnemy } from './dynamic-entity/protein-enemy';
import { Bullet } from './dynamic-entity/bullet';
import { Base } from './dynamic-entity/base';
import { InstancedPools } from './dynamic-entity/instanced-pools';
import { Player } from '../player/player';
import type { Stage } from '../stages/stage';
import type { Input } from '../../input/input';
import type { MapVisibilityPolicy } from '../map/visibility-policy';
import type { CameraSystem } from '../camera/camera-system';
import type { RenderStyle } from '../../render/render-style';
import type { CelestialSystem } from '../celestial/celestial-system';
import type { TimeLabelSetting } from '../hud/orbit/calendar-ticks';
import type { EntitySaveDataUnion, GameSaveData } from '../save/save-data';
import type { Hud } from '../hud/hud';
import type { WorldSfx } from '../../audio/sfx/world-sfx';
import { EffectsSystem } from '../vfx/effects-system';
import type { MarkerManager } from '../marker/marker-manager';
import type { EquatorNodeInputs } from '../marker/equator-node-marker-pair';
import type { PerfCounts } from '../perf-counts';
import type { OrbitReference } from '../orbit-reference';
import type { ProteinMotionFrameSample } from '../protein/protein-motion-metrics';
import type { ProteinMotionLod } from '../protein/protein-motion-controller';

// 個体を実体化してよいかを答える述語。何を待つかは、待つと決めた側だけが知っていればよい。
export type SpawnGate = () => boolean;

export class DynamicSystem {
  // 保持する全エンティティを追加順に並べた、顔ぶれの正本。枠ごとの上限はこの並びから導く。
  private readonly entities: DynamicEntity[] = [];

  // 操作されうる個体。どれが操作対象かは持たない — それは呼び出し側が渡す。呼ぶたびに
  // 数え直すので、フレームに何度も読む側は受けた配列を持ち回る。
  public get controllables(): readonly Controllable[] { return this.entities.filter(isControllable); }

  // プールで描く種別の描画資源。どの種別がどのプールへ積むかは個体自身が知っている。
  private readonly instancedPools: InstancedPools;

  // フラッシュ・破片の生成窓口。破片は entity なので、その配列を持つこちらが所有する。
  readonly effects: EffectsSystem;

  // 描画資源のプールを組み、演出窓口を作ってから、saved があればその顔ぶれを復元する。
  constructor(
    scene: THREE.Scene,
    hud: Hud,
    worldSfx: WorldSfx,
    markerManager: MarkerManager,
    saved?: GameSaveData,
  ) {
    this.instancedPools = new InstancedPools(scene);
    this.effects = new EffectsSystem(scene, this, worldSfx);
    if (saved) this.restoreFromSave(saved, hud, worldSfx, scene, markerManager);
  }

  // スナップショットの顔ぶれを復元する。組み立て方は種別ごとの辞書が答え、知らない種別は
  // 読み飛ばす。
  private restoreFromSave(
    save: GameSaveData, hud: Hud, worldSfx: WorldSfx, scene: THREE.Scene, markerManager: MarkerManager,
  ): void {
    for (const data of save.entities) {
      const restoration = restorationFor(
        data, save.simTime, scene, hud, worldSfx, markerManager, this.effects);
      if (restoration === null) continue;
      this.spawnWhenReady(restoration.gate, () => restoration.build());
    }
  }

  // 顔ぶれを保存形へ畳む。保存へ載らない種別は落ちる。
  public serialize(): EntitySaveDataUnion[] {
    return this.entities
      .map((e) => e.serialize())
      .filter((data): data is EntitySaveDataUnion => data !== null);
  }

  private _collectionRevision = 0;

  // 保持するエンティティの顔ぶれの世代。追加・除去・prune のいずれでも増える。
  get collectionRevision(): number {
    return this._collectionRevision;
  }

  // エンティティを登録する。上限を持つ枠の超過分は、次の cleanup で古いものから落ちる。
  public add(entity: DynamicEntity): void {
    this.entities.push(entity);
    if (entity.capKind !== null) this.capsUncheckedSinceAdd = true;
    this.bumpCollectionRevision();
  }

  // 実体化に外部資源の取得が要る個体の待ち行列。生成そのものを gate が通るまで遅らせるので、
  // その間その個体は顔ぶれのどこにも現れない。
  private readonly pendingSpawns: { readonly gate: SpawnGate; readonly build: () => DynamicEntity; readonly onSpawned?: () => void }[] = [];

  // 個体を1体足す。gate がまだ通らなければ、通るまで待ち行列へ回す。onSpawned は実体化した
  // 直後に1度だけ呼ぶ。待つものが無ければ gate は null。
  public spawnWhenReady(gate: SpawnGate | null, build: () => DynamicEntity, onSpawned?: () => void): void {
    if (gate === null || gate()) {
      this.add(build());
      onSpawned?.();
      return;
    }
    this.pendingSpawns.push({ gate, build, onSpawned });
  }

  // 待ち行列のうち、gate が通ったものを実体化して顔ぶれへ足す。
  private processPendingSpawns(): void {
    if (this.pendingSpawns.length === 0) return;
    let w = 0;
    // 通らなかったものは前へ詰めて待ち行列に残す。
    for (const pending of this.pendingSpawns) {
      if (pending.gate()) {
        this.add(pending.build());
        pending.onSpawned?.();
      } else {
        this.pendingSpawns[w++] = pending;
      }
    }
    this.pendingSpawns.length = w;
  }

  // エンティティを取り除き、メッシュを破棄する。
  public remove(entity: DynamicEntity): void {
    if (!this.detach(entity)) return;
    entity.dispose();
  }

  // 顔ぶれから外す。保持していなければ false。
  private detach(entity: DynamicEntity): boolean {
    const i = this.entities.indexOf(entity);
    if (i < 0) return false;
    this.entities.splice(i, 1);
    this.bumpCollectionRevision();
    return true;
  }

  // 上限付きの個体が追加されてから、まだ上限を確かめていないか。枠が増えるのは追加のときだけ
  // なので、走査はこれが立っている間に限れる。
  private capsUncheckedSinceAdd = false;

  // 上限を超えた個体を、枠ごとに古いものから落とす。配列は追加順なので、末尾から数えて上限を
  // 超えたところがその枠の最古になる。
  private enforceCaps(): void {
    if (!this.capsUncheckedSinceAdd) return;
    this.capsUncheckedSinceAdd = false;
    // 落とすのは alive を下ろすところまで — ここで演出を起こすと、破片が生まれて上限が発振する。
    const live: Record<CapKind, number> = { bullet: 0, casing: 0, debris: 0, booster: 0 };
    const entities = this.all();
    for (let i = entities.length - 1; i >= 0; i--) {
      const entity = entities[i]!;
      const cap = entity.capKind;
      if (cap === null || !entity.alive) continue;
      const rank = live[cap] + 1;
      live[cap] = rank;
      if (rank > ENTITY_CAP[cap]) entity.alive = false;
    }
  }

  // 顔ぶれが変わったことを世代へ記録する。
  private bumpCollectionRevision(): void {
    this._collectionRevision++;
  }

  // 保持する全エンティティを追加順に返す。呼び出し側は読み取り専用として扱う。
  public all(): readonly DynamicEntity[] {
    return this.entities;
  }

  // 全エンティティの寿命判定と上限判定を行い、死亡したものを破棄・除去する。
  public cleanup(
    dt: number, simTime: number, activeStage: Stage, viewerPos: Vec3,
    atmosphereBodies: readonly CelestialMotion[],
  ): void {
    this.processPendingSpawns();
    // 判定は開始時の顔ぶれに対して行う。死の演出が破片を足すので、生配列を反復すると
    // 生まれたばかりの個体まで同じパスで判定してしまい、生成が連鎖すれば終わらなくなる。
    for (let i = 0, n = this.entities.length; i < n; i++) {
      this.entities[i]!.checkLoss(dt, simTime, activeStage, viewerPos, atmosphereBodies);
    }
    this.enforceCaps();
    this.prune();
  }

  // 死亡した個体を破棄して取り除く。生存分は追加順のまま前へ詰める。
  private prune(): void {
    let w = 0;
    let changed = false;
    // 所有者が回収する種別は、死亡していても残す。
    for (const x of this.entities) {
      if (!x.alive && !x.reclaimedByOwner) {
        x.dispose();
        changed = true;
      }
      else this.entities[w++] = x;
    }
    this.entities.length = w;
    if (changed) this.bumpCollectionRevision();
  }

  // 過去表示に要る履歴の保持時間 [s] を全エンティティへ要求する。履歴を持たない種別は無視する。
  requestHistoryDuration(sec: number): void {
    for (const e of this.all()) e.requestHistoryDuration(sec);
  }

  // 自分で決まる推力を持つ個体を1フレーム進める。積分より前に1度だけ呼ぶ。
  updateThrusts(simDt: number): void {
    for (const entity of this.entities) if (entity.alive) entity.updateThrust(simDt);
  }

  // 毎フレーム、操作されうる全個体へ updateControls を1度ずつ通す。「操作対象でない」と
  // 「操作できないワープ倍率」は同じ状態なので、input を渡すかどうかで一つに束ねる。
  updateControllables(
    active: Controllable | null, input: Input, operable: boolean,
    dt: number, simDt: number, activeStage: Stage, celestialSystem: CelestialSystem,
  ): void {
    for (const controllable of this.controllables) {
      if (!controllable.alive) continue;
      controllable.updateControls(
        controllable === active && operable ? input : null,
        dt,
        simDt,
        this,
        activeStage,
        celestialSystem,
      );
    }
  }

  // 操作できない間、連続指令(推力・トルク・射撃・噴射ラッチ)を畳む。
  clearTransientCommands(): void {
    for (const controllable of this.controllables) controllable.clearTransientCommands();
  }

  // このフレームの表示物を同期する。可視性の上書きはメッシュを触る同期が可視にしたものを
  // 伏せ直すので、それらより後に通す。
  sync(
    active: Controllable | null, fo: FloatingOrigin,
    cameraSystem: CameraSystem, displayTime: number, style: RenderStyle,
    visibilityPolicy: MapVisibilityPolicy | null, orbitRef: OrbitReference | undefined,
    frameAnchors: FrameAnchorSource, timeLabel: TimeLabelSetting, proteinVibrationEnabled: boolean,
  ): void {
    this.syncControllables(active, fo, cameraSystem, displayTime, style, visibilityPolicy, orbitRef);
    this.syncOtherEntities(fo, displayTime, cameraSystem.activeViewpoint, proteinVibrationEnabled);
    this.applyVisibility(visibilityPolicy, active);
    for (const entity of this.entities) entity.syncEffects(fo, displayTime, cameraSystem, style);
    this.effects.sync(fo, cameraSystem.activeCamera, cameraSystem.zoomActive);
    this.syncEquatorNodes(cameraSystem, frameAnchors, timeLabel);
  }

  // 操作されうる全個体のメッシュ・エフェクト・マーカーを、どれが操作対象かを添えて同期する
  // (方向マーカー・照準ズーム・RCS 音は操作対象のもの)。
  private syncControllables(
    active: Controllable | null, fo: FloatingOrigin, cameraSystem: CameraSystem,
    displayTime: number, style: RenderStyle, visibilityPolicy: MapVisibilityPolicy | null,
    orbitRef?: OrbitReference,
  ): void {
    for (const controllable of this.controllables) {
      if (!controllable.alive) continue;
      const isActive = controllable === active;
      controllable.syncControllable(
        fo, cameraSystem, displayTime, isActive, style,
        visibilityPolicy?.entity(controllable.mapKind, isActive) ?? null, orbitRef,
      );
    }
  }

  // 種別ごとの表示トグルに応じてメッシュ表示を揃える。トグルを持たない種別(mapKind が null)は
  // 対象外。
  private applyVisibility(visibilityPolicy: MapVisibilityPolicy | null, active: Controllable | null): void {
    if (!visibilityPolicy) return;
    for (const entity of this.entities) {
      const kind = entity.mapKind;
      if (kind === null) continue;
      if (!visibilityPolicy.entity(kind, entity === active).category) entity.renderObject.visible = false;
    }
  }

  // 全個体の赤道交点マーカーを求め直す。出すかどうかも、どの線の上で解くかも個体が答えるので、
  // 折れ線を組み終えた後・選択候補を組む前に1度だけ通す。
  updateEquatorNodes(inputs: EquatorNodeInputs, controlled: Controllable | null): void {
    for (const e of this.all()) e.updateEquatorNodes(inputs, e === controlled);
  }

  // このフレームに求まった赤道交点マーカーを置く。天体の裏に隠れた交点を伏せるのは
  // マップビューだけで、戦闘ビューでは地球の向こう側の交点も出す。
  private syncEquatorNodes(
    cameraSystem: CameraSystem, frameAnchors: FrameAnchorSource, timeLabel: TimeLabelSetting,
  ): void {
    const project = cameraSystem.activeCameraProjection;
    const cameraPos = cameraSystem.activeCameraPos;
    const occludeByBodies = cameraSystem.view === 'map';
    for (const e of this.all()) {
      e.syncEquatorNodes(
        project, cameraPos, frameAnchors.bodies, frameAnchors.bodiesPivot, occludeByBodies, timeLabel);
    }
  }

  // 操作対象候補以外のメッシュを displayTime 時点の状態へ同期し、プールで描く種別は
  // 対応する InstancedPool へ積ませる。
  private syncOtherEntities(
    fo: FloatingOrigin, displayTime: number, viewer: Viewpoint, proteinVibrationEnabled: boolean,
  ): void {
    this.instancedPools.beginFrame();
    // 操作対象候補は専用の同期パス(syncControllables)を持つ。
    for (const e of this.entities) {
      if (isControllable(e)) continue;
      e.sync(fo, displayTime, viewer, proteinVibrationEnabled);
      e.pushInstances(this.instancedPools);
    }
    this.instancedPools.endFrame();
  }

  // 保持する全エンティティと描画資源プールを、生死によらず破棄する。
  dispose(): void {
    for (const e of this.entities) e.dispose();
    this.entities.length = 0;
    // 待ち行列の build は scene などを掴んだままなので、実体化されないまま残さない。
    this.pendingSpawns.length = 0;

    this.instancedPools.dispose();

    this.effects.dispose();
    this.bumpCollectionRevision();
  }

  // 種別ごとの現在の個体数。
  perfCounts(): Pick<PerfCounts, 'players' | 'enemies' | 'bullets' | 'casings' | 'debris' | 'ammoPickups' | 'rcsFuelPickups' | 'bases'> {
    // 顔ぶれを1度だけ辿って数える。破片は薬莢とそれ以外に分ける。
    const counts = {
      players: 0, enemies: 0, bullets: 0, casings: 0,
      debris: 0, ammoPickups: 0, rcsFuelPickups: 0, bases: 0,
    };
    for (const e of this.entities) {
      if (e instanceof Player) counts.players++;
      else if (e instanceof Enemy) counts.enemies++;
      else if (e instanceof Bullet) counts.bullets++;
      else if (e instanceof DebrisPiece) (e.kind === 'casing' ? counts.casings++ : counts.debris++);
      else if (e instanceof AmmoPickup) counts.ammoPickups++;
      else if (e instanceof RcsFuelPickup) counts.rcsFuelPickups++;
      else if (e instanceof Base) counts.bases++;
    }
    return counts;
  }

  // 直近 sync() 時点のタンパク質敵モーションの集計値。
  proteinMotionFrameSample(): ProteinMotionFrameSample {
    // 全タンパク質敵の直近の計測値を足し合わせ、LOD ごとの体数を数える。
    let cpuMs = 0;
    let uploadBytes = 0;
    const lodCounts: Partial<Record<ProteinMotionLod, number>> = {};
    for (const entity of this.entities) {
      if (!(entity instanceof ProteinEnemy)) continue;
      const metrics = entity.motionMetrics;
      cpuMs += metrics.cpuMs;
      uploadBytes += metrics.uploadBytes;
      lodCounts[metrics.lod] = (lodCounts[metrics.lod] ?? 0) + 1;
    }
    return { cpuMs, uploadBytes, lodCounts };
  }
}
