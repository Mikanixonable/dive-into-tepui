// 起動時のステージ選択画面。タイトルの3D場面と並べてステージ一覧を出し、選ばれたステージを返す。
import { STAGE_CLASSES } from '../game/stages/stage-dictionary';
import { StageDebug } from '../game/stages/stage-debug';
import { TabBar } from '../hud/widgets';
import { KEY_MAPPING as K } from '../input/key-mapping';
import tepuiRmqrUrl from '../assets/tepui-rmqr.svg';
import { injectStageSelectStyle } from './stage-select-style';
import { StartEpochForm } from './start-epoch-form';
import { TITLE_SCENE_PATTERNS, TitleScene } from './title-scene';
import type { StageClass } from '../game/stages/stage';
import type { TdbJulianDate } from '../physics/time';
import type { ThemePalette } from '../theme';
import type { UnlockManager } from './unlock-manager';

// タイトルの添え書き1組。primary は大きく出す引用または英訳、original は原文、
// transliteration は楔形文字などに添える小さな転写、note は出典または作中の記録ラベル。
// scriptKind は言語分類ではなく、原文を描くための書体プロファイルだけを表す。
interface TitleFlavor {
  readonly primary: string;
  readonly original?: string;
  readonly transliteration?: string;
  readonly lang?: string;
  readonly scriptKind?: 'cantonese' | 'cuneiform' | 'polynesian';
  readonly note: string;
}

// 起動ごとに1組を選ぶ。実在文献・詩・格言は出典を note に残し、広東語だけは公暦20115年の
// シスルナ口語という作中テキストとして創作する。シュメール語は原文の楔形文字と転写を併記する。
const TITLE_FLAVORS: readonly TitleFlavor[] = [
  // Sumerian literature: CDLI/ORACC composites. Unicode signs are cuneified from the cited lines.
  {
    primary: 'From the great heaven she set her mind on the great below.',
    original: '𒀭𒃲𒋫 𒆠𒃲𒂠 𒄑𒌆𒉿𒂵𒉌 𒈾𒀭𒁺',
    transliteration: 'an gal-ta ki gal-še₃ ĝeštug₂-ga-ni na-an-gub',
    lang: 'sux',
    scriptKind: 'cuneiform',
    note: 'INANA’S DESCENT · Old Babylonian · CDLI Q000343:1',
  },
  {
    primary: 'When heaven had been separated from earth.',
    original: '𒀭𒆠𒋫 𒁀𒁕𒁁𒁺𒀀𒁀',
    transliteration: 'an ki-ta ba-da-ba₉-ra₂-a-ba',
    lang: 'sux',
    scriptKind: 'cuneiform',
    note: 'GILGAMEŠ, ENKIDU AND THE NETHERWORLD · CDLI Q000364:8',
  },
  {
    primary: 'In those days, in those far remote days.',
    original: '𒌓𒊑𒀀 𒌓𒋤𒁺𒊑𒀀',
    transliteration: 'u₄ re-a u₄ su₃-ra₂ re-a',
    lang: 'sux',
    scriptKind: 'cuneiform',
    note: 'INSTRUCTIONS OF ŠURUPPAK · Old Babylonian · CDLI Q000782:1',
  },

  // Spoken Cantonese: deliberately colloquial future dialogue, not Standard Written Chinese.
  {
    primary: 'Just going home. Why is it so hard?',
    original: '返屋企啫，點解咁難？',
    lang: 'yue-Hant-HK',
    scriptKind: 'cantonese',
    note: 'CISLUNAR COMMON SPEECH · 公曆20115年',
  },
  {
    primary: 'Earth is below. The way back is sealed.',
    original: '地球喺下面，返去嘅路畀佢哋封咗。',
    lang: 'yue-Hant-HK',
    scriptKind: 'cantonese',
    note: 'CISLUNAR COMMON SPEECH · 公曆20115年',
  },
  {
    primary: 'Those ahead are not stars.',
    original: '前面嗰啲唔係星。',
    lang: 'yue-Hant-HK',
    scriptKind: 'cantonese',
    note: 'CISLUNAR COMMON SPEECH · 公曆20115年',
  },
  {
    primary: 'Ten thousand years. This time, we go back.',
    original: '等咗成萬年，今次真係要返去喇。',
    lang: 'yue-Hant-HK',
    scriptKind: 'cantonese',
    note: 'CISLUNAR COMMON SPEECH · 公曆20115年',
  },
  {
    primary: 'Going down is easy. Coming back is the test.',
    original: '落去唔難，返得嚟先算。',
    lang: 'yue-Hant-HK',
    scriptKind: 'cantonese',
    note: 'CISLUNAR COMMON SPEECH · 公曆20115年',
  },
  {
    primary: 'That blue one is home.',
    original: '嗰粒藍色嘅，先至係我哋屋企。',
    lang: 'yue-Hant-HK',
    scriptKind: 'cantonese',
    note: 'CISLUNAR COMMON SPEECH · 公曆20115年',
  },

  // English poetry: quoted verbatim in short fragments whose imagery can be reread as orbital travel and return.
  {
    primary: 'Is this mine own countree?',
    note: 'S. T. COLERIDGE · THE RIME OF THE ANCIENT MARINER · 1798',
  },
  {
    primary: 'To sail beyond the sunset',
    note: 'ALFRED TENNYSON · ULYSSES · 1842',
  },
  {
    primary: 'The world’s great age begins anew',
    note: 'P. B. SHELLEY · HELLAS · 1822',
  },
  {
    primary: 'Then felt I like some watcher of the skies',
    note: 'JOHN KEATS · ON FIRST LOOKING INTO CHAPMAN’S HOMER · 1816',
  },
  {
    primary: 'Our birth is but a sleep and a forgetting',
    note: 'WILLIAM WORDSWORTH · INTIMATIONS OF IMMORTALITY · 1807',
  },
  {
    primary: 'To mingle with the Universe, and feel',
    note: 'LORD BYRON · CHILDE HAROLD’S PILGRIMAGE IV · 1818',
  },

  // Polynesian sayings: traditional or attested texts retained in their original language.
  {
    primary: 'Homeless Matariki.',
    original: 'Matariki kāinga kore',
    lang: 'mi',
    scriptKind: 'polynesian',
    note: 'MĀORI WHAKATAUKĪ · TE PAPA',
  },
  {
    primary: 'People disappear; the land remains.',
    original: 'Whatungarongaro te tangata, toitū te whenua.',
    lang: 'mi',
    scriptKind: 'polynesian',
    note: 'MĀORI WHAKATAUKĪ · AOTEAROA',
  },
  {
    primary: 'The stars are the spies of heaven.',
    original: 'ʻO nā hōkū nō nā kiu o ka lani.',
    lang: 'haw',
    scriptKind: 'polynesian',
    note: 'HAWAIIAN ʻŌLELO NOʻEAU · PUKUI #2513',
  },
  {
    primary: 'The ocean is the place of the unknown.',
    original: 'Moana ko e potu ʻo e taʻeʻiloa.',
    lang: 'to',
    scriptKind: 'polynesian',
    note: 'TONGAN PROVERB · ORTHOGRAPHY NORMALIZED',
  },
];

