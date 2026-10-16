// 描画テスト環境の再生。論理フレームに応じて動きを決めて描き、操作・動きの設定・状態表示を組む。
import { Button, SegmentedControl } from '../../src/hud/widgets';
import { lengthCapOf } from '../../src/render/pipeline/screen-space/temporal-accumulation';
import { SCENE_CHANGE_WEIGHTS, type SceneChangeWeights } from '../../src/render/pipeline/scene-change';
import { buildSlider } from '../lab-controls';
import { cameraShiftOf } from './motion-sequence';
import type { JitterSource } from '../../src/render/pipeline/screen-space/frame-jitter';
import { SCENE_CHANGE_OFF, type LabView } from './lab';

// カメラの往復の片側の幅 [描画バッファの画素]。
const CAMERA_SWING_PX = 120;
// 光源の往復の片側の幅 [deg]。
const LIGHT_SWING_DEG = 30;
// カメラが画面上で動く向き(x は右、y は上)。画素の格子に沿う向きは走査の格子の決まった位相だけを踏むので、横から 30° 傾ける。
const MOTION_DIRECTION = [Math.cos(Math.PI / 6), Math.sin(Math.PI / 6)] as const;
// 1 フレームのカメラ移動量 [描画バッファの画素]。
const CAMERA_SPEEDS_PX = [0.25, 1, 4] as const;
// 1 フレームの光源移動量 [deg]。
const LIGHT_SPEEDS_DEG = [0.25, 0.5, 2] as const;
// 変化量 d のつまみの上限。
const MAX_CHANGE = 16;

type CameraMotion = 'still' | 'translate' | 'rotate' | 'orbit';
type MovingLight = 'none' | 'sun' | 'earth';
type JitterChoice = 'none' | 'seed' | 'scanRepresentative' | 'production';
type SceneChangeChoice = 'off' | 'production' | 'custom';

const JITTER_SOURCES: Readonly<Record<JitterChoice, readonly JitterSource[]>> = {
  none: [], seed: ['seed'], scanRepresentative: ['scanRepresentative'], production: ['seed', 'scanRepresentative'],
};
const JITTER_CHOICES: readonly (readonly [JitterChoice, string])[] = [
  ['none', 'なし'], ['seed', 'seed'], ['scanRepresentative', '代表'], ['production', '本番'],
];
const CAMERA_MOTIONS: readonly (readonly [CameraMotion, string])[] = [
  ['still', '静止'], ['translate', '並進'], ['rotate', '回転'], ['orbit', '周回'],
];
const CAMERA_SPEED_CHOICES: readonly (readonly [number, string])[] = CAMERA_SPEEDS_PX.map((speed) => [speed, String(speed)]);
const MOVING_LIGHTS: readonly (readonly [MovingLight, string])[] = [
  ['none', 'なし'], ['sun', '恒星'], ['earth', '地球'],
];
const LIGHT_SPEED_CHOICES: readonly (readonly [number, string])[] = LIGHT_SPEEDS_DEG.map((speed) => [speed, String(speed)]);
const SCENE_CHANGE_CHOICES: readonly (readonly [SceneChangeChoice, string])[] = [
  ['off', '切る'], ['production', '本番の重み'], ['custom', 'つまみの重み'],
];
// 重みのつまみの要素と見出し。
const SCENE_CHANGE_SLIDERS: readonly (readonly [keyof SceneChangeWeights, string])[] = [
  ['lightDirection', '重み 光の向き [1/rad]'], ['sunlit', '重み 日照率'], ['cameraSlide', '重み 画面の滑り [1/画面]'],
];
// 重みのつまみの範囲(常用対数)と刻み。
const MIN_WEIGHT_LOG = -2;
const MAX_WEIGHT_LOG = 3;
const WEIGHT_LOG_STEP = 0.05;

// 原点から正の向きへ進み、片側の幅 swing で折り返す往復位置。
function swingAt(distance: number, swing: number): number {
  const phase = ((distance % (4 * swing)) + 4 * swing) % (4 * swing);
  if (phase <= swing) return phase;
  if (phase <= 3 * swing) return 2 * swing - phase;
  return phase - 4 * swing;
}

export class LabPlayback {
  // 再生の進行状態。
  private playing = false;
  // 再生ループが動いている間の約束。
  private loopPromise: Promise<void> | null = null;
  // カメラの動き方。
  private cameraMotion: CameraMotion = 'still';
  // カメラの速さ [描画バッファの画素/フレーム]。
  private cameraSpeed: number = CAMERA_SPEEDS_PX[1];
  // 動かす光源。
  private movingLight: MovingLight = 'none';
  // 光源の速さ [deg/フレーム]。
  private lightSpeed: number = LIGHT_SPEEDS_DEG[1];
  // 時間方向の蓄積へ渡す変化量。
  private change = 0;
  // 推定への重みの選択と、つまみで編集する重み。
  private sceneChangeChoice: SceneChangeChoice = 'off';
  private sceneChangeWeights: SceneChangeWeights = { ...SCENE_CHANGE_WEIGHTS };
  // 番号に応じて動かす走査入力。
  private jitterChoice: JitterChoice = 'production';
  // 直前に番号を進めた時刻 [ms]。
  private lastFrameAtMs: number | null = null;
  // 番号を進めた間隔 [ms/フレーム]。
  private frameIntervalMs: number | null = null;
  // 再生ループで起きた例外。
  private failure: string | null = null;
  // 再生と停止を切り替えるボタン。
  private readonly playButton: Button;
  // 停止中に番号を一つ進めるボタン。
  private readonly stepButton: Button;
  // 論理番号・履歴上限・実行状態を表示する欄。
  private readonly statusOutput: HTMLOutputElement;

