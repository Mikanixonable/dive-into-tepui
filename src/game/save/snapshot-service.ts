import { Game } from '../game';
import { GameSaveData, SnapshotKind, SnapshotMeta, SAVE_VERSION } from '../save-data';
import { OrbitInfo, orbitInfo } from '../hud/orbit-info';
import { fmtDist, fmtTime } from '../hud/utils';
import { SaveStore } from './save-store';
import { SaveSlots } from './save-slots';
import { CURRENT_EPHEMERIS_CONTEXT, isEphemerisContextCompatible } from './ephemeris-context';

// Game の実行状態と GameSaveData の相互変換、およびストア/スロットへの出し入れを担う。
export class SnapshotService {
  constructor(private readonly store: SaveStore, private readonly slots: SaveSlots) {}

  // 現在の game 状態を1件のスナップショットとして永続化し、そのメタを返す。
  // アクティブスロットが無い、またはストア書き込みに失敗した場合は null。
  capture(game: Game, kind: SnapshotKind, name: string | null, pinned: boolean): SnapshotMeta | null {
    const slotId = this.slots.activeSlotId;
    if (slotId === null) return null;

    const player = game.player;
    const info = player ? orbitInfo(player, game.ephemeris.attractorsAt(game.simTime)) : null;
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
    if (expectedStageId !== data.stageId) return null;
    // Old snapshots have no context and intentionally retain the existing
    // migration behavior. Once a snapshot explicitly records its ephemeris,
    // loading it under a different epoch/profile/pack would make its absolute
    // celestial state ambiguous, so decline it.
    if (!isEphemerisContextCompatible(
      (data as { ephemerisContext?: unknown }).ephemerisContext,
      CURRENT_EPHEMERIS_CONTEXT,
    )) return null;
    return data;
  }
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
    ammos: game.entities.ammos.map(a => a.serialize()),
    bases: game.entities.bases.map(b => b.serialize()),
    stage: game.activeStage.serialize(),
    camera: { view: game.viewManager.serializeView(), ...game.cameraSystem.serialize() },
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
