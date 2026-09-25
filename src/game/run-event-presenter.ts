// 直近のシミュレーション進行で記録されたイベントを読み、そのフレームで再生する効果音やトースト通知へ変換・反映するプレゼンテーション層。
// 文面とキーのラベルはここで組む。
import { KEY_MAPPING as K } from '../input/key-mapping';
import { MAX_PHYS_SIM_SPEED } from './dynamic/sim-speed-manager';
import { THROTTLE_LABELS, THROTTLE_LEVELS } from './player/throttle';
import { len, sub } from '../math/vec3';
import type { Notifier } from '../hud/notifier';
import type { SoundCue } from '../audio/sfx/sound-cue';
import type { WorldSound } from '../audio/sfx/world-sfx';
import type { UiSoundQueue } from './ui-sound-queue';
import type { Attitude } from '../physics/attitude';
import type { KinematicState } from '../physics/kinematic-state';
import type { EnemyDeathCause } from './stages/stage-outcome';
import type { RunEvent, RunEventBody, ShipRequiredAction } from './run-events';

// 内部エラーの告知を出しておく時間 [ms]。読み落とさないよう、通常の告知より長く置く。
const CORRUPTION_TOAST_MS = 60000;

// 自然損耗の理由ごとの文言。cause を足すと文言の追加漏れが型検査で落ちる。
const ENEMY_LOSS_TEXT: Record<Exclude<EnemyDeathCause, 'killed'>, string> = {
  burnup: '大気圏で焼失',
  collision: '天体へ衝突',
  despawn: '交戦圏を離脱',
};

// 操作艦が要る操作ごとの、操作艦が居ないときの文言。
const SHIP_REQUIRED_TEXT: Record<ShipRequiredAction, string> = {
  addMagazine: '操作艦がいないためマガジンを追加できません',
  refillRcsFuel: '操作艦がいないためRCS燃料を補充できません',
  spawnEnemy: '操作艦がいないため敵をスポーンできません',
};

// 位置・速度を告知の文言用の文字列にする。
function describeState(state: KinematicState): string {
  const { r, v } = state;
  return `r=(${r.x},${r.y},${r.z}) v=(${v.x},${v.y},${v.z})`;
}

// 姿勢を告知の文言用の文字列にする。
function describeAttitude(attitude: Attitude): string {
  const { q, w } = attitude;
  return `q=(${q.x},${q.y},${q.z},${q.w}) w=(${w.x},${w.y},${w.z})`;
}

// 汚染の告知の本文。detail には壊れていた対象とその値を渡す。
function corruptionMessage(phase: string, dt: number, simDt: number, detail: string): string {
  return `シミュレーション状態が壊れました(NaN/Infinity)。phase=${phase} dt=${dt} simDt=${simDt} — ${detail}`;
}

// 出来事 body が伴うゲーム世界の効果音。音を伴わない出来事なら null。
function worldSoundOf(body: RunEventBody): WorldSound | null {
  switch (body.kind) {
    case 'gunFired': return { kind: 'fire' };
    case 'gunSpunUp': return { kind: 'spinUp' };
    case 'gunDryFired': return { kind: 'emptyClick' };
    case 'gunMagazineFed': return { kind: 'magFeed' };
    case 'gunBarrelSwapped': return { kind: 'reload' };
    // 被弾音は着弾点と艦の距離で減衰する。距離はここで出す。
    case 'shipStruck': return { kind: 'hit', impactDistance: len(sub(body.impactPoint, body.shipState.r)) };
    case 'shipDamagedByContact':
    case 'enemyDamagedByContact':
    case 'casingContacted': return { kind: 'clank' };
    case 'enemyStruckByBullet': return { kind: 'enemyHit' };
    case 'shipExploded': return { kind: 'explosion' };
    case 'plasmaPassedClose': return { kind: 'magneticInterference' };
    case 'altitudeWarned': return { kind: 'altAlarm' };
    case 'boosterDecoupled': return { kind: 'decouple' };
    case 'ammoPickedUp':
    case 'rcsFuelPickedUp': return { kind: 'pickup' };
    default: return null;
  }
}

// 出来事 events が伴うゲーム世界の効果音の宣言。id は出来事の通し番号。
export function worldSoundCues(events: readonly RunEvent[]): SoundCue<WorldSound>[] {
  const cues: SoundCue<WorldSound>[] = [];
  for (const { seq, body } of events) {
    const sound = worldSoundOf(body);
    if (sound !== null) cues.push({ id: seq, sound });
  }
  return cues;
}

export class RunEventPresenter {
  // 最後に処理したイベントのシーケンス番号。同一イベントを二重処理しないために保持する。
  private lastSeq = -1;

  // UI の効果音は uiSounds へ溜め、通知は notifier へ出す。
  public constructor(
    private readonly uiSounds: UiSoundQueue,
    private readonly notifier: Notifier,
  ) { }

