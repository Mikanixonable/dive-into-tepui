// キー割り当ての唯一の定義。キーコードも表示名もここ以外には書かない。
// 同じキーでも操作の「意味」が異なれば別エントリにする。

export interface KeyBinding {
  readonly code: string; // KeyboardEvent.code。タッチ UI の仮想キーもこれを流す
  readonly altCodes?: readonly string[]; // 同じ操作を受け付ける別キー
  readonly label: string; // 画面に出すキー名
  readonly altLabel?: string; // 別キーの表示名(併記する余裕のある説明でだけ使う)
}

export const KEY_MAPPING = {
  // 並進(機体座標系)
  thrustForward: { code: 'KeyW', label: 'W' },
  thrustBackward: { code: 'KeyS', label: 'S' },
  thrustLeft: { code: 'KeyA', label: 'A' },
  thrustRight: { code: 'KeyD', label: 'D' },
  thrustUp: { code: 'KeyQ', label: 'Q' },
  thrustDown: { code: 'KeyE', label: 'E' },

  // 姿勢(RCS 手動回転)
  pitchDown: { code: 'KeyI', label: 'I' },
  pitchUp: { code: 'KeyK', label: 'K' },
  yawRight: { code: 'KeyJ', label: 'J' },
  yawLeft: { code: 'KeyL', label: 'L' },
  rollLeft: { code: 'KeyU', label: 'U' },
  rollRight: { code: 'KeyO', label: 'O' },

  // 機体のモード切替
  rcsDampToggle: { code: 'KeyP', label: 'P' },
  targetSelect: { code: 'KeyT', label: 'T' },
  progradeReset: { code: 'KeyF', label: 'F' },
  fineAttitudeToggle: { code: 'KeyV', label: 'V' },
  progradeHoldToggle: { code: 'KeyC', label: 'C' },
  throttleLow: { code: 'Digit1', label: '1' },
  throttleMid: { code: 'Digit2', label: '2' },
  throttleHigh: { code: 'Digit3', label: '3' },
  throttleMax: { code: 'Digit4', label: '4' },
  // ブースター操作
  boosterDecouple: { code: 'Digit5', label: '5' },
  boosterIgnitionToggle: { code: 'Digit6', label: '6' },
  radiatorDeployLeft: { code: 'Digit9', label: '9' },
  radiatorDeployRight: { code: 'Digit0', label: '0' },
  solarDeployLeft: { code: 'Digit7', label: '7' },
  solarDeployRight: { code: 'Digit8', label: '8' },

  // 射撃・装填
  fire: { code: 'Space', label: 'SPACE' },
  reload: { code: 'KeyR', label: 'R' },

  // 視点
  followAttitudeToggle: { code: 'KeyG', label: 'G' },
  gunsightZoom: { code: 'KeyZ', label: 'Z' },
  cameraYawLeft: { code: 'ArrowLeft', label: '←' },
  cameraYawRight: { code: 'ArrowRight', label: '→' },
  cameraPitchUp: { code: 'ArrowUp', label: '↑' },
  cameraPitchDown: { code: 'ArrowDown', label: '↓' },
  cameraRollLeft: { code: 'Numpad0', altCodes: ['Slash'], label: 'Num0', altLabel: '/' },
  cameraRollRight: { code: 'Numpad1', altCodes: ['IntlRo'], label: 'Num1', altLabel: '_' },
  cameraPanUp: { code: 'BracketLeft', label: '@' },
  cameraPanDown: { code: 'Quote', label: ':' },
  cameraPanLeft: { code: 'Semicolon', label: ';' },
  cameraPanRight: { code: 'Backslash', label: ']' },

  // 時間
  warpSlower: { code: 'Comma', label: ',' },
  warpFaster: { code: 'Period', label: '.' },
  autoWarpToNode: { code: 'KeyN', label: 'N' },

  // 軌道計画(マップモード)。Δv 編集は並進キーの流用だが、意味が違うので別エントリ。
  toggleMapMode: { code: 'KeyM', label: 'M' },
  deleteNode: { code: 'KeyX', label: 'X' },
  dvPrograde: { code: 'KeyW', label: 'W' },
  dvRetrograde: { code: 'KeyS', label: 'S' },
  dvNormal: { code: 'KeyA', label: 'A' },
  dvAntinormal: { code: 'KeyD', label: 'D' },
  dvRadialOut: { code: 'KeyE', label: 'E' },
  dvRadialIn: { code: 'KeyQ', label: 'Q' },

  // 画面
  help: { code: 'KeyH', label: 'H' },
  pauseMenu: { code: 'Escape', label: 'ESC' },
  restart: { code: 'KeyR', label: 'R' },
  togglePerfWindow: { code: 'F3', label: 'F3' },
  clipSnapshot: { code: 'F5', label: 'F5' },
  openSnapshots: { code: 'F9', label: 'F9' },
} as const satisfies Record<string, KeyBinding>;

// ブラウザ既定のスクロールを奪うキー(keydown で preventDefault する)。
export const SCROLL_GUARD_KEYS: readonly KeyBinding[] = [
  KEY_MAPPING.fire,
  KEY_MAPPING.warpSlower,
  KEY_MAPPING.warpFaster,
  KEY_MAPPING.cameraYawLeft,
  KEY_MAPPING.cameraYawRight,
  KEY_MAPPING.cameraPitchUp,
  KEY_MAPPING.cameraPitchDown,
  KEY_MAPPING.togglePerfWindow,
  KEY_MAPPING.clipSnapshot,
  KEY_MAPPING.openSnapshots,
];
