// 描画の品質設定の選び方(src/render/graphics-selection.ts)の回帰テスト。全体のプリセットが各分野で
// 選ぶものの解け方、平らな値一式と同じ絵になる選び方の当て方、層ごとの選択を移す操作の写し・捨て・オフから中、
// 値を 1 つ書き換える操作、保存文字列との往復と壊れた保存値の扱いを、SPEC/RENDERING.md「描画品質設定」の
// 規則どおりかで見る。プリセットの値そのものは調整値なので固定しない。
import * as assert from 'node:assert/strict';
import { test } from '../harness';
import {
  DEFAULT_GRAPHICS, DEFAULT_GRAPHICS_SELECTION, formatGraphicsSelection, parseGraphicsSelection, resolveGraphics,
  selectField, selectOverall, selectionOfGraphics, withGraphicsValue, type CustomGraphics, type GraphicsSelection,
} from '../../src/render/graphics-selection';
import {
  GRAPHICS_FIELDS, OVERALL_FIELD_PRESETS, elementPresetValues, fieldKnobKeys, fieldPresetValues, graphicsElementKeys,
  graphicsFieldKeys, type ChoiceValue, type GraphicsFieldKey, type GraphicsKey, type GraphicsSettingsData,
  type QualityPreset,
} from '../../src/render/graphics-settings';

const PRESETS: readonly QualityPreset[] = ['low', 'medium', 'high'];

// 分野 field のプリセット preset のノブの値を、キーで引ける形で返す。
function presetValues(field: GraphicsFieldKey, preset: QualityPreset): Readonly<Record<string, boolean | ChoiceValue>> {
  return fieldPresetValues(field, preset);
}

function selectionOf(quality: QualityPreset): GraphicsSelection {
  return { ...DEFAULT_GRAPHICS_SELECTION, quality };
}

// 全体がカスタムであることを確かめて返す。
function customOf(selection: GraphicsSelection): CustomGraphics {
  assert.ok(typeof selection.quality !== 'string', '全体がカスタムでない');
  return selection.quality;
}

