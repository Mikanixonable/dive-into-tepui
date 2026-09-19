// 生の入力を機体の操作量へ解釈する。押下中のキーを軸の押下へ、押下エッジを単発の命令へ写し、
// 並進キーの連打をラッチを反転する命令にする。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import type { KeyBinding } from '../../input/key-mapping';
import { gameCommand } from './game-commands';
import type { GameCommand } from './game-commands';
import type { ContinuousGameAction } from './game-actions';
import type { GameInputPort } from './game-input-router';
import {
  PILOT_COMMAND_KINDS, ROTATION_DIRECTIONS, THRUST_DIRECTIONS, thrustKillSwitchActive,
} from '../dynamic/dynamic-entity/pilot-controls';
import type {
  PilotCommand, PilotCommandKind, PilotControls, RotationDirection, ThrustDirection,
} from '../dynamic/dynamic-entity/pilot-controls';

// 並進方向キーをこの秒数以内に連打すると、押しっぱなし相当にラッチ/解除する [s]
const THRUST_LATCH_DOUBLE_TAP_SEC = 0.3;

// 射撃の操作 id。並進・回転は軸の名前をそのまま id にする。
const FIRE_ACTION_ID = 'fire';

const THRUST_KEYS: Readonly<Record<ThrustDirection, KeyBinding>> = {
  forward: K.thrustForward,
  backward: K.thrustBackward,
  left: K.thrustLeft,
  right: K.thrustRight,
  up: K.thrustUp,
  down: K.thrustDown,
};

const ROTATION_KEYS: Readonly<Record<RotationDirection, KeyBinding>> = {
  pitchUp: K.pitchUp,
  pitchDown: K.pitchDown,
  yawLeft: K.yawLeft,
  yawRight: K.yawRight,
  rollLeft: K.rollLeft,
  rollRight: K.rollRight,
};

const COMMAND_KEYS: Readonly<Record<PilotCommandKind, KeyBinding>> = {
  rcsDampToggle: K.rcsDampToggle,
  progradeReset: K.progradeReset,
  fineAttitudeToggle: K.fineAttitudeToggle,
  progradeHoldToggle: K.progradeHoldToggle,
  throttleLow: K.throttleLow,
  throttleMid: K.throttleMid,
  throttleHigh: K.throttleHigh,
  throttleMax: K.throttleMax,
  radiatorDeployLeft: K.radiatorDeployLeft,
  radiatorDeployRight: K.radiatorDeployRight,
  solarDeployLeft: K.solarDeployLeft,
  solarDeployRight: K.solarDeployRight,
  reload: K.reload,
};

// 押下中であるあいだ毎フレーム通知される操作。
const PILOT_ACTIONS: readonly ContinuousGameAction[] = [
  ...THRUST_DIRECTIONS.map((direction) => continuousAction(direction, THRUST_KEYS[direction])),
  ...ROTATION_DIRECTIONS.map((direction) => continuousAction(direction, ROTATION_KEYS[direction])),
  continuousAction(FIRE_ACTION_ID, K.fire),
];

// 押下エッジで1度だけ受け付ける操作。並進方向のエッジは連打の判定へ回る。
const PILOT_COMMANDS: readonly GameCommand[] = [
  ...THRUST_DIRECTIONS.map((direction) => gameCommand(direction, THRUST_KEYS[direction])),
  ...PILOT_COMMAND_KINDS.map((kind) => gameCommand(kind, COMMAND_KEYS[kind])),
];

// 押下中の通知を受ける操作を1つ組む。
function continuousAction(id: string, binding: KeyBinding): ContinuousGameAction {
  return { kind: 'continuous', id, binding };
}

export class PilotInput {
  // このフレームに押されている軸と引き金。フレームの先頭で組み直す外界の写し。
  private readonly thrust = new Set<ThrustDirection>();
  private readonly rotation = new Set<RotationDirection>();
  private firing = false;
  private readonly commands: PilotCommand[] = [];

  // 並進方向ごとの直近の押下時刻 [s]。連打の判定だけがこれを読む。
  private readonly lastPressSec: Partial<Record<ThrustDirection, number>> = {};
  private nowSec = 0;
  private shipActs = true;

  // フレームの先頭で1度だけ呼ぶ。前のフレームの操作量を捨て、連打の判定が使う実時刻
  // nowMs [ms] を確定させる。連打を数えるのは、艦が指令を受け付けられる shipActs の
  // フレームだけ(CONTROLS.md「スラスターのラッチ操作」)。
  public beginFrame(nowMs: number, shipActs: boolean): void {
    this.thrust.clear();
    this.rotation.clear();
    this.firing = false;
    this.commands.length = 0;
    this.nowSec = nowMs / 1000;
    this.shipActs = shipActs;
  }

  // 押下中のキーを軸の押下として受け取る口。
  public get actionPort(): GameInputPort {
    return {
      feature: 'controllable-action',
      actions: PILOT_ACTIONS,
      handleAction: (action) => this.holdAction(action.id),
    };
  }

  // 押下エッジを単発の命令として受け取る口。isEnabled が false のフレームはエッジを消費しない。
  public commandPort(isEnabled: () => boolean): GameInputPort {
    return {
      feature: 'controllable-command',
      isEnabled,
      commands: PILOT_COMMANDS,
      handleCommand: (command) => this.acceptCommand(command.id),
    };
  }

  // 組み上がった、このフレームの操作量。
  public get controls(): PilotControls {
    return {
      thrust: this.thrust,
      rotation: this.rotation,
      firing: this.firing,
      commands: this.commands,
    };
  }

  // 押下中の操作 id を、対応する軸か引き金の押下として立てる。
  private holdAction(id: string): void {
    const thrust = THRUST_DIRECTIONS.find((direction) => direction === id);
    if (thrust !== undefined) {
      this.thrust.add(thrust);
      return;
    }
    const rotation = ROTATION_DIRECTIONS.find((direction) => direction === id);
    if (rotation !== undefined) {
      this.rotation.add(rotation);
      return;
    }
    if (id === FIRE_ACTION_ID) this.firing = true;
  }

  // 押下エッジの操作 id を命令へ写す。並進方向は連打の判定を通す。
  private acceptCommand(id: string): void {
    const thrust = THRUST_DIRECTIONS.find((direction) => direction === id);
    if (thrust !== undefined) {
      this.noteThrustPress(thrust);
      return;
    }
    const kind = PILOT_COMMAND_KINDS.find((candidate) => candidate === id);
    if (kind !== undefined) this.commands.push({ kind });
  }

  // 並進方向の押下を連打として数え、2度目が閾値以内ならその軸のラッチを反転させる。
  // 緊急停止の最中の押下は、噴射を止めるための操作なので数え直す。
  private noteThrustPress(direction: ThrustDirection): void {
    if (!this.shipActs || thrustKillSwitchActive(this.thrust)) {
      this.forgetThrustPresses();
      return;
    }
    const last = this.lastPressSec[direction];
    this.lastPressSec[direction] = this.nowSec;
    if (last === undefined || this.nowSec - last > THRUST_LATCH_DOUBLE_TAP_SEC) return;
    this.commands.push({ kind: 'thrustLatchToggle', direction });
    delete this.lastPressSec[direction];
  }

  // 数えかけの連打を捨てる。
  private forgetThrustPresses(): void {
    for (const direction of THRUST_DIRECTIONS) delete this.lastPressSec[direction];
  }
}
