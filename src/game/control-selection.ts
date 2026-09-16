// 操作対象(自機船 0..n 隻と基地のうち、ちょうど1つ)の選択。選び直しと、操作対象候補を世界から
// 取り除いたことを出来事として記録する。
import type { Controllable } from './dynamic/dynamic-entity/controllable';
import type { DynamicSystem } from './dynamic/dynamic-system';

export class ControlSelection {
  private _current: Controllable | null;

  // 起動時の操作対象を自分で解決する。savedId に一致するもの、無ければ生存中の先頭、
  // 操作できるものが1つも無ければ null。
  constructor(
    savedId: string | null | undefined,
    private readonly dynamicSystem: DynamicSystem,
  ) {
    const candidates = dynamicSystem.controllables;
    this._current = candidates.find((c) => c.id === savedId)
      ?? candidates.find((c) => c.motion.alive)
      ?? null;
  }

  get current(): Controllable | null { return this._current; }

  // 操作対象(操作・追従カメラ・計画編集の対象)を差し替え、選び直したことを記録する。
  select(target: Controllable): void {
    if (this._current === target) return;
    this._current?.clearTransientCommands();
    this._current = target;
    this.dynamicSystem.events.record(
      { kind: 'controlTargetSelected', target: target.mapKind, name: target.name });
  }

  // 未操作状態(全滅、または操作対象の手動解除)へ戻す。
  clear(): void {
    if (this._current === null) return;
    this._current.clearTransientCommands();
    this._current = null;
  }

  // 操作対象を手で外す。外れたときだけ記録する(全滅による喪失とは別の経路)。
  release(target: Controllable): void {
    if (this._current !== target) return;
    this.clear();
    this.dynamicSystem.events.record({ kind: 'controlTargetReleased', target: target.mapKind });
  }

  // 操作対象が居ない間に増えたものを、そのまま操作対象にする。既に居れば何もしない。
  claimIfNone(target: Controllable): void {
    if (this._current === null) this.select(target);
  }

  // 世界から取り除き、取り除いたことを記録する。操作対象だった場合は他の生存個体へ引き継ぐか、
  // 無ければ未操作へ戻す。
  remove(target: Controllable): void {
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
  reclaimDead(): void {
    let lostActive = false;
    // remove() が顔ぶれを触るので、走査は開始時の並びの写しに対して行う。
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
