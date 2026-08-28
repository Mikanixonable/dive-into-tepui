import type { Bgm } from '../../../audio/bgm/bgm';
import { BGM_TRACKS } from '../../../audio/bgm/tracks/tracks';
import { Button, Slider } from '../widgets';

const SEEK_REFRESH_MS = 100;

// シークバー横の経過時間表示を「分:秒」の書式にする。
function formatSeekTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 設定ビューの「BGM」タブ。ゲーム中BGMの音量調整と、曲の試聴(選曲・再生位置のシーク・停止)を
// 扱う。試聴の音声経路そのものは Bgm が持ち、このパネルはボタン・スライダーの表示状態だけを持つ。
export class BgmSettingsPanel {
  public readonly element: HTMLElement;

  private readonly bgm: Bgm;
  private activeTrack: number | null = null;
  private readonly stopButton: Button;
  private readonly trackButtons: Button[] = [];
  private readonly seekSlider: Slider;
  private readonly seekTimeLabel: HTMLSpanElement;
  private seeking = false;
  private seekRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // 音量・再生位置・曲一覧・停止ボタンの4ブロックを縦に並べる。
  public constructor(bgm: Bgm) {
    this.bgm = bgm;
    this.element = document.createElement('div');

    // 音量: ゲーム中BGMそのものの音量。試聴の音量もこれに従う。
    const volumeRow = document.createElement('div');
    volumeRow.className = 'sv-volume-row';
    const volumeLabel = document.createElement('span');
    volumeLabel.className = 'sv-label';
    volumeLabel.textContent = '音量';
    volumeRow.appendChild(volumeLabel);
    const volumeValue = document.createElement('span');
    volumeValue.className = 'sv-volume-value';
    // 音量表示を百分率にする。
    const updateVolumeValue = (value: number): void => {
      volumeValue.textContent = `${Math.round(value * 100)}%`;
    };
    const volumeSlider = new Slider({ min: 0, max: 1, step: 0.05 }, (value) => {
      updateVolumeValue(value);
      this.bgm.setVolume(value);
    });
    volumeSlider.setValue(this.bgm.getVolume());
    updateVolumeValue(volumeSlider.getValue());
    volumeRow.appendChild(volumeSlider.element);
    volumeRow.appendChild(volumeValue);
    this.element.appendChild(volumeRow);

    // 再生位置: 試聴中の曲だけ操作できる。ドラッグ中は自動追従(refreshSeekPosition)で値を
    // 上書きしない。ポインタが要素の外へ出ても離した瞬間を取りこぼさないよう、pointer capture
    // で握ったまま追う。
    const seekRow = document.createElement('div');
    seekRow.className = 'sv-volume-row';
    const seekLabel = document.createElement('span');
    seekLabel.className = 'sv-label';
    seekLabel.textContent = '再生位置';
    seekRow.appendChild(seekLabel);
    this.seekSlider = new Slider({ min: 0, max: 1, step: 1 }, (value) => {
      this.seekTimeLabel.textContent = formatSeekTime(value);
      this.bgm.seekAudition(value);
    });
    this.seekSlider.element.addEventListener('pointerdown', (e) => {
      this.seeking = true;
      this.seekSlider.element.setPointerCapture(e.pointerId);
    });
    // pointerup/pointercancel のどちらでもドラッグを終える。
    const endSeeking = (e: PointerEvent): void => {
      this.seeking = false;
      this.seekSlider.element.releasePointerCapture(e.pointerId);
    };
    this.seekSlider.element.addEventListener('pointerup', endSeeking);
    this.seekSlider.element.addEventListener('pointercancel', endSeeking);
    this.seekSlider.element.disabled = true;
    seekRow.appendChild(this.seekSlider.element);
    this.seekTimeLabel = document.createElement('span');
    this.seekTimeLabel.className = 'sv-volume-value';
    this.seekTimeLabel.textContent = '0:00';
    seekRow.appendChild(this.seekTimeLabel);
    this.element.appendChild(seekRow);

    // 曲一覧: 押した曲を先頭から試聴する。
    const trackList = document.createElement('div');
    trackList.className = 'sv-track-list';
    for (const [index, track] of BGM_TRACKS.entries()) {
      const row = document.createElement('div');
      row.className = 'sv-track-row';
      const trackLabel = document.createElement('div');
      trackLabel.className = 'sv-track-label';
      const number = document.createElement('span');
      number.className = 'sv-track-number';
      number.textContent = String(index + 1).padStart(2, '0');
      const name = document.createElement('span');
      name.textContent = track.name;
      trackLabel.append(number, name);
      row.appendChild(trackLabel);

      const previewButton = new Button('試聴', () => this.previewTrack(index));
      previewButton.element.classList.add('sv-preview-button');
      this.trackButtons.push(previewButton);
      row.appendChild(previewButton.element);
      trackList.appendChild(row);
    }
    this.element.appendChild(trackList);

    const trackActions = document.createElement('div');
    trackActions.className = 'sv-track-actions';
    this.stopButton = new Button('試聴を停止', () => {
      this.bgm.stopAudition();
      this.activeTrack = null;
      this.updateTrackButtons();
      this.updateSeekControls();
    });
    trackActions.appendChild(this.stopButton.element);
    this.element.appendChild(trackActions);

    this.stopButton.setEnabled(false);
  }

  // 設定ビューが閉じるときに呼ぶ。試聴の音声経路を畳んでゲーム中BGMへ戻し、選曲・シークの
  // 表示状態を初期化へ戻す。
  public stopAudition(): void {
    this.bgm.endAudition();
    this.activeTrack = null;
    this.updateTrackButtons();
    this.updateSeekControls();
  }

  // 指定した曲を先頭から試聴し、選曲・再生位置の表示をその曲へ合わせる。
  private previewTrack(index: number): void {
    this.bgm.playAudition(index);
    this.activeTrack = index;
    this.updateTrackButtons();
    this.updateSeekControls();
  }

  // 選曲ボタンの点灯と停止ボタンの有効/無効を、試聴中の曲へ合わせて引き直す。
  private updateTrackButtons(): void {
    for (const [index, button] of this.trackButtons.entries()) {
      const active = index === this.activeTrack;
      button.setOn(active);
      button.setLabel(active ? '再生中' : '試聴');
    }
    this.stopButton.setEnabled(this.activeTrack !== null);
  }

  // シークバーの可動域を試聴中の曲へ合わせ、無ければ操作できなくする。
  private updateSeekControls(): void {
    const duration = this.activeTrack !== null ? this.bgm.auditionDurationSec(this.activeTrack) : 0;
    this.seekSlider.element.max = String(duration);
    this.seekSlider.setValue(0);
    this.seekSlider.element.disabled = duration <= 0;
    this.seekTimeLabel.textContent = formatSeekTime(0);

    // 曲替えのたびに、前の曲を追っていた周期タイマーを一旦畳む。
    if (this.seekRefreshTimer !== null) {
      clearInterval(this.seekRefreshTimer);
      this.seekRefreshTimer = null;
    }
    if (duration > 0) {
      this.seekRefreshTimer = setInterval(() => this.refreshSeekPosition(), SEEK_REFRESH_MS);
    }
  }

  // 試聴の再生位置を追う。ドラッグ中はユーザーの操作を優先し、上書きしない。
  private refreshSeekPosition(): void {
    if (this.seeking) return;
    const elapsed = this.bgm.auditionElapsedSec();
    this.seekSlider.setValue(elapsed);
    this.seekTimeLabel.textContent = formatSeekTime(elapsed);
  }
}
