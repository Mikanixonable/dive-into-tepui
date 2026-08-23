import { KEY_MAPPING as K } from '../../input/key-mapping';
import { SPACE_4, SPACE_6 } from '../../theme';
import { CLICK_MOVE_THRESHOLD } from '../../const';
import { clampOverlayPosition, Point2 } from '../layout';
import { onViewportChange } from '../viewport';
import type { OverlayHandle, OverlayManager } from '../overlay-manager';
import {
  Button, CloseButton, COLLAPSE_COLLAPSED_GLYPH, COLLAPSE_EXPANDED_GLYPH, Slider,
} from '../widgets';

export class PauseMenu implements OverlayHandle {
  private readonly panel: HTMLElement;
  private readonly body: HTMLElement;
  private readonly minimizeToggle: HTMLButtonElement;
  private _isOpen = false;
  private minimized = false;
  private hasCustomPosition = false;

  onPauseMenuOpenChange: ((open: boolean) => void) | null = null;
  onQuitToTitle: (() => void) | null = null;
  onBgmVolumeChange: ((vol: number) => void) | null = null;
  onSave: (() => void) | null = null;
  onOpenSaveBrowser: (() => void) | null = null;
  onOpenPerfWindow: (() => void) | null = null;
  onOpenSettings: (() => void) | null = null;

  private readonly overlayManager: OverlayManager;
  private readonly bgmSlider: Slider;
  private readonly bgmMute: Button;
  // ミュート/復帰を切り替えるための直前の音量。ミュート状態そのものは bgmSlider の値
  // (0 かどうか)から読めるので別に持たない。
  private lastVol = 1;

  private dragPointerId: number | null = null;
  private dragStartClient: Point2 | null = null;
  private dragStartWindowPos: Point2 = { x: 0, y: 0 };

