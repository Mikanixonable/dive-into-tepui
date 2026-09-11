import type { Bgm } from '../../audio/bgm/bgm';
import { BGM_TRACKS } from '../../audio/bgm/tracks/tracks';
import { Button, Slider } from '../widgets';

const SEEK_REFRESH_MS = 100; // 試聴の再生位置をシークバーへ写す間隔

// シークバー横の経過時間表示を「分:秒」の書式にする。
function formatSeekTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// BGM の設定面。ゲーム中BGMの音量調整と、曲の試聴(選曲・再生位置のシーク・停止)を扱う。
// 音量の操作は onVolumeChange で外へ返す。
export class BgmSettingsPanel {
  public readonly element: HTMLElement;

  // 音量スライダーが動いたときに呼ばれる。
  public onVolumeChange: ((volume: number) => void) | null = null;

  private activeTrack: number | null = null;
  private readonly stopButton: Button;
  private readonly trackButtons: Button[] = [];
  private readonly volumeSlider: Slider;
  private readonly volumeValue: HTMLSpanElement;
  private readonly seekSlider: Slider;
  private readonly seekTimeLabel: HTMLSpanElement;
  private seeking = false;
  private seekRefreshTimer: ReturnType<typeof setInterval> | null = null;

  // 音量・再生位置・曲一覧・停止ボタンの4ブロックを縦に並べる。bgm は試聴の音声経路、
  // volume は組み立て時のユーザー音量。
  public constructor(private readonly bgm: Bgm, volume: number) {
    this.element = document.createElement('div');

    // 音量: ゲーム中BGMそのものの音量。試聴の音量もこれに従う。
    const volumeRow = document.createElement('div');
    volumeRow.className = 'sv-volume-row';
    const volumeLabel = document.createElement('span');
    volumeLabel.className = 'sv-label';
    volumeLabel.textContent = '音量';
    volumeRow.appendChild(volumeLabel);
    this.volumeValue = document.createElement('span');
    this.volumeValue.className = 'sv-volume-value';
    this.volumeSlider = new Slider({ min: 0, max: 1, step: 0.05 }, (value) => {
      this.showVolume(value);
      this.onVolumeChange?.(value);
    });
    this.syncVolume(volume);
    volumeRow.appendChild(this.volumeSlider.element);
    volumeRow.appendChild(this.volumeValue);
    this.element.appendChild(volumeRow);

    // 再生位置: 試聴中の曲だけ操作できる。要素の外で離しても取りこぼさないよう pointer capture で追う。
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
    // ドラッグを終え、再生位置の自動追従へ戻す。
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

    // 停止: 試聴を止め、選曲・再生位置の表示を未選択へ戻す。
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

  // 外から音量が変わったときに、スライダーと百分率表示を引き直す。
  public syncVolume(volume: number): void {
    this.volumeSlider.setValue(volume);
    // つまみの位置と百分率を揃えるため、刻みへ丸めた後の値を出す。
    this.showVolume(this.volumeSlider.getValue());
  }

  // 音量の百分率表示を書き換える。
  private showVolume(volume: number): void {
    this.volumeValue.textContent = `${Math.round(volume * 100)}%`;
  }

  // 試聴の期間を終える。試聴を畳んでゲーム中BGMを戻し、選曲・シークの表示を未選択へ戻す。
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