  // 再生操作と時間方向の設定を、それぞれの行へ組む。
  public constructor(private readonly view: LabView, transportRowId: string, settingsRowId: string) {
    const transportRow = document.getElementById(transportRowId)!;
    // 再生操作と現在の状態を並べる。
    this.playButton = new Button('再生', () => {
      if (this.playing) void this.pause();
      else this.play();
    });
    this.stepButton = new Button('1 フレーム進める', () => this.advanceFrame());
    const restartButton = new Button('最初へ', () => this.restart());
    const status = document.createElement('label');
    status.className = 'field';
    const statusName = document.createElement('span');
    statusName.textContent = '状態';
    this.statusOutput = document.createElement('output');
    status.append(statusName, this.statusOutput);
    transportRow.append(this.playButton.element, this.stepButton.element, restartButton.element, status);

    // 時間方向の選択肢を組む。
    const jitter = new SegmentedControl<JitterChoice>('ジッター', JITTER_CHOICES, (choice) => {
      jitter.setSelected(choice);
      this.jitterChoice = choice;
    });
    const camera = new SegmentedControl<CameraMotion>('カメラの動き', CAMERA_MOTIONS, (motion) => {
      camera.setSelected(motion);
      this.cameraMotion = motion;
      this.restart();
    });
    const cameraSpeed = new SegmentedControl<number>('カメラの速さ [px/フレーム]', CAMERA_SPEED_CHOICES, (speed) => {
      cameraSpeed.setSelected(speed);
      this.cameraSpeed = speed;
      this.restart();
    });
    const light = new SegmentedControl<MovingLight>('動かす光源', MOVING_LIGHTS, (source) => {
      light.setSelected(source);
      this.movingLight = source;
      this.restart();
    });
    const lightSpeed = new SegmentedControl<number>('光源の速さ [deg/フレーム]', LIGHT_SPEED_CHOICES, (speed) => {
      lightSpeed.setSelected(speed);
      this.lightSpeed = speed;
      this.restart();
    });
    document.getElementById(settingsRowId)!.append(
      jitter.element, camera.element, cameraSpeed.element, light.element, lightSpeed.element,
    );
    // 初期値を選択表示へ反映する。
    jitter.setSelected(this.jitterChoice);
    camera.setSelected(this.cameraMotion);
    cameraSpeed.setSelected(this.cameraSpeed);
    light.setSelected(this.movingLight);
    lightSpeed.setSelected(this.lightSpeed);

    // d の推定の選択と重みのつまみ(値は常用対数で持ち、つまみの重みを選んだときだけ効く)、外から渡す変化量のつまみを組む。
    const sceneChange = new SegmentedControl<SceneChangeChoice>('d の推定', SCENE_CHANGE_CHOICES, (choice) => {
      sceneChange.setSelected(choice);
      this.sceneChangeChoice = choice;
      this.applySceneChangeWeights();
      this.refreshStatus();
    });
    sceneChange.setSelected(this.sceneChangeChoice);
    for (const [key, label] of SCENE_CHANGE_SLIDERS) {
      const setWeight = buildSlider(
        settingsRowId, label, MIN_WEIGHT_LOG, MAX_WEIGHT_LOG, WEIGHT_LOG_STEP,
        () => this.sceneChangeWeights[key].toPrecision(3), (exponent) => {
          this.sceneChangeWeights = { ...this.sceneChangeWeights, [key]: 10 ** exponent };
          this.applySceneChangeWeights();
          this.refreshStatus();
        },
      );
      setWeight(Math.log10(SCENE_CHANGE_WEIGHTS[key]));
    }
    document.getElementById(settingsRowId)!.append(sceneChange.element);
    const setChange = buildSlider(
      settingsRowId, '外から渡す変化量', 0, MAX_CHANGE, 0.25,
      () => this.change.toFixed(2), (value) => {
        this.change = value;
        this.refreshStatus();
      },
    );
    setChange(this.change);
    this.syncTransport();
    this.refreshStatus();
  }

  // 再生が進行中か。
  public get isPlaying(): boolean { return this.playing; }

  // 番号を進める描画ループを始める。
  public play(): void {
    if (this.playing) return;
    this.playing = true;
    this.failure = null;
    this.lastFrameAtMs = null;
    this.syncTransport();
    this.refreshStatus();
    if (this.loopPromise === null) this.loopPromise = Promise.resolve().then(() => this.runLoop());
  }