// 選ばれたステージ。開始日時を選ぶステージなら、入力された元期も持つ。
interface StageSelection {
  readonly stageClass: StageClass;
  readonly startEpoch?: TdbJulianDate;
}

// 一様な32bit符号なし整数の乱数。crypto が使えない環境では Math.random から作る。
function randomUint32(): number {
  if (typeof globalThis.crypto !== 'undefined' && typeof globalThis.crypto.getRandomValues === 'function') {
    const bytes = new Uint32Array(1);
    globalThis.crypto.getRandomValues(bytes);
    return bytes[0] ?? 0;
  }
  return Math.floor(Math.random() * 0x100000000) >>> 0;
}

// items から一様に1つ選ぶ。
function pickRandom<T>(items: readonly T[]): T {
  return items[randomUint32() % items.length]!;
}

// 画面の骨組み。左に3D場面とタイトルを重ねた窓、右に背景の rMQR コードだけを置いたステージ選択の窓。
// タイトルの添え書きは TITLE_FLAVORS から1組を選んで入れる。
function createScreenElement(): HTMLElement {
  const root = document.createElement('div');
  root.id = 'stage-select';
  root.innerHTML =
    '<div class="ss-shell"><div class="ss-layout">' +
    '<section class="ss-3d-window" aria-labelledby="ss-title">' +
    '<div class="ss-scene" aria-hidden="true">' +
    '<canvas class="ss-canvas"></canvas>' +
    '<div class="ss-vignette"></div>' +
    '</div>' +
    '<div class="ss-hero">' +
    '<p class="ss-eyebrow">Sortie select · 公暦20115年</p>' +
    '<h1 id="ss-title" class="ss-logotype" aria-label="Dive into Tepui">' +
    '<span class="ss-logo-line">Dive<sup class="ss-logo-ornament">∴03</sup></span>' +
    '<span class="ss-logo-line">into<sub class="ss-logo-ornament">ECI₀</sub></span>' +
    '<span class="ss-logo-line">Tepui<sup class="ss-logo-ornament">Ω⁺</sup></span>' +
    '</h1>' +
    '<div class="ss-subrow"><div>' +
    '<p class="ss-sub" data-flavor-primary></p>' +
    '<div class="ss-languages">' +
    '<div class="ss-script-block" data-flavor-script-block>' +
    '<p class="ss-script" data-flavor-script></p>' +
    '<p class="ss-transliteration" data-flavor-transliteration hidden></p>' +
    '</div>' +
    '<p class="ss-flavor-note" data-flavor-note></p>' +
    '</div>' +
    '</div><div class="ss-status ui-surface-quiet"><b>∗ Link stable</b><br>h = 420.2 km · i = 51.6°<br>Epoch 06:14:28.03</div></div>' +
    '</div>' +
    '</section>' +
    '<section class="ss-window ui-surface-focus" aria-label="Stage and creative modes"></section>' +
    '</div></div>';

  // タイトルの添え書き。
  const flavor = pickRandom(TITLE_FLAVORS);
  const flavorScriptBlock = root.querySelector<HTMLElement>('[data-flavor-script-block]')!;
  const flavorScript = root.querySelector<HTMLElement>('[data-flavor-script]')!;
  const flavorTransliteration = root.querySelector<HTMLElement>('[data-flavor-transliteration]')!;
  root.querySelector<HTMLElement>('[data-flavor-primary]')!.textContent = flavor.primary;
  if (flavor.original === undefined) {
    flavorScriptBlock.hidden = true;
  } else {
    flavorScript.textContent = flavor.original;
    if (flavor.lang !== undefined) flavorScript.lang = flavor.lang;
    if (flavor.scriptKind !== undefined) flavorScript.classList.add(`ss-script-${flavor.scriptKind}`);
  }
  if (flavor.transliteration !== undefined) {
    flavorTransliteration.textContent = flavor.transliteration;
    flavorTransliteration.lang = 'sux-Latn';
    flavorTransliteration.hidden = false;
  }
  root.querySelector<HTMLElement>('[data-flavor-note]')!.textContent = flavor.note;

  // ステージ選択の窓の背景に透かす rMQR コード。
  const stageQr = document.createElement('img');
  stageQr.className = 'ss-stage-qr';
  stageQr.src = tepuiRmqrUrl;
  stageQr.alt = '';
  stageQr.setAttribute('aria-hidden', 'true');
  root.querySelector('.ss-window')!.appendChild(stageQr);
  return root;
}

