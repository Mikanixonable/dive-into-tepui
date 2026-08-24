import { Game } from '../game';
import { SAVE_VERSION } from '../save-data';
import { orbitInfo } from '../hud/orbit/orbit-info';
import { autoOrbitReference } from '../orbit-reference';
import { fmtDist, fmtTime } from '../hud/utils';
import { SaveStore } from './save-store';
import { SaveSlots } from './save-slots';
import { CURRENT_EPHEMERIS_CONTEXT, isEphemerisContextCompatible } from './ephemeris-context';
import type { AmmoPickupSaveData, GameSaveData, RcsFuelPickupSaveData, SnapshotKind, SnapshotMeta } from '../save-data';
import type { OrbitInfo } from '../hud/orbit/orbit-info';

// Game の実行状態と GameSaveData の相互変換、およびストア/スロットへの出し入れを担う。
export class SnapshotService {
  constructor(private readonly store: SaveStore, private readonly slots: SaveSlots) {}

  // 現在の game 状態を1件のスナップショットとして永続化し、そのメタを返す。
  // アクティブスロットが無い、またはストア書き込みに失敗した場合は null。
  capture(game: Game, kind: SnapshotKind, name: string | null, pinned: boolean): SnapshotMeta | null {
    const slotId = this.slots.activeSlotId;
    if (slotId === null) return null;

    const player = game.player;
    const info = player ? orbitInfo(player, autoOrbitReference(player.state.r, game.ephemeris.celestialBodiesAt(game.simTime))) : null;
    const meta: SnapshotMeta = {
      id: generateSnapshotId(),
      kind,
      pinned,
      name: name && name.length > 0 ? name : autoName(game.simTime, info),
      createdAtReal: Date.now(),
      simTime: game.simTime,
      centerBodyId: info ? info.centerId : game.ephemeris.originId,
      altitude: info ? info.alt : 0,
      speed: info ? info.spd : 0,
      hpRatio: player && player.maxHp > 0 ? Math.max(0, player.hp) / player.maxHp : 0,
      maxHp: player ? player.maxHp : 0,
      magazines: player ? player.magsLeft : 0,
      money: game.entities.bases.reduce((sum, b) => sum + b.baseState.money, 0),
      playerCount: game.entities.players.length,
      enemyAliveCount: game.entities.enemies.filter(e => e.alive).length,
      phase: game.activeStage.phase,
    };

    return this.slots.addSnapshot(slotId, game.activeStage.id, meta, buildSaveData(game)) ? meta : null;
  }

  // snapshotId のスナップショット本体を取得する。本体欠損・バージョン不一致・
  // 起動先ステージとの不一致のいずれかなら null。
  load(snapshotId: string, expectedStageId: string): GameSaveData | null {
    const data = this.store.readSnapshot(snapshotId);
    if (data === null) return null;
    if (data.version !== SAVE_VERSION) return null;
    const normalizedData = normalizePickupKeys(data);
    if (normalizedData === null) return null;
    if (expectedStageId !== normalizedData.stageId) return null;
    // 暦情報が無いスナップショットは互換復元で読む。暦情報がある場合は、
    // 異なる epoch/profile/pack で絶対天体状態が曖昧になるデータを拒否する。
    if (!isEphemerisContextCompatible(
      (normalizedData as { ephemerisContext?: unknown }).ephemerisContext,
      CURRENT_EPHEMERIS_CONTEXT,
    )) return null;
    return normalizedData;
  }
}

// 旧形式の補給キーと、RCS燃料追加前の欠落フィールドを読み込み境界で正規化する。
function normalizePickupKeys(data: GameSaveData): GameSaveData | null {
  const storedData = data as Omit<GameSaveData, 'ammoPickups'> & {
    ammoPickups?: AmmoPickupSaveData[];
    ammos?: AmmoPickupSaveData[];
    rcsFuelPickups?: RcsFuelPickupSaveData[];
  };
  const ammoPickups = storedData.ammoPickups ?? storedData.ammos;
  if (!Array.isArray(ammoPickups)) return null;

  const normalizedData = {
    ...storedData,
    ammoPickups,
    rcsFuelPickups: storedData.rcsFuelPickups ?? [],
    detachedBoosters: storedData.detachedBoosters ?? [],
  };
  delete normalizedData.ammos;
  return normalizedData;
}

// 各エンティティ・ステージ自身の serialize を集めて1件ぶんのセーブ本体にする。
function buildSaveData(game: Game): GameSaveData {
  return {
    version: SAVE_VERSION,
    stageId: game.activeStage.id,
    simTime: game.simTime,
    ephemerisContext: { ...CURRENT_EPHEMERIS_CONTEXT },
    phaseOffsets: game.ephemeris.getPhaseOffsets(),
    earthSpinPhase0: game.environment.earthSpinPhase0(),
    players: game.entities.players.map(p => p.serialize()),
    activePlayerId: game.player ? game.player.id : null,
    enemies: game.entities.enemies.map(e => e.serialize()),
    ammoPickups: game.entities.ammoPickups.map((ammoPickup) => ammoPickup.serialize()),
    rcsFuelPickups: game.entities.rcsFuelPickups.map((pickup) => pickup.serialize()),
    detachedBoosters: game.entities.detachedBoosters.map((booster) => booster.serialize()),
    bases: game.entities.bases.map(b => b.serialize()),
    stage: game.activeStage.serialize(),
    camera: { view: game.viewManager.serializeView(), ...game.cameraSystem.serialize() },
    navTarget: game.navTarget.id !== null ? { id: game.navTarget.id, name: game.navTarget.name! } : null,
  };
}

// 名前を付けずに撮ったスナップショットの表示名。
function autoName(simTime: number, info: OrbitInfo | null): string {
  const timeLabel = `MET ${fmtTime(simTime)}`;
  return info ? `${timeLabel} ・ ${info.centerName} 高度 ${fmtDist(info.alt)}` : timeLabel;
}

// 同一ミリ秒の連続呼び出しでも衝突しないよう、時刻にランダムな尾部を付ける。
function generateSnapshotId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