  // 描画中のフレームが終わるまで待って再生を止める。
  public async pause(): Promise<void> {
    this.playing = false;
    this.lastFrameAtMs = null;
    this.syncTransport();
    this.refreshStatus();
    if (this.loopPromise !== null) await this.loopPromise;
  }

  // 番号 0 の動きを置き、履歴を切る。
  public restart(): void {
    this.failure = null;
    this.lastFrameAtMs = null;
    this.frameIntervalMs = null;
    this.setMotionAt(0);
    this.view.setFrame(0, Number.POSITIVE_INFINITY);
    this.refreshStatus();
  }

  // 番号・描く間隔・直前に番号を進めたときの推定の内訳と d・履歴の長さの上限を状態表示へ映す。
  public refreshStatus(): void {
    const frameText = this.playing ? `${this.frameIntervalMs?.toFixed(1) ?? '—'} ms/フレーム` : '—';
    const terms = this.view.sceneChange.lastTerms;
    const change = this.view.sceneChange.lastChange;
    const lengthCap = lengthCapOf(this.view.historyCapFrames, change).toFixed(1);
    // 内訳は、前の様子と比べなかった番号(最初・飛んだ番号・カメラの切り替え)では「—」。光の向きは度で出す。
    const breakdown = terms === null ? '光の向き — · 日照率 — · 画面の滑り —'
      : `光の向き ${(terms.lightDirection * 180 / Math.PI).toPrecision(3)}° · 日照率 ${terms.sunlit.toPrecision(3)}`
        + ` · 画面の滑り ${terms.cameraSlide.toPrecision(3)}`;
    const note = this.view.historyCapFrames === 1 ? ' · 履歴の上限 1 では履歴もジッターも使わない' : '';
    this.statusOutput.textContent = [
      `k = ${this.view.logicalFrame} · ${frameText} · ${breakdown} · d ${change.toPrecision(3)} · 履歴の長さの上限 ${lengthCap}${note}`,
      this.failure,
    ].filter((line): line is string => line !== null).join(' · ');
  }

  // 次の番号を動きとジッターへ反映し、1 フレーム描く。
  private advanceFrame(): void {
    const frame = this.view.logicalFrame + 1;
    const now = performance.now();
    this.frameIntervalMs = this.lastFrameAtMs === null ? null : now - this.lastFrameAtMs;
    this.lastFrameAtMs = now;
    // 番号に対応する動きと走査入力を置いてから描く。
    this.setMotionAt(frame);
    this.view.setJitterSources(JITTER_SOURCES[this.jitterChoice]);
    this.view.setFrame(frame, this.change);
    this.refreshStatus();
  }

  // 番号からカメラと光源の置き方を決める。
  private setMotionAt(frame: number): void {
    // カメラへ、番号に応じた往復位置を置く。
    if (this.cameraMotion === 'still') {
      this.view.setCameraShift(null);
    } else {
      const offset = swingAt(frame * this.cameraSpeed, CAMERA_SWING_PX);
      const motion: readonly [number, number] = [
        MOTION_DIRECTION[0] * offset, MOTION_DIRECTION[1] * offset,
      ];
      const still: readonly [number, number] = [0, 0];
      const shift = this.cameraMotion === 'translate'
        ? cameraShiftOf(this.view, motion, still, still)
        : this.cameraMotion === 'rotate'
          ? cameraShiftOf(this.view, still, motion, still)
          : cameraShiftOf(this.view, still, still, motion);
      this.view.setCameraShift(shift);
    }
    // 光源の方位へ番号に応じた往復位置を置く。
    if (this.movingLight === 'none') {
      this.view.setLightShift({});
    } else {
      const key = this.movingLight === 'sun' ? 'sunAzimuthDeg' : 'earthAzimuthDeg';
      this.view.setLightShift({ [key]: swingAt(frame * this.lightSpeed, LIGHT_SWING_DEG) });
    }
  }

  // 再生が続く間、描画と GPU の完了を順に待つ。
  private async runLoop(): Promise<void> {
    try {
      while (this.playing) {
        this.advanceFrame();
        // GPU が終わってから次の番号を描く。
        await this.view.waitForGpu();
        if (!this.playing) break;
        await new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); });
      }
    } catch (error) {
      // 描画で起きた例外を状態表示へ残す。
      this.failure = String(error);
      this.playing = false;
    } finally {
      this.loopPromise = null;
      this.syncTransport();
      this.refreshStatus();
    }
  }

  // 再生状態を操作ボタンへ映す。
  private syncTransport(): void {
    this.playButton.setLabel(this.playing ? '停止' : '再生');
    this.playButton.setOn(this.playing);
    this.stepButton.setEnabled(!this.playing);
  }

  // 選択中の推定モードをパイプラインへ反映する。
  private applySceneChangeWeights(): void {
    this.view.sceneChange.setWeights(this.sceneChangeChoice === 'off'
      ? SCENE_CHANGE_OFF
      : this.sceneChangeChoice === 'production' ? null : this.sceneChangeWeights);
  }
}
