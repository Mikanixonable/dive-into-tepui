// BGM の作曲用プレビューの画面まわり。曲を選び、任意のステップから鳴らし、声部を抜き差し
// しながら tracks.ts の値を詰めるための道具。鳴らす仕組みそのものは lab-player.ts。
import { BGM_TRACKS } from '../../src/audio/bgm/tracks/tracks';
import { BgmTrack, PhaseCycle } from '../../src/audio/bgm/tracks/types';
import { LabPlayer } from './lab-player';

const STATE_KEY = 'tepui.bgmLab';

// 画面を再読込しても続きから詰められるよう、操作の状態はすべて持ち越す。
interface LabState {
  trackIdx: number;
  startStep: number;
  loopEnabled: boolean;
  loopFrom: number;
  loopTo: number;
  muted: string[];
  volume: number;
  playing: boolean;
}

const DEFAULT_STATE: LabState = {
  trackIdx: 0, startStep: 0, loopEnabled: false, loopFrom: 0, loopTo: 64,
  muted: [], volume: 0.7, playing: false,
};

function loadState(): LabState {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return { ...DEFAULT_STATE, ...JSON.parse(raw) as Partial<LabState> };
  } catch {
    /* 読めなければ既定値 */
  }
  return { ...DEFAULT_STATE };
}

function saveState(s: LabState): void {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(s));
  } catch {
    /* 保存できなくても操作自体は続く */
  }
}

// --- 曲の構造の読み出し ---------------------------------------------------

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

// この曲が本当に一巡するまでのステップ数。各循環の周期の最小公倍数。
function superCycleSteps(track: BgmTrack): number {
  if (track.kind !== 'phasing') return 0;
  const p = track.params;
  const periods = [
    p.transpose.values.length * p.transpose.everySteps,
    p.octave.values.length * p.octave.everySteps,
    p.voiceA.pattern.length,
    p.voiceB.pattern.length,
    p.pads.chords.length * p.pads.everySteps,
    p.drone.everySteps,
    ...(p.sparkle ? [p.sparkle.everySteps] : []),
  ].filter((n) => n > 0);
  return periods.reduce(lcm, 1);
}

// いまどの循環のどこにいるか。位相のずれ具合が数字で見えないと値を詰められない。
function structureReadout(track: BgmTrack, step: number): string {
  if (track.kind !== 'phasing') return '';
  const p = track.params;
  const cycle = (label: string, c: PhaseCycle): string => {
    const idx = Math.floor(step / c.everySteps) % c.values.length;
    return `${label} ${c.values[idx]} (${idx + 1}/${c.values.length}, ${step % c.everySteps}/${c.everySteps})`;
  };
  const voice = (label: string, len: number): string => `${label} ${step % len}/${len}`;
  return [
    cycle('移調', p.transpose),
    cycle('音域', p.octave),
    voice('A', p.voiceA.pattern.length),
    voice('B', p.voiceB.pattern.length),
  ].join('  ·  ');
}

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

// --- 画面 -----------------------------------------------------------------

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const trackSel = el<HTMLSelectElement>('track');
const playBtn = el<HTMLButtonElement>('play');
const stopBtn = el<HTMLButtonElement>('stop');
const startIn = el<HTMLInputElement>('start');
const loopChk = el<HTMLInputElement>('loop');
const fromIn = el<HTMLInputElement>('from');
const toIn = el<HTMLInputElement>('to');
const volIn = el<HTMLInputElement>('vol');
const mutesBox = el<HTMLDivElement>('mutes');
const readout = el<HTMLDivElement>('readout');
const hint = el<HTMLDivElement>('hint');

const state = loadState();
// AudioContext は実際の操作からしか作れないので、最初に鳴らすときまで組まない。
let audioCtx: AudioContext | null = null;
let player: LabPlayer | null = null;
let muteLabels: { id: string; label: HTMLLabelElement; box: HTMLInputElement }[] = [];

const track = (): BgmTrack => BGM_TRACKS[state.trackIdx] ?? BGM_TRACKS[0]!;

function buildTrackOptions(): void {
  trackSel.innerHTML = '';
  for (const [i, t] of BGM_TRACKS.entries()) {
    const opt = document.createElement('option');
    opt.value = String(i);
    opt.textContent = `${i + 1}. ${t.name}  [${t.kind}]`;
    trackSel.appendChild(opt);
  }
  trackSel.value = String(state.trackIdx);
}

