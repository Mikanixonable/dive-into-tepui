// 戦闘ビューの武装の帯(#hud-weapon-strip、画面固定バッジ)の同期。弾帯の残りをセルで、残弾・予備の
// 弾倉数・装填の操作とあわせて示す。機関砲を持たない操作対象では隠す。
import { KEY_MAPPING as K } from '../../../input/key-mapping';
import { Button } from '../../../hud/widgets';
import { applyAlarmLevel } from '../../../hud/alarm-level';
import { setReadout } from '../../../hud/readout';
import { ammoAlarmLevel } from '../../alarm/alarm-level';
import { MAG_ROUNDS } from '../../player/ammo-spec';
import { SyncThrottle } from '../sync-throttle';
import type { HudEls } from '../hud-els';

const SYNC_INTERVAL_MS = 100;

// 機関砲の1フレーム分の状態と、装填の操作。機関砲を積んでいない操作対象では組まない(null)。
export interface WeaponStripViewModel {
  // 装填中の弾倉の残弾。
  readonly rounds: number;
  // 予備の弾倉の数。
  readonly mags: number;
  // 装填の完了を待っている間 true。
  readonly reloading: boolean;
  // キー押下と同じ経路で装填を発火する。
  reload(): void;
}

export class WeaponStrip {
  private readonly throttle = new SyncThrottle(SYNC_INTERVAL_MS);
  // 直近の sync で受け取った状態。ボタン押下はフレーム外で発生するため、現在のコールバックをここから取得する。
  private view: WeaponStripViewModel | null = null;
  private readonly cells: readonly HTMLElement[];
  private readonly strip: HTMLElement;

  // els が指す帯の中へ、弾帯のセルと装填ボタンを組み込む。
  public constructor(private readonly els: HudEls) {
    this.strip = els.get('weapon-strip');
    const belt = els.get('weapon-belt');
    this.cells = Array.from({ length: MAG_ROUNDS }, () => belt.appendChild(document.createElement('i')));
    const reload = new Button('装填', () => this.view?.reload(), undefined, ['dense', 'secondary'], K.reload.label);
    reload.element.title = 'マニュアル装填';
    reload.element.setAttribute('aria-keyshortcuts', K.reload.label);
    els.get('weapon-reload').appendChild(reload.element);
  }

  // 帯を view の値へ合わせる。view が null(機関砲が無い、または操作対象が無い)なら帯ごと隠す。
  public sync(view: WeaponStripViewModel | null, nowMs: number): void {
    this.view = view;
    this.strip.classList.toggle('hidden', view === null);
    if (view === null || !this.throttle.due(nowMs)) return;

    // 弾帯のセルと注意・警告の段。
    const rounds = Math.max(0, Math.min(MAG_ROUNDS, view.rounds));
    const mags = Math.max(0, view.mags);
    this.cells.forEach((cell, i) => cell.classList.toggle('spent', i >= rounds));
    applyAlarmLevel(this.strip, ammoAlarmLevel(rounds, mags));

    // 残弾の表示は、装填中・弾切れ・通常の順に優先する。
    const empty = rounds <= 0 && mags <= 0;
    const count = this.els.get('weapon-count');
    if (view.reloading) setReadout(count, 'RELOADING');
    else if (empty) setReadout(count, '弾切れ');
    else setReadout(count, `${rounds}`, `/ ${MAG_ROUNDS}`);
    setReadout(this.els.get('weapon-mags'), `${mags}`, '連');
  }
}
