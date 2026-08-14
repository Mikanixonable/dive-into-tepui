import type { Game } from './game/game';
import type { Input } from './game/input/input';
import { KEY_MAPPING as K } from './game/input/key-mapping';
import { ResultScreen, type RunTransitions } from './game/hud/result-screen';
import type { Hud } from './game/hud/hud';
import type { GamePhase, StageClass, StageResult } from './game/stages/stage';
import { findStageClass } from './game/stages/stage-dictionary';
import { selectStage } from './game/stage-select';
import type { UnlockManager } from './game/unlock-manager';
import type { SaveSlots } from './game/save/save-slots';
import type { SnapshotService } from './game/save/snapshot-service';
import type { GameSaveData } from './game/save-data';
import type { Sfx } from './audio/sfx';

// スナップショットのロードを跨いで次のページ読込へ渡す先。ロードは Game を作り直す
// (=ページ再読込)ことで表現するため、どれを復元するかは sessionStorage 経由で伝える。
const SNAPSHOT_PENDING_KEY = 'tepui.pendingSnapshot';

// アクティブスロットの直近起動が今も選択可能(ロック解除済み・選択画面から隠されていない)なら、
// そのステージクラスを返す。再開できる情報が無ければ null。
function resumableStageClass(unlockManager: UnlockManager, slots: SaveSlots): StageClass | null {
  const slot = slots.activeSlot();
  if (slot === null) return null;
  const stageClass = findStageClass(slot.lastStageId);
  if (stageClass === null || stageClass.hiddenFromSelect || !unlockManager.isUnlocked(stageClass.id)) return null;
  return stageClass;
}

// StageResult はセーブに含まれないので、決着済みの phase を持つセーブを読んだときは
// 見出しだけを phase から復元する。内訳は残っていない。
function fallbackResult(phase: GamePhase): StageResult {
  return { win: phase !== 'lost', title: null, detailHtml: '結果の記録がありません' };
}

// 再出撃・タイトル復帰・スナップショットのロード・スロット切替 — 「Game インスタンスを
// 捨てて次の周回へ移る」判断を1箇所へ集約する。game/ 配下は location.* を一切知らない。
export class Launcher implements RunTransitions {
  private readonly resultScreen: ResultScreen;
  private launchedStage: StageClass | null = null;
  private resultShown = false;

  constructor(
    hud: Hud,
    private readonly unlockManager: UnlockManager,
    private readonly slots: SaveSlots,
    private readonly snapshotService: SnapshotService,
    private readonly sfx: Sfx,
  ) {
    this.resultScreen = new ResultScreen(hud, this);
  }

  // ?title=1 は選択画面へ強制する。?stage= は共有リンク・デバッグ用の明示指定として最優先。
  // どちらも無ければアクティブスロットの直近起動を再開し、それも無ければ選択画面を出す。
  async resolveStage(onTitleEscape?: () => void, onTitleClose?: () => void): Promise<StageClass> {
    const params = new URLSearchParams(location.search);
    if (params.get('title') !== '1') {
      const fromParam = findStageClass(params.get('stage'));
      if (fromParam !== null) return fromParam;
      const resumed = resumableStageClass(this.unlockManager, this.slots);
      if (resumed !== null) return resumed;
    }
    return selectStage(this.unlockManager, onTitleEscape, onTitleClose);
  }

  // ページ再読込を挟んだスナップショットのロード要求を最優先で使う。無ければ、
  // 起動するステージがアクティブスロットの直前起動と同じ場合(=そのスロットで
  // 進行中だった周回の再開)に限り、そのステージの最新スナップショットを自動で復元する。
  // noteLaunched は Game 構築後に呼ばれるため、この時点の lastStageId は今回の起動より
  // 前の値を指している。本体の欠損・バージョン不一致・ステージ不一致は
  // SnapshotService.load() に判定させ、復元できない場合は通常の新規起動状態をそのまま使う。
  initialSaveFor(stageClass: StageClass): GameSaveData | undefined {
    const activeSlotId = this.slots.activeSlotId;
    const pendingSnapshotId = sessionStorage.getItem(SNAPSHOT_PENDING_KEY);
    sessionStorage.removeItem(SNAPSHOT_PENDING_KEY);
    const resumesLastLaunchedStage = activeSlotId !== null && this.slots.activeSlot()?.lastStageId === stageClass.id;
    const initialSnapshotId = pendingSnapshotId
      ?? (resumesLastLaunchedStage ? this.slots.latestSnapshot(activeSlotId, stageClass.id)?.id ?? null : null);
    const initialSave = initialSnapshotId !== null
      ? this.snapshotService.load(initialSnapshotId, stageClass.id) ?? undefined
      : undefined;
    // ロードした時点より後の自動スナップショットは、もう起きなかった未来なので破棄する。
    if (initialSave && initialSnapshotId !== null) this.slots.discardAfter(initialSnapshotId);
    return initialSave;
  }

  // 実際に遊び始めたステージをスロットへ記録し、restart() のために覚えておく。
  noteLaunched(stageClass: StageClass): void {
    this.launchedStage = stageClass;
    const activeSlotId = this.slots.activeSlotId;
    if (activeSlotId !== null) this.slots.noteLaunch(activeSlotId, stageClass.id);
  }

  // 決着した最初のフレームだけ、周回を締めて結果画面を出す。
  update(game: Game): void {
    if (this.resultShown || game.activeStage.isPlaying) return;
    this.resultShown = true;
    this.sfx.setThrust(false);
    this.sfx.stopBgm();
    const activeSlotId = this.slots.activeSlotId;
    if (activeSlotId !== null) this.slots.noteRunEnded(activeSlotId);
    this.resultScreen.show(game.activeStage.result ?? fallbackResult(game.activeStage.phase));
  }

  // [R] は決着後だけ再出撃キーとして働く。game.update が消費しなかったエッジだけを見る。
  handleInput(input: Input, game: Game): void {
    if (game.activeStage.isPlaying) return;
    if (input.takeKey(K.restart)) this.restart();
  }

  // ?stage= を明示して replace する: 素のリロードでは選択画面へ戻るため。
  restart(): void {
    if (this.launchedStage === null) return;
    location.replace(`${location.pathname}?stage=${this.launchedStage.id}`);
  }

  returnToTitle(): void {
    location.assign(`${location.pathname}?title=1`);
  }

  // スナップショットのロードは別のゲームを始めることなので、ページごと作り直す。
  loadSnapshot(snapshotId: string): void {
    sessionStorage.setItem(SNAPSHOT_PENDING_KEY, snapshotId);
    location.assign(location.pathname);
  }

  switchSlot(): void {
    location.assign(location.pathname);
  }
}