// ステージ選択画面1回ぶん。構築と同時に画面へ出し、ステージが選ばれたら画面と3D場面を片付けて
// onSelect を呼ぶ。
class StageSelectScreen {
  private readonly root = createScreenElement();
  private readonly stageList = document.createElement('div');
  private readonly tabBar: TabBar<string>;
  private readonly debugLink = document.createElement('div');
  private readonly settingsButton = document.createElement('button');
  private readonly startEpochForm: StartEpochForm;
  // 解放済みのステージ。画面を開いた時点の解放状況で決まる。
  private readonly unlockedStages: ReadonlySet<StageClass>;
  // 3D 場面は非同期に立ち上がる。選択が先に済んだ場合は、でき次第そのまま破棄する。
  private titleScene: TitleScene | null = null;
  private closed = false;

  // onEscape は ESC キーで、onClose は選択が済んで画面を畳むときに、onSettings は設定ボタンで呼ばれる。
  // palette は3D場面の材質と光の色。
  public constructor(
    unlockManager: UnlockManager,
    palette: ThemePalette,
    private readonly onEscape: (() => void) | undefined,
    private readonly onClose: (() => void) | undefined,
    onSettings: (() => void) | undefined,
    private readonly onSelect: (selection: StageSelection) => void,
  ) {
    injectStageSelectStyle();
    this.unlockedStages = new Set(STAGE_CLASSES.filter((stageClass) => unlockManager.isUnlocked(stageClass.id)));
    const stageWindow = this.root.querySelector<HTMLElement>('.ss-window')!;

    // タブは selectGroup の初出順に並べ、選んだタブのステージを一覧へ出す。
    const groups: string[] = [];
    for (const stageClass of STAGE_CLASSES) {
      if (stageClass.hiddenFromSelect || groups.includes(stageClass.selectGroup)) continue;
      groups.push(stageClass.selectGroup);
    }
    this.tabBar = new TabBar<string>(groups.map((group) => [group, group] as const), (group) => this.showGroup(group));
    this.tabBar.element.classList.add('ui-surface-inset');
    this.stageList.className = 'ss-list';
    stageWindow.append(this.tabBar.element, this.stageList);
    if (groups[0]) this.showGroup(groups[0]);

    // 隅の控えめなリンクからデバッグステージへ移動できる。
    this.debugLink.className = 'ss-debug';
    this.debugLink.textContent = 'debug stage';
    this.debugLink.addEventListener('click', () => this.select(StageDebug));
    this.settingsButton.type = 'button';
    this.settingsButton.className = 'ss-settings';
    this.settingsButton.textContent = '⚙ 設定';
    this.settingsButton.addEventListener('click', () => onSettings?.());
    this.startEpochForm = new StartEpochForm(
      (stageClass, startEpoch) => this.select(stageClass, startEpoch),
      () => this.setStageListVisible(true),
    );
    stageWindow.append(this.debugLink, this.settingsButton, this.startEpochForm.element);

    // 画面を出し、3D 場面の立ち上げとショートカットキーの監視を始める。
    document.body.appendChild(this.root);
    document.body.classList.add('title-screen-open');
    TitleScene.create(
      this.root.querySelector<HTMLCanvasElement>('.ss-canvas')!,
      this.root.querySelector<HTMLElement>('.ss-3d-window')!,
      pickRandom(TITLE_SCENE_PATTERNS),
      randomUint32(),
      palette,
    )
      .then((scene) => {
        if (this.closed) scene.dispose();
        else this.titleScene = scene;
      })
      .catch(() => {});
    window.addEventListener('keydown', this.onKey);
  }

