// 被選択物の並べ場所の分類。軌道物体一覧の区画と、選択ウィジェットのジャンルの語彙。
import type { DynamicEntityKind } from '../dynamic/dynamic-entity/entity-kind';

// 軌道物体一覧の区画。天体はクラスをまたいで1区画にまとめ、人工物は種別ごとに分ける。
export type MapListSection = 'body' | DynamicEntityKind;

// 選択ウィジェットのジャンルの並び。見出しの文字列がそのまま鍵になる。
export const OBJECT_PICKER_GENRES = [
  '恒星', '惑星', '準惑星', '衛星', '小天体', 'ラグランジュ点', '自艦', '敵', '基地', '弾薬', 'RCS燃料',
] as const;

export type ObjectPickerGenre = typeof OBJECT_PICKER_GENRES[number];
