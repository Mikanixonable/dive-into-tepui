// 警報1件の文言: 項目の略号、何が起きたか(強調する値を含む)、取るべき行動(キーと短い語の連鎖)。
// キーの表記は KEY_MAPPING から取る。
import { KEY_MAPPING as K } from '../../input/key-mapping';
import { MAX_HULL_TEMP } from '../dynamic/dynamic-entity/combat-ship-entity';
import { MAX_DYN_PRESSURE } from '../player/aero-load';
import type { ActiveAlarm, AlarmItem } from '../alarm/alarm-evaluator';

// 文言の1区間。strong は値などの強調。
export interface AlarmMessagePart {
  readonly text: string;
  readonly strong: boolean;
}

// 行動の1段階。keys が空なら語だけ。
export interface AlarmActionStep {
  readonly keys: readonly string[];
  readonly text: string;
}

export interface AlarmContent {
  readonly code: string;
  readonly message: readonly AlarmMessagePart[];
  readonly actions: readonly AlarmActionStep[];
}

// 補給(RCS 燃料・弾薬)のマーカーの記号。
const FUEL_RESUPPLY_GLYPH = '◈';
const AMMO_RESUPPLY_GLYPH = '▣';

function plain(text: string): AlarmMessagePart { return { text, strong: false }; }
function strong(text: string): AlarmMessagePart { return { text, strong: true }; }

function percent(ratio: number): string { return `${Math.round(ratio * 100)}%`; }

// 動圧 [Pa] を kPa で。
function kilopascal(pressurePa: number): string { return (pressurePa / 1000).toFixed(1); }

const THOUSANDS = new Intl.NumberFormat('en-US');

function temperatureContent(alarm: ActiveAlarm): AlarmContent {
  const value = `${THOUSANDS.format(Math.round(alarm.value))} K`;
  const radiators: AlarmActionStep = { keys: [K.radiatorDeployLeft.label, K.radiatorDeployRight.label], text: '放熱板を展開' };
  if (alarm.level === 'warning') {
    return {
      code: 'TEMP', message: [plain('船体温度 '), strong(value), plain(' — 熱防御が飽和に近い')],
      actions: [radiators, { keys: [], text: '射撃を止める' }],
    };
  }
  return {
    code: 'TEMP',
    message: [
      plain('船体温度 '), strong(value),
      plain(` — 上限 ${THOUSANDS.format(MAX_HULL_TEMP)} K の ${percent(alarm.value / MAX_HULL_TEMP)}`),
    ],
    actions: [radiators, { keys: [K.fire.label], text: '射撃を控える' }],
  };
}

function dynamicPressureContent(alarm: ActiveAlarm): AlarmContent {
  const value = `${kilopascal(alarm.value)} kPa`;
  const limit = `${kilopascal(MAX_DYN_PRESSURE)} kPa`;
  if (alarm.level === 'warning') {
    return {
      code: 'Q', message: [plain('動圧 '), strong(value), plain(` — ${limit} で機体が壊れる`)],
      actions: [{ keys: [K.thrustForward.label], text: '前進して引き起こす' }],
    };
  }
  return {
    code: 'Q',
    message: [plain('動圧 '), strong(value), plain(` — 上限 ${limit} の ${percent(alarm.value / MAX_DYN_PRESSURE)}`)],
    actions: [
      { keys: [K.progradeHoldToggle.label], text: 'ホールド' },
      { keys: [K.thrustForward.label], text: '前進で上昇' },
    ],
  };
}

function altitudeContent(alarm: ActiveAlarm): AlarmContent {
  const value = `${(alarm.value / 1000).toFixed(alarm.value < 1e5 ? 1 : 0)} km`;
  if (alarm.level === 'warning') {
    return {
      code: 'ALT', message: [plain('高度 '), strong(value), plain(' — 80 km 以下は大気圏突入')],
      actions: [{ keys: [K.thrustForward.label], text: '前進して引き起こす' }],
    };
  }
  const descent = alarm.secondaryValue ?? 0;
  const reason = descent < 0 ? `降下中 ${Math.round(descent)} m/s` : '120 km を下回った';
  return {
    code: 'ALT', message: [plain('高度 '), strong(value), plain(` — ${reason}`)],
    actions: [
      { keys: [K.progradeHoldToggle.label], text: '進行方向ホールド' },
      { keys: [K.thrustForward.label], text: '前進' },
    ],
  };
}

function fuelContent(alarm: ActiveAlarm): AlarmContent {
  const value = percent(alarm.value);
  if (alarm.level === 'warning') {
    return {
      code: 'FUEL', message: [plain('RCS 燃料 '), strong(value), plain(' — 姿勢制御が失われる')],
      actions: [{ keys: [K.rcsDampToggle.label], text: '回転制動を切る' }],
    };
  }
  return {
    code: 'FUEL', message: [plain('RCS 燃料 '), strong(value), plain(' — 帰投に要る量を下回る')],
    actions: [{ keys: [FUEL_RESUPPLY_GLYPH], text: '補給を回収' }],
  };
}

function ammoContent(alarm: ActiveAlarm): AlarmContent {
  if (alarm.level === 'warning') {
    return {
      code: 'AMMO', message: [strong('弾薬切れ'), plain(' — 射撃できない')],
      actions: [{ keys: [AMMO_RESUPPLY_GLYPH], text: '補給へ接近' }],
    };
  }
  return {
    code: 'AMMO', message: [plain('予備弾倉 '), strong(`${alarm.value} 連`), plain(' — 補給の位置を確認')],
    actions: [{ keys: [AMMO_RESUPPLY_GLYPH], text: '補給を回収' }],
  };
}

// 警報の項目の呼び名。
const ITEM_NAMES: Readonly<Record<AlarmItem, string>> = {
  fuel: 'RCS 燃料', temperature: '船体温度', dynamicPressure: '動圧', altitude: '高度', ammo: '弾薬',
};

// 警告から戻った項目 items の、解除の通知の本文。
export function alarmClearedText(items: readonly AlarmItem[]): string {
  return `${items.map((item) => ITEM_NAMES[item]).join('・')}の警報を解除`;
}

// alarm の文言と行動。
export function alarmContent(alarm: ActiveAlarm): AlarmContent {
  switch (alarm.item) {
    case 'temperature': return temperatureContent(alarm);
    case 'dynamicPressure': return dynamicPressureContent(alarm);
    case 'altitude': return altitudeContent(alarm);
    case 'fuel': return fuelContent(alarm);
    case 'ammo': return ammoContent(alarm);
  }
}