  // BGM・セーブ・セーブデータの管理・負荷表示・設定ビューを開く・タイトルへ戻るのイベントを
  // 配線したパネル DOM を組み立てる。ヘッダーはドラッグ移動と最小化トグルを持つ。
  constructor(root: HTMLElement, overlayManager: OverlayManager) {
    this.overlayManager = overlayManager;
    this.panel = document.createElement('div');
    this.panel.id = 'hud-pause-menu';
    this.panel.className = 'panel';

    const header = document.createElement('div');
    header.className = 'pm-header';
    const heading = document.createElement('h3');
    heading.textContent = '一時停止 / 設定';
    header.appendChild(heading);
    this.minimizeToggle = document.createElement('button');
    this.minimizeToggle.type = 'button';
    this.minimizeToggle.className = 'pm-minimize';
    this.minimizeToggle.addEventListener('pointerdown', (e) => e.stopPropagation());
    this.minimizeToggle.addEventListener('click', () => this.setMinimized(!this.minimized));
    const closeBtn = new CloseButton(() => this.toggle(false));
    const headerActions = document.createElement('div');
    headerActions.className = 'pm-header-actions';
    headerActions.appendChild(this.minimizeToggle);
    headerActions.appendChild(closeBtn.element);
    header.appendChild(headerActions);
    header.addEventListener('pointerdown', this.handleHeaderPointerDown);
    header.addEventListener('pointermove', this.handleHeaderPointerMove);
    header.addEventListener('pointerup', this.handleHeaderPointerUp);
    header.addEventListener('pointercancel', this.handleHeaderPointerUp);
    this.panel.appendChild(header);

    this.body = document.createElement('div');
    this.body.className = 'pm-body';
    this.panel.appendChild(this.body);
    this.syncMinimizeToggle();

    const bgmRow = document.createElement('div');
    bgmRow.className = 'pm-row';
    const bgmLabel = document.createElement('span');
    bgmLabel.className = 'k';
    bgmLabel.textContent = 'BGM Vol';
    bgmRow.appendChild(bgmLabel);
    this.bgmSlider = new Slider({ min: 0, max: 1, step: 0.05 }, (vol) => {
      this.updateMuteState(vol);
      this.onBgmVolumeChange?.(vol);
    });
    this.bgmSlider.setValue(1);
    this.bgmSlider.element.style.flex = '1';
    this.bgmSlider.element.style.marginLeft = SPACE_4;
    bgmRow.appendChild(this.bgmSlider.element);
    this.bgmMute = new Button('消音', () => this.toggleMute());
    this.bgmMute.element.style.marginLeft = SPACE_4;
    bgmRow.appendChild(this.bgmMute.element);
    this.body.appendChild(bgmRow);

    const saveRow = document.createElement('div');
    saveRow.className = 'pm-row';
    saveRow.style.marginTop = SPACE_6;
    const saveBtn = new Button('セーブ', () => this.onSave?.());
    saveBtn.element.classList.add('pm-menu-btn');
    saveBtn.element.style.flex = '1';
    saveRow.appendChild(saveBtn.element);
    this.body.appendChild(saveRow);

    const saveBrowserRow = document.createElement('div');
    saveBrowserRow.className = 'pm-row';
    saveBrowserRow.style.marginTop = SPACE_4;
    const saveBrowserBtn = new Button('セーブデータの管理', () => this.onOpenSaveBrowser?.());
    saveBrowserBtn.element.classList.add('pm-menu-btn');
    saveBrowserBtn.element.style.flex = '1';
    saveBrowserRow.appendChild(saveBrowserBtn.element);
    this.body.appendChild(saveBrowserRow);

    const perfRow = document.createElement('div');
    perfRow.className = 'pm-row';
    perfRow.style.marginTop = SPACE_4;
    const perfBtn = new Button(`負荷を表示 [${K.togglePerfWindow.label}]`, () => this.onOpenPerfWindow?.());
    perfBtn.element.classList.add('pm-menu-btn');
    perfBtn.element.style.flex = '1';
    perfRow.appendChild(perfBtn.element);
    this.body.appendChild(perfRow);

    const settingsRow = document.createElement('div');
    settingsRow.className = 'pm-row';
    settingsRow.style.marginTop = SPACE_4;
    const settingsBtn = new Button('設定ビューを開く', () => this.onOpenSettings?.());
    settingsBtn.element.classList.add('pm-menu-btn');
    settingsBtn.element.style.flex = '1';
    settingsRow.appendChild(settingsBtn.element);
    this.body.appendChild(settingsRow);

    const quitBtn = new Button('ゲームを中断してタイトル画面に戻る', () => this.onQuitToTitle?.());
    quitBtn.element.classList.add('pm-menu-btn', 'pm-quit');
    this.body.appendChild(quitBtn.element);

    root.appendChild(this.panel);
    onViewportChange(() => this.reclamp());
  }

  // ミュート/復帰を切り替える。復帰は直前の音量へ戻す。
  private toggleMute(): void {
    if (this.bgmSlider.getValue() > 0) {
      this.lastVol = this.bgmSlider.getValue();
      this.bgmSlider.setValue(0);
    } else {
      this.bgmSlider.setValue(this.lastVol || 1);
    }
    this.updateMuteState(this.bgmSlider.getValue());
    this.onBgmVolumeChange?.(this.bgmSlider.getValue());
  }

  // 消音ボタンの点灯を音量から合わせる。
  private updateMuteState(vol: number): void {
    this.bgmMute.setOn(vol <= 0);
  }

  // 最小化状態を切り替える。永続化はせず、開き直すたびに展開状態へ戻る。
  private setMinimized(minimized: boolean): void {
    this.minimized = minimized;
    this.body.classList.toggle('hidden', minimized);
    this.syncMinimizeToggle();
    this.reclamp();
  }

  private syncMinimizeToggle(): void {
    this.minimizeToggle.textContent = this.minimized ? COLLAPSE_COLLAPSED_GLYPH : COLLAPSE_EXPANDED_GLYPH;
    this.minimizeToggle.setAttribute('aria-expanded', String(!this.minimized));
    this.minimizeToggle.title = this.minimized ? '展開する' : '最小化する';
  }

