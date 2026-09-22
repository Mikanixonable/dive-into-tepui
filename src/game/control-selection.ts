// 操作対象(自機船 0..n 隻と基地のうち、ちょうど1つ)の選択。選び直しと、操作対象候補を世界から
// 取り除いたことを出来事として記録する。
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import type { DynamicSystem } from './dynamic/dynamic-system';

// 操作対象の直列化した形。操作対象の id で、操作していなければ null。
export type SerializedControlSelection = string | null;

export class ControlSelection {
  // current を操作対象にして始める。省けば生存中の先頭、操作できるものが1つも無ければ null。
  private constructor(
    private readonly dynamicSystem: DynamicSystem,
    private _current: Controllable | null = dynamicSystem.controllables.find((c) => c.motion.alive) ?? null,
  ) {}

  // 登録された操作可能エンティティのうち生存中の先頭を操作対象にして初期化する。
  public static create(dynamicSystem: DynamicSystem): ControlSelection {
    return new ControlSelection(dynamicSystem);
  }

  // シリアライズされた id の操作対象を、復元されたエンティティ一覧から再選択して初期化する。null なら未操作のまま
  // 開始する。エンティティ一覧に無い id なら、新規開始時と同様に生存中の先頭を選択する。
  public static deserialize(serialized: SerializedControlSelection, dynamicSystem: DynamicSystem): ControlSelection {
    if (serialized === null) return new ControlSelection(dynamicSystem, null);
    const target = dynamicSystem.controllables.find((c) => c.id === serialized && c.motion.alive)
      ?? dynamicSystem.controllables.find((c) => c.motion.alive)
      ?? null;
    return new ControlSelection(dynamicSystem, target);
  }

  // 直列化した形へ変換する。
  public serialize(): SerializedControlSelection {
    return this._current?.id ?? null;
  }

  public get current(): Controllable | null { return this._current; }

  // 操作対象(操作・追従カメラ・計画編集の対象)を差し替え、選び直したことを記録する。
  public select(target: Controllable): void {
    if (this._current === target) return;
    this._current?.clearTransientCommands();
    this._current = target;
    this.dynamicSystem.events.record(
      { kind: 'controlTargetSelected', target: target.mapKind, name: target.name });
  }

  // 未操作状態(全滅、または操作対象の手動解除)へ戻す。
  public clear(): void {
    if (this._current === null) return;
    this._current.clearTransientCommands();
    this._current = null;
  }

  // 操作対象を手で外す。外れたときだけ記録する(全滅による喪失とは別の経路)。
  public release(target: Controllable): void {
    if (this._current !== target) return;
    this.clear();
    this.dynamicSystem.events.record({ kind: 'controlTargetReleased', target: target.mapKind });
  }

  // 操作対象が居ない間に増えたものを、そのまま操作対象にする。既に居れば何もしない。
  public claimIfNone(target: Controllable): void {
    if (this._current === null) this.select(target);
  }

  // 世界から取り除き、取り除いたことを記録する。操作対象だった場合は他の生存個体へ引き継ぐか、
  // 無ければ未操作へ戻す。
  public remove(target: Controllable): void {
    const wasActive = this._current === target;
    this.dynamicSystem.events.record({ kind: 'controllableRemoved', id: target.id });
    if (wasActive) {
      target.clearTransientCommands();
      this._current = null;
    }
    this.dynamicSystem.remove(target);
    if (wasActive) this.reclaimAfterLoss();
  }

  // 喪失した操作対象候補を回収・整理する。
  public reclaimDead(): void {
    let lostActive = false;
    // remove() がコレクションを変更するため、ループ走査は開始時の浅いコピーに対して行う。
    for (const lost of [...this.dynamicSystem.controllables]) {
      if (lost.motion.alive) continue;
      if (this._current === lost) {
        this._current = null;
        lostActive = true;
      }
      this.remove(lost);
    }
    if (lostActive) this.reclaimAfterLoss();
  }

  // 操作対象を失った直後に呼ぶ。他に生存しているものがあれば引き継ぎ、無ければ未操作へ戻す。
  private reclaimAfterLoss(): void {
    const next = this.dynamicSystem.controllables.find((c) => c.motion.alive) ?? null;
    if (next) this.select(next);
    else this.clear();
  }
}
