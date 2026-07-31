// GameEntity.current.history(過去)と .predicted.history(未来、あれば)を1本の折れ線として
// 描くデバッグ表示(better_predict.md Step 5)。「どのエンティティに、どう線を描くか」の表示仕様は
// まだ決まっていないため、エンティティ自身に線を持たせず(Enemy.orbitLine のような所有にすると
// 「全個体が常に自分の線を持つ」という仕様上の決定を先に固定してしまう)、描画側のこのモジュールが
// 「線を描く対象の集合」を毎フレーム引数で受け取る形にしてある。対象の変更・撤去はどちらも軽微。
//
// ?debugLines=1 のときだけ有効(PerfMeter の ?perf=1 と同じ、URL パラメータで自己完結する
// デバッグ表示のパターン)。無効時は SampledLine を1本も作らない。
import * as THREE from 'three/webgpu';
import { Frame } from '../physics/frame';
import type { Ephemeris } from '../physics/ephemeris';
import { FloatingOrigin } from './floating-origin';
import { SampledLine } from '../render/sampled-line';
import { GameEntity } from './game-entity/game-entity';

const LINE_COLOR = 0x40e0ff;

export class DebugHistoryLine {
  readonly enabled: boolean;
  private readonly lines = new Map<GameEntity, SampledLine>();

  // ?debugLines=1 の指定を読み取り enabled を確定する。
  constructor(private readonly scene: THREE.Scene) {
    this.enabled = new URLSearchParams(location.search).get('debugLines') === '1';
  }

  // targets: このフレームに線を描きたい対象の集合(呼び出し側が決める。既定は自機+ターゲット)。
  // frame は plan/plan-display.ts の PlanDisplay.trajectoryFrame と同じ値を渡す(bake の座標系)。
  sync(targets: readonly GameEntity[], frame: Frame, simTime: number, ephemeris: Ephemeris, fo: FloatingOrigin): void {
    if (!this.enabled) return;

    const alive = new Set(targets);
    for (const entity of targets) {
      let line = this.lines.get(entity);
      if (!line) {
        line = new SampledLine(LINE_COLOR, 0.6, 1);
        this.scene.add(line.line);
        this.lines.set(entity, line);
      }
      // 過去列 → 現在状態 → 未来列(あれば)の順に連結する。sampleInterval を current/predicted で
      // 共有しているため、現在時刻の点で密度が揃って連続する。
      const samples = [...entity.current.samplesOldestFirst(), ...(entity.predicted?.samplesOldestFirst() ?? [])];
      line.syncGeometry(samples, frame, ephemeris);
      line.syncTransform(frame, simTime, ephemeris, fo);
      line.setVisible(true);
    }
    // 対象から外れたエンティティの線は破棄する(dispose 忘れによる GPU リソースリークを防ぐ)。
    for (const [entity, line] of this.lines) {
      if (alive.has(entity)) continue;
      this.scene.remove(line.line);
      line.dispose();
      this.lines.delete(entity);
    }
  }
}