  // 記録されたイベントのうち、未処理のものを UI 効果音やトースト通知へ反映する。
  public present(events: readonly RunEvent[]): void {
    for (const event of events) {
      if (event.seq <= this.lastSeq) continue;
      this.lastSeq = event.seq;
      this.show(event.body);
    }
  }

  // イベント1件を、対応する UI 効果音やトースト通知へ変換して発行する。
  private show(body: RunEventBody): void {
    switch (body.kind) {
      case 'simSpeedChanged': {
        this.uiSounds.push('warp');
        // 操作できない倍率へ上げたときは、自機の操作が効かなくなったことを併記する。
        const gated = body.shipActs ? '' : `(自機の操作はワープ ×${MAX_PHYS_SIM_SPEED} 以下でのみ可能)`;
        this.notifier.hint(`時間加速 ×${body.speed}${gated}`, undefined, 'nav');
        return;
      }
      case 'autoWarpStarted':
        this.notifier.hint('ノードへ自動ワープ開始', undefined, 'nav');
        return;
      case 'autoWarpCancelled':
        this.notifier.hint('自動ワープ解除', undefined, 'nav');
        return;
      case 'autoWarpUnavailable':
        this.notifier.hint(body.reason === 'noNode'
          ? `マニューバノードがありません ([${K.toggleMapMode.label}] で計画)`
          : 'ノード時刻を通過しています', undefined, 'warn');
        return;
      case 'controlledStateCorrupted': {
        const detail = `controlled ${describeState(body.state)} ${describeAttitude(body.attitude)} simTime=${body.simTime}`;
        this.showCorruption(corruptionMessage(body.phase, body.dt, body.simDt, detail));
        return;
      }
      case 'entityStateCorrupted': {
        const detail = `${body.subject} ${describeState(body.state)}`;
        this.showCorruption(corruptionMessage(body.phase, body.dt, body.simDt, detail));
        return;
      }

      case 'gunDisabled':
        this.notifier.hint('武装が損傷しており発射できない', 3000, 'warn');
        return;
      case 'gunOutOfAmmo':
        this.notifier.hint('弾薬切れ — 軌道上の補給 ▣ を回収せよ', 3000, 'warn');
        return;

      case 'enemyDied':
        this.notifier.hint(body.cause === 'killed'
          ? `${body.name} 撃破`
          : `${body.name} ${ENEMY_LOSS_TEXT[body.cause]}`);
        return;
      case 'shipLost':
        this.notifier.hint(body.reason, undefined, 'warn');
        return;

      case 'altitudeWarned':
        this.notifier.hint(`警告: 高度が${Math.round(body.threshold / 1000)}km以下です`, 3000, 'warn');
        return;
      case 'rcsDampToggled':
        this.notifier.hint(`RCS 回転制動: ${body.on ? 'ON' : 'OFF'}`);
        return;
      case 'progradeHoldReset':
        this.notifier.hint('プログレード姿勢リセット(機首を進行方向へ)');
        return;
      case 'progradeHoldToggled':
        this.notifier.hint(`進行方向ホールド: ${body.on ? 'ON (機首をプログレードへ保持)' : 'OFF'}`);
        return;
      case 'progradeHoldReleasedByInput':
        this.notifier.hint('進行方向ホールド解除(手動操作)');
        return;
      case 'throttlePresetSelected':
        this.showThrottlePreset(body.index);
        return;
      case 'fineAttitudeToggled':
        this.notifier.hint(`姿勢微調整モード: ${body.on ? 'ON' : 'OFF'}`);
        return;

      case 'boosterLimitReached':
        this.notifier.hint(`ブースターは最大 ${body.limit} 段です`, undefined, 'warn');
        return;
      case 'boosterAttached':
        this.notifier.hint(`ブースターを追加: ${body.stages} 段`);
        return;
      case 'boosterIgnitionUnavailable':
        this.notifier.hint('点火できるブースターがありません', undefined, 'warn');
        return;
      case 'boosterIgnitionToggled':
        this.notifier.hint(body.fuelEmpty
          ? '最後尾ブースターは燃料切れです'
          : `ブースター燃焼: ${body.on ? 'ON' : 'OFF'}`, undefined, body.fuelEmpty ? 'warn' : 'info');
        return;
      case 'boosterDecoupleUnavailable':
        this.notifier.hint('分離できるブースターがありません', undefined, 'warn');
        return;
      case 'boosterDecoupled':
        this.notifier.hint(`ブースター分離: 残り ${body.stages} 段`);
        return;

      case 'ammoResupplyDeployed':
        this.uiSounds.push('warp');
        this.notifier.hint('付近の軌道に補給が投入された — ▣ 弾薬マーカーへ接近して回収', 5000, 'nav');
        return;
      case 'rcsFuelResupplyDeployed':
        this.uiSounds.push('warp');
        this.notifier.hint('付近の軌道に RCS 燃料補給が投入された — ◈ 燃料マーカーへ接近して回収', 5000, 'nav');
        return;
      case 'ammoPickedUp':
        this.notifier.hint(`補給取り込み — ベルト +${body.mags} 連`, 3000);
        return;
      case 'rcsFuelPickedUp':
        this.notifier.hint(`補給取り込み — RCS燃料 +${Math.round(body.fuel)} kg`, 3000);
        return;

      case 'maneuverNodeApproaching':
        this.notifier.hint('マニューバ実行点に接近 — BURN ガイドの方向へ加速せよ', 5000, 'plan');
        return;
      case 'maneuverNodeAchieved':
        if (body.remaining === 0) this.notifier.hint('✓ マニューバ達成 — 計画軌道に到達', 5000, 'plan');
        else this.notifier.hint(`✓ ノード達成 — 残り ${body.remaining} 件`, 4000, 'plan');
        this.uiSounds.push('warp');
        return;
      case 'planNodesDropped':
        this.notifier.hint(`${body.ship}: 起点より前のマニューバノード ${body.count} 件を復元できません`, undefined, 'warn');
        return;

      case 'combatViewUnavailable':
        this.notifier.hint('操作できる艦または基地がいません', undefined, 'warn');
        return;
      case 'maneuverPlanConfirmed':
        this.notifier.hint(`マニューバ計画 ${body.nodeCount} 件確定`, 4500, 'plan');
        return;
      case 'orbitPlanningOpened':
        this.notifier.hint(
          `軌道計画モード: 軌道をクリックしてノード配置 → ドラッグで移動・矢印ハンドルでΔv調整 → 右クリックでメニュー → [${K.toggleMapMode.label}] で確定`,
          5000,
          'plan',
        );
        return;

      case 'cameraViewReset':
        this.notifier.hint(body.view === 'map' ? 'マップビューの視点をリセット' : '視点をリセット');
        return;
      case 'cameraAttitudeFollowToggled':
        this.notifier.hint(`視点の姿勢追従: ${body.on ? 'ON(機体姿勢に追従)' : 'OFF(慣性系)'}`);
        return;
      case 'cameraReferenceViewSelected':
        this.notifier.hint(body.view === 'above' ? '基準面の真上を表示' : '基準面の真横を表示');
        return;

      case 'controlTargetSelected':
        // 自機は操作方法を HUD とヘルプが常設で示しているので、選び直しても案内を出さない。
        if (body.target === 'base') {
          this.notifier.hint(
            `基地「${body.name}」の操作モードに入りました (WASDQE: 噴射 / IJKLUO: 姿勢制御 / T: RCS減衰 / C: プログレード)`);
        }
        return;
      case 'controlTargetReleased':
        if (body.target === 'base') this.notifier.hint('基地の操作を解除しました');
        return;

      case 'navTargetToggled':
        this.notifier.hint(body.name === null ? 'ターゲット解除' : `ターゲット: ${body.name}`, undefined, 'nav');
        return;
      case 'navTargetLocked':
        this.notifier.hint(body.name === null ? 'ターゲット固定解除' : `ターゲット固定: ${body.name}`, undefined, 'nav');
        return;

      case 'waveAttackArmed':
        this.notifier.toast('弾薬を確保した。敵部隊が接近中...', 3000);
        return;
      case 'waveSpawned':
        this.notifier.toast(`波状攻撃 第${body.wave}波 接近中！`, 3000);
        return;

      case 'objectPlaced':
        this.notifier.hint(`${body.name} を配置`);
        return;
      case 'objectPlacementRejected':
        this.notifier.hint(`配置できません: ${body.reason}`, 5000, 'warn');
        return;
      case 'shipPlacementLimitReached':
        this.notifier.hint(`配置数が上限(${body.limit}隻)に達しています`, undefined, 'warn');
        return;
      case 'orbitNotDuplicable':
        this.notifier.hint('この軌道は要素として複製できないため、種類だけを引き継いだ新規配置として開きます', undefined, 'warn');
        return;
      case 'shipRequiredForAction':
        this.notifier.hint(SHIP_REQUIRED_TEXT[body.action], undefined, 'warn');
        return;
    }
  }

  // 並進出力の段の案内。段の表に無い index では何も出さない。
  private showThrottlePreset(index: number): void {
    const label = THROTTLE_LABELS[index];
    const level = THROTTLE_LEVELS[index];
    if (label === undefined || level === undefined) return;
    this.notifier.hint(`並進出力: ${label} (${level.toFixed(1)} m/s²)`);
  }

  // 汚染の告知を、読み落とされない長さで画面へ出す。
  private showCorruption(message: string): void {
    this.notifier.toast(`<b>内部エラー: ${message}</b>`, CORRUPTION_TOAST_MS);
  }
}