  contains(target: Node): boolean {
    return this.panel.contains(target);
  }

  // OverlayHandle 実装。ESC で閉じる際も toggle(false) と等価に扱う。
  close(): void {
    this.toggle(false);
  }

  // パネルの開閉を切り替える。force を渡すと開閉状態を明示的に指定する。
  toggle(force?: boolean): void {
    const show = force !== undefined ? force : !this._isOpen;
    if (show === this._isOpen) return;
    this._isOpen = show;
    this.panel.style.display = show ? 'block' : 'none';
    // タイトル選択画面(#stage-select)は HUD より前面にあるため、タイトル中に
    // メニューを開いたときだけ HUD をその上へ出す。通常のゲーム中は影響しない。
    this.panel.closest<HTMLElement>('#hud')?.classList.toggle(
      'title-menu-open', show && document.getElementById('stage-select') !== null,
    );
    if (show) {
      if (!this.hasCustomPosition) this.centerPanel();
      // ESCメニュー表示中も、背景のマップ切替とカメラ操作は受け付ける(gatesInput: false)。
      this.overlayManager.open('pause-menu', this, {
        kind: 'modal', closeOnEscape: true, closeOnOutsideClick: false, gatesInput: false,
        exclusiveGroup: 'system-modal',
      });
    } else {
      this.overlayManager.close('pause-menu');
    }
    this.onPauseMenuOpenChange?.(show);
  }

  // 画面中央へ配置する。初回表示時のみ呼ぶ — 以降はドラッグした位置を維持する。
  private centerPanel(): void {
    const rect = this.panel.getBoundingClientRect();
    this.moveTo((window.innerWidth - rect.width) / 2, (window.innerHeight - rect.height) / 2);
  }

  // 要求座標をビューポート内へクランプして配置する。
  private moveTo(clientX: number, clientY: number): void {
    const rect = this.panel.getBoundingClientRect();
    const pos = clampOverlayPosition(
      { x: clientX, y: clientY },
      { width: rect.width, height: rect.height },
      { width: window.innerWidth, height: window.innerHeight },
    );
    this.panel.style.left = `${pos.x}px`;
    this.panel.style.top = `${pos.y}px`;
  }

  // 現在位置をビューポート内へ収め直す。ウィンドウリサイズと最小化(サイズ変化)の両方から呼ぶ。
  private reclamp(): void {
    if (!this._isOpen) return;
    this.moveTo(this.panel.offsetLeft, this.panel.offsetTop);
  }

  // ボタン上からは開始せず、ドラッグ開始点とポインタキャプチャだけ確保する。
  private handleHeaderPointerDown = (e: PointerEvent): void => {
    if (e.target instanceof Element && e.target.closest('button')) return;
    this.dragPointerId = e.pointerId;
    this.dragStartClient = { x: e.clientX, y: e.clientY };
    this.dragStartWindowPos = { x: this.panel.offsetLeft, y: this.panel.offsetTop };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };

  // しきい値(CLICK_MOVE_THRESHOLD)を超えて動いたら位置を持ち出し位置として確定させる。
  private handleHeaderPointerMove = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId || this.dragStartClient === null) return;
    const dx = e.clientX - this.dragStartClient.x;
    const dy = e.clientY - this.dragStartClient.y;
    if (!this.hasCustomPosition && Math.hypot(dx, dy) < CLICK_MOVE_THRESHOLD) return;
    this.hasCustomPosition = true;
    this.moveTo(this.dragStartWindowPos.x + dx, this.dragStartWindowPos.y + dy);
  };

  // ポインタキャプチャを解放してドラッグ状態を終える。
  private handleHeaderPointerUp = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return;
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    this.dragPointerId = null;
    this.dragStartClient = null;
  };

  // BGM スライダーの表示を更新する。
  setBgmVolume(vol: number): void {
    this.bgmSlider.setValue(vol);
    this.updateMuteState(vol);
  }
}
