// スティーブ・ライヒ風のアンビエント・ミニマルを生成する Composer。
// 長調でも短調でもない旋法的な音集合を、長さの互いに素な 2 つのパルス・パターンで反復する。
// 周期が互いに素なので 2 声のフェイズが少しずつずれていき(ライヒのフェイジング)、その上に
// 四度堆積のパッドと低いドローン、ときおりの高音の煌めきが重なる。打楽器は使わない。
// 移調とオクターブ移動という周期の異なる 2 つの循環をさらに重ねるので、全体が一巡するまでの
// 長さは各周期の最小公倍数まで伸びる。音階・パターン・各レイヤーの値は PhasingParams が持つ。
import { PhaseCycle, PhasingParams, PulseVoice } from '../tracks/types';
import { Composer, ComposerNote } from '../composer';

// 1スケールステップあたりの半音数の近似(長2度)。音階を引く声部は移調をインデックスの
// 足し引きで表せるが、Hz で直接与えるパッドとドローンは周波数比が要るのでこれで換算する。
const SEMITONES_PER_SCALE_STEP = 2;

// 一定ステップごとに切り替わる循環から、このステップの値を取り出す。
function phaseValue(cycle: PhaseCycle, step: number): number {
  return cycle.values[Math.floor(step / cycle.everySteps) % cycle.values.length]!;
}

// 音階インデックスへ移調とオクターブシフトを適用し、周波数へ解決する。
// 音階の端を越えたぶんはオクターブへ繰り上げ・繰り下げて折り返す。
function scaleFreq(scale: number[], index: number, transpose: number, octave: number): number {
  let absoluteIdx = index + transpose;
  let octShift = octave;
  // 音階の上端を超えたらオクターブを上げて折り返す
  while (absoluteIdx >= scale.length) {
    absoluteIdx -= scale.length;
    octShift++;
  }
  // 下端を下回ったらオクターブを下げて折り返す
  while (absoluteIdx < 0) {
    absoluteIdx += scale.length;
    octShift--;
  }
  return scale[absoluteIdx]! * Math.pow(2, octShift);
}

export class PhasingComposer implements Composer {
  constructor(private readonly params: PhasingParams) {}

  get stepDurSec(): number {
    return this.params.stepDur;
  }

  // このステップで鳴る声部A/B・パッド・ドローン・煌めきを、その順に並べて返す。
  notesAt(step: number): ComposerNote[] {
    const params = this.params;
    const transpose = phaseValue(params.transpose, step);
    const octave = phaseValue(params.octave, step);
    // Hz で直接与えるパッドとドローンは、音階を介さないぶんここで周波数比へ換算する。
    const freqRatio = Math.pow(2, (transpose * SEMITONES_PER_SCALE_STEP) / 12) * Math.pow(2, octave);

    const notes: ComposerNote[] = [];
    notes.push(...this.voiceNotes(params.voiceA, step, transpose, octave));
    notes.push(...this.voiceNotes(params.voiceB, step, transpose, octave));

    const pads = params.pads;
    if (step % pads.everySteps === 0) {
      const chord = pads.chords[Math.floor(step / pads.everySteps) % pads.chords.length]!;
      for (const pitch of chord) {
        notes.push({
          freq: pitch * freqRatio,
          offsetSec: 0,
          durationSec: params.stepDur * pads.lengthRatio,
          level: pads.level,
          wave: pads.wave,
          attackSec: pads.attack,
        });
      }
    }

    const drone = params.drone;
    if (step % drone.everySteps === 0) {
      for (const voice of drone.voices) {
        notes.push({
          freq: voice.pitch * freqRatio,
          offsetSec: 0,
          durationSec: params.stepDur * drone.lengthRatio,
          level: voice.level,
          wave: drone.wave,
          attackSec: drone.attack,
        });
      }
    }

    const sparkle = params.sparkle;
    if (sparkle !== null && step % sparkle.everySteps === sparkle.atStep) {
      const index = (step * sparkle.indexStride) % params.scale.length;
      const freq = scaleFreq(params.scale, index, transpose, octave + sparkle.octaveOffset);
      const base = {
        freq,
        durationSec: sparkle.durationSec,
        wave: sparkle.wave,
        attackSec: sparkle.attack,
      };
      notes.push({ ...base, offsetSec: 0, level: sparkle.level });
      for (const echo of sparkle.echoes) {
        notes.push({ ...base, offsetSec: echo.delaySec, level: echo.level });
      }
    }

    return notes;
  }

  // パルス声部1つぶんの音を、倍音を持つならそれも重ねて返す。
  private voiceNotes(voice: PulseVoice, step: number, transpose: number, octave: number): ComposerNote[] {
    const params = this.params;
    // パターンは声部ごとに長さが違うので、各々自分の長さで剰余を取って現在の音を選ぶ。
    const index = voice.pattern[step % voice.pattern.length]!;
    const freq = scaleFreq(params.scale, index, transpose, octave);
    const offsetSec = params.stepDur * voice.stepOffset;
    const notes: ComposerNote[] = [{
      freq,
      offsetSec,
      durationSec: params.stepDur * voice.lengthRatio,
      level: voice.level,
      wave: voice.wave,
      attackSec: voice.attack,
    }];
    const harmonic = voice.harmonic;
    if (harmonic !== null) {
      notes.push({
        freq: freq * harmonic.ratio,
        offsetSec,
        durationSec: params.stepDur * harmonic.lengthRatio,
        level: harmonic.level,
        wave: harmonic.wave,
        attackSec: voice.attack,
      });
    }
    return notes;
  }
}