  // group のタブを選択状態にし、そのグループのステージ行を一覧へ並べ直す。
  private showGroup(group: string): void {
    this.tabBar.setSelected(group);
    this.stageList.replaceChildren(...STAGE_CLASSES
      .filter((stageClass) => !stageClass.hiddenFromSelect && stageClass.selectGroup === group)
      .map((stageClass) => this.createStageRow(stageClass)));
  }

  // stageClass の一覧の行。解放済みなら、押すとそのステージを選ぶ(開始日時を選ぶステージなら入力欄を開く)。
  private createStageRow(stageClass: StageClass): HTMLElement {
    // 見出し・ショートカットキー・説明。説明は未解放なら解放条件に差し替わる。
    const unlocked = this.unlockedStages.has(stageClass);
    const sub = unlocked ? stageClass.selectSub : stageClass.selectLockedSub ?? stageClass.selectSub;
    const key = stageClass.selectKey === null ? '' : `[${stageClass.selectKey.replace('Digit', '').replace('Key', '')}]`;
    const row = document.createElement('div');
    row.className = `ss-stage ui-selectable${unlocked ? '' : ' locked'}`;
    row.innerHTML =
      `<div class="ss-stage-label"><span>${stageClass.selectLabel}</span><span class="ss-stage-key">${key}</span></div>` +
      `<div class="ss-stage-sub">${sub}</div>`;
    // 押したときの選択。
    if (unlocked) {
      row.addEventListener('click', () => {
        if (stageClass.picksStartEpoch) this.openStartEpochForm(stageClass);
        else this.select(stageClass);
      });
    }
    return row;
  }

  // 一覧に代えて、stageClass の開始日時の入力欄を出す。
  private openStartEpochForm(stageClass: StageClass): void {
    this.startEpochForm.open(stageClass);
    this.setStageListVisible(false);
  }

  // 一覧・タブ・デバッグリンク・設定ボタンの表示を切り替える。ss-window は overflow:hidden の固定高さ
  // なので、開始日時の入力欄を出す間はこれらを隠さないと、入力欄が窓の下端からはみ出して見えなくなる。
  private setStageListVisible(visible: boolean): void {
    for (const element of [this.stageList, this.tabBar.element, this.debugLink, this.settingsButton]) {
      element.classList.toggle('hidden', !visible);
    }
  }

  // 解放済みステージのショートカットキーにマッチしたら選択確定する。タブに関係なく効く。
  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.code === K.pauseMenu.code) {
      e.preventDefault();
      this.onEscape?.();
      return;
    }
    // 手前にシステム窓か開始日時の入力欄が開いている間は、ステージのショートカットを止める。
    if (document.body.classList.contains('hud-overlay-modal-open') || this.startEpochForm.isOpen) return;
    const stageClass = STAGE_CLASSES.find((candidate) =>
      this.unlockedStages.has(candidate) && candidate.selectKey === e.code);
    if (stageClass !== undefined) this.select(stageClass);
  };

  // 選択を確定する。キーの監視・3D 場面・画面を片付けてから onSelect を呼ぶ。
  private select(stageClass: StageClass, startEpoch?: TdbJulianDate): void {
    window.removeEventListener('keydown', this.onKey);
    this.onClose?.();
    this.closed = true;
    this.titleScene?.dispose();
    this.root.remove();
    document.body.classList.remove('title-screen-open');
    this.onSelect({ stageClass, startEpoch });
  }
}

// 起動選択画面(各ステージの selectGroup ごとのタブ)を表示し、選ばれたステージクラス(クリエイティブ
// なら指定した開始日時の元期も併せて)で解決される Promise を返す。
export function selectStage(
  unlockManager: UnlockManager,
  palette: ThemePalette,
  onEscape?: () => void,
  onClose?: () => void,
  onSettings?: () => void,
): Promise<StageSelection> {
  return new Promise((resolve) => {
    new StageSelectScreen(unlockManager, palette, onEscape, onClose, onSettings, resolve);
  });
}