// 声部の抜き差しは曲ごとに顔ぶれが変わるので、曲を選び直すたびに組み直す。
function buildMutes(): void {
  mutesBox.innerHTML = '';
  muteLabels = [];
  for (const [i, def] of track().instruments.entries()) {
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !state.muted.includes(def.id);
    box.addEventListener('change', () => {
      const muted = new Set(state.muted);
      if (box.checked) muted.delete(def.id); else muted.add(def.id);
      state.muted = [...muted];
      applyMutes();
      saveState(state);
    });
    label.appendChild(box);
    label.appendChild(document.createTextNode(`${i + 1} ${def.id}`));
    mutesBox.appendChild(label);
    muteLabels.push({ id: def.id, label, box });
  }
  applyMutes();
}

function applyMutes(): void {
  player?.setMuted(state.muted);
  for (const m of muteLabels) {
    m.box.checked = !state.muted.includes(m.id);
    m.label.classList.toggle('off', !m.box.checked);
  }
}

function applyLoop(): void {
  player?.setLoop(state.loopEnabled ? { from: state.loopFrom, to: state.loopTo } : null);
}

function start(): void {
  if (!audioCtx) audioCtx = new AudioContext();
  void audioCtx.resume();
  if (!player) player = new LabPlayer(audioCtx);
  applyLoop();
  applyMutes();
  player.setVolume(state.volume);
  player.play(track(), state.startStep);
  state.playing = true;
  saveState(state);
  hint.textContent = '';
}

function stop(): void {
  player?.stop();
  state.playing = false;
  saveState(state);
}

function refresh(): void {
  player?.tick();
  const t = track();
  if (!player || !player.isPlaying) {
    readout.textContent = '停止中';
    return;
  }
  const { step, notes } = player.current;
  const stepDur = t.kind === 'phasing' ? t.params.stepDur : 0;
  const cycle = superCycleSteps(t);
  const lines = [
    `step <b>${step}</b>   ${fmtTime(step * stepDur)}   このステップの音 ${notes}`,
    structureReadout(t, step),
    cycle > 0 ? `一巡 ${cycle} steps (${fmtTime(cycle * stepDur)})   step長 ${stepDur}s` : '',
  ];
  readout.innerHTML = lines.filter((l) => l !== '').join('\n');
}

trackSel.addEventListener('change', () => {
  state.trackIdx = Number(trackSel.value);
  saveState(state);
  buildMutes();
  if (player?.isPlaying) start();
});
playBtn.addEventListener('click', () => start());
stopBtn.addEventListener('click', () => stop());
startIn.addEventListener('change', () => { state.startStep = Math.max(0, Number(startIn.value) | 0); saveState(state); });
loopChk.addEventListener('change', () => { state.loopEnabled = loopChk.checked; applyLoop(); saveState(state); });
fromIn.addEventListener('change', () => { state.loopFrom = Math.max(0, Number(fromIn.value) | 0); applyLoop(); saveState(state); });
toIn.addEventListener('change', () => { state.loopTo = Math.max(0, Number(toIn.value) | 0); applyLoop(); saveState(state); });
volIn.addEventListener('input', () => { state.volume = Number(volIn.value); player?.setVolume(state.volume); saveState(state); });

window.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') { e.preventDefault(); if (player?.isPlaying) stop(); else start(); return; }
  if (e.code === 'Enter') { e.preventDefault(); start(); return; }
  if (e.code === 'Digit0') { state.muted = []; applyMutes(); saveState(state); return; }
  const n = /^Digit([1-9])$/.exec(e.code);
  if (n) {
    const target = muteLabels[Number(n[1]) - 1];
    if (target) { target.box.checked = !target.box.checked; target.box.dispatchEvent(new Event('change')); }
  }
});

buildTrackOptions();
buildMutes();
startIn.value = String(state.startStep);
loopChk.checked = state.loopEnabled;
fromIn.value = String(state.loopFrom);
toIn.value = String(state.loopTo);
volIn.value = String(state.volume);
window.setInterval(refresh, 80);

// AudioContext は実際の操作からしか作れないので、再読込直後は鳴らせない。
// 前回鳴らしていたなら、最初の操作でそのまま続きから始める。
if (state.playing) {
  hint.textContent = '再読込しました — 何かキーを押すか画面をクリックすると続きから鳴ります';
  const resume = () => {
    window.removeEventListener('keydown', resume);
    window.removeEventListener('pointerdown', resume);
    start();
  };
  window.addEventListener('keydown', resume);
  window.addEventListener('pointerdown', resume);
}