export function register(): void {
  test('graphics-selection: 全体のプリセットは、各分野を表どおりのプリセットの値に解く', () => {
    for (const preset of PRESETS) {
      const graphics = resolveGraphics(selectionOf(preset));
      for (const field of graphicsFieldKeys()) {
        const choice = OVERALL_FIELD_PRESETS[preset][field];
        const enabled = GRAPHICS_FIELDS[field].enabled;
        if (enabled !== null) assert.equal(graphics[enabled], choice !== 'off', `${preset} の ${field} の有無`);
        if (choice === 'off') continue;
        const expected = presetValues(field, choice);
        for (const key of fieldKnobKeys(field)) assert.equal(graphics[key], expected[key], `${preset} の ${key}`);
      }
      const elements = elementPresetValues(preset);
      for (const key of graphicsElementKeys()) assert.equal(graphics[key], elements[key], `${preset} の ${key}`);
    }
  });

  test('graphics-selection: オフの分野は有無が偽で、ノブは中の値に解ける', () => {
    const graphics = resolveGraphics(selectionOf('low'));
    assert.equal(graphics.clouds, false);
    const medium = presetValues('cloud', 'medium');
    for (const key of fieldKnobKeys('cloud')) assert.equal(graphics[key], medium[key], key);
  });

  test('graphics-selection: 保存が無いときは全体「高」で、好みは保存が無いときの値', () => {
    assert.equal(DEFAULT_GRAPHICS_SELECTION.quality, 'high');
    assert.deepEqual(DEFAULT_GRAPHICS, resolveGraphics(selectionOf('high')));
  });

  test('graphics-selection: 全体のプリセットを解いた値には、その全体のプリセットが当たる', () => {
    for (const preset of PRESETS) {
      assert.equal(selectionOfGraphics(resolveGraphics(selectionOf(preset))).quality, preset);
    }
  });

  test('graphics-selection: 全体のプリセットと 1 項目違う値には、その分野だけカスタムの全体カスタムが当たる', () => {
    const data: GraphicsSettingsData = { ...resolveGraphics(selectionOf('high')), lodBias: 0.5 };
    const custom = customOf(selectionOfGraphics(data));
    assert.deepEqual(custom.fields.screen, { custom: { ...fieldPresetValues('screen', 'high'), lodBias: 0.5 } });
    for (const field of graphicsFieldKeys()) {
      if (field !== 'screen') assert.equal(custom.fields[field], 'high', field);
    }
    assert.deepEqual(custom.elements, elementPresetValues('high'));
  });

  test('graphics-selection: 有無が偽の分野にはオフが当たり、そのノブの値は捨てる', () => {
    const data: GraphicsSettingsData = {
      ...resolveGraphics(selectionOf('high')), clouds: false, cumulusMarchSteps: 12,
    };
    const selection = selectionOfGraphics(data);
    assert.equal(customOf(selection).fields.cloud, 'off');
    // 解き直すと、オフの分野のノブを除いて元の値に戻る。
    const resolved = resolveGraphics(selection);
    const cloudKnobs: readonly string[] = fieldKnobKeys('cloud');
    for (const key of Object.keys(data) as GraphicsKey[]) {
      if (cloudKnobs.includes(key)) continue;
      assert.equal(resolved[key], data[key], key);
    }
  });

  test('graphics-selection: 平らな値一式の好みは、全体のプリセットを外さずに好みへ当たる', () => {
    const data: GraphicsSettingsData = { ...resolveGraphics(selectionOf('medium')), exposureCompensation: 2 };
    const selection = selectionOfGraphics(data);
    assert.equal(selection.quality, 'medium');
    assert.equal(selection.preferences.exposureCompensation, 2);
  });

  test('graphics-selection: 全体をカスタムへ移すと、直前のプリセットが選んでいたものから始まる', () => {
    const custom = customOf(selectOverall(selectionOf('medium'), 'custom'));
    assert.deepEqual(custom.fields, OVERALL_FIELD_PRESETS.medium);
    assert.deepEqual(custom.elements, elementPresetValues('medium'));
    assert.deepEqual(resolveGraphics({ ...DEFAULT_GRAPHICS_SELECTION, quality: custom }),
      resolveGraphics(selectionOf('medium')), 'カスタムへ移った直後に絵が変わった');
  });

  test('graphics-selection: 既にカスタムなら、カスタムを選び直しても変わらない', () => {
    const selection = selectOverall(selectionOf('medium'), 'custom');
    assert.equal(selectOverall(selection, 'custom'), selection);
  });

  test('graphics-selection: 全体を低 / 中 / 高へ移すと分野の選択を捨て、好みは変えない', () => {
    const adjusted = withGraphicsValue(
      withGraphicsValue(selectionOf('high'), 'exposureCompensation', 2), 'lodBias', 0.5);
    assert.ok(typeof adjusted.quality !== 'string');
    const moved = selectOverall(adjusted, 'low');
    assert.equal(moved.quality, 'low');
    assert.equal(moved.preferences.exposureCompensation, 2);
  });

  test('graphics-selection: 分野をカスタムへ移すと直前のプリセットの値を写し、全体もカスタムになる', () => {
    const selection = selectField(selectionOf('high'), 'screen', 'custom');
    const custom = customOf(selection);
    assert.deepEqual(custom.fields.screen, { custom: fieldPresetValues('screen', 'high') });
    assert.equal(custom.fields.light, 'high', '触っていない分野が変わった');
  });

  test('graphics-selection: 分野をオフからカスタムへ移すと、中の値から始まる', () => {
    const selection = selectField(selectionOf('low'), 'cloud', 'custom');
    assert.deepEqual(customOf(selection).fields.cloud, { custom: fieldPresetValues('cloud', 'medium') });
  });

  test('graphics-selection: 分野をプリセットへ移すと調整を捨て、既にカスタムならカスタムを選び直しても変わらない', () => {
    const adjusted = withGraphicsValue(selectionOf('high'), 'lodBias', 0.5);
    assert.equal(selectField(adjusted, 'screen', 'custom'), adjusted);
    assert.equal(customOf(selectField(adjusted, 'screen', 'high')).fields.screen, 'high');
  });

  test('graphics-selection: 消せない分野へのオフは無視する', () => {
    const selection = selectionOf('high');
    assert.equal(selectField(selection, 'screen', 'off'), selection);
  });

  test('graphics-selection: 分野のノブを書き換えると、その分野だけがカスタムになる', () => {
    const selection = withGraphicsValue(selectionOf('medium'), 'shadowSlotSize', 2048);
    const custom = customOf(selection);
    assert.deepEqual(custom.fields.shadow, { custom: { ...fieldPresetValues('shadow', 'medium'), shadowSlotSize: 2048 } });
    assert.equal(custom.fields.cloud, 'medium');
    assert.equal(resolveGraphics(selection).shadowSlotSize, 2048);
  });

  test('graphics-selection: 分野の有無の偽はオフへ、真はオフのときだけ中のカスタムへ移す', () => {
    const off = withGraphicsValue(selectionOf('high'), 'clouds', false);
    assert.equal(customOf(off).fields.cloud, 'off');
    assert.equal(resolveGraphics(off).clouds, false);
    const on = withGraphicsValue(off, 'clouds', true);
    assert.deepEqual(customOf(on).fields.cloud, { custom: fieldPresetValues('cloud', 'medium') });
    assert.equal(withGraphicsValue(on, 'clouds', true), on, 'オンの分野をオンにして変わった');
    const preset = selectionOf('high');
    assert.equal(withGraphicsValue(preset, 'clouds', true), preset, 'プリセットでオンの分野をオンにして変わった');
  });

  test('graphics-selection: 表示する要素を書き換えると全体がカスタムになり、好みはプリセットのまま書ける', () => {
    const element = withGraphicsValue(selectionOf('high'), 'lens', false);
    assert.equal(customOf(element).elements.lens, false);
    const preference = withGraphicsValue(selectionOf('high'), 'exposureCompensation', 0.5);
    assert.equal(preference.quality, 'high', '好みを変えて全体のプリセットが外れた');
    assert.equal(preference.preferences.exposureCompensation, 0.5);
  });

  test('graphics-selection: 候補外・範囲外・刻みに乗らない値は捨てて選び方を変えない', () => {
    const selection = selectionOf('high');
    assert.equal(withGraphicsValue(selection, 'lodBias', 3), selection);
    assert.equal(withGraphicsValue(selection, 'cumulusMarchSteps', 17), selection);
    assert.equal(withGraphicsValue(selection, 'cumulusMarchSteps', 2.5), selection);
    assert.equal(withGraphicsValue(selection, 'atmosphereSampleBudget', 7), selection);
    assert.equal(withGraphicsValue(selection, 'clouds', 1), selection);
    assert.equal(withGraphicsValue(selection, 'filmLut', 'no-such-look'), selection);
  });

  test('graphics-selection: 保存文字列を往復しても選び方が変わらない', () => {
    const selections = [
      selectionOf('low'),
      withGraphicsValue(selectionOf('medium'), 'exposureCompensation', 4),
      withGraphicsValue(withGraphicsValue(selectionOf('high'), 'cumulusRefineSteps', 7), 'rings', false),
      withGraphicsValue(selectionOf('low'), 'screenSpaceOcclusion', true),
    ];
    for (const selection of selections) {
      assert.deepEqual(parseGraphicsSelection(formatGraphicsSelection(selection)), selection);
    }
  });

  test('graphics-selection: 壊れた文字列と null は保存が無いときの選び方', () => {
    assert.deepEqual(parseGraphicsSelection(null), DEFAULT_GRAPHICS_SELECTION);
    assert.deepEqual(parseGraphicsSelection('{"quality":'), DEFAULT_GRAPHICS_SELECTION);
    assert.deepEqual(parseGraphicsSelection('"high"'), DEFAULT_GRAPHICS_SELECTION);
  });

  test('graphics-selection: 知らないキーは読まず、欠けた分野と候補外・範囲外の値は全体「高」が選ぶもので埋める', () => {
    const parsed = parseGraphicsSelection(JSON.stringify({
      quality: {
        fields: {
          screen: 'off',
          cloud: { custom: { cumulusMarchSteps: 3, cumulusRefineSteps: 99, unknownKnob: 1 } },
          atmosphere: 'off',
          unknownField: 'low',
        },
        elements: { lens: false, rings: 'yes' },
      },
      preferences: { exposureCompensation: 3 },
      unknown: true,
    }));
    const custom = customOf(parsed);
    assert.equal(custom.fields.screen, 'high', '消せない分野のオフが残った');
    assert.equal(custom.fields.atmosphere, 'off');
    assert.equal(custom.fields.light, 'high', '欠けた分野が高で埋まらない');
    assert.deepEqual(custom.fields.cloud, {
      custom: { ...fieldPresetValues('cloud', 'high'), cumulusMarchSteps: 3 },
    });
    assert.ok(!('unknownField' in custom.fields));
    assert.deepEqual(custom.elements, { ...elementPresetValues('high'), lens: false });
    assert.deepEqual(parsed.preferences, DEFAULT_GRAPHICS_SELECTION.preferences);
  });
}
