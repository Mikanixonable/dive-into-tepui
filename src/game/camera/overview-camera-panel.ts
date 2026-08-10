import { ReferenceFrame } from '../../physics/frame';
import { Attractor } from '../../physics/attractor';
import type { Ephemeris } from '../../physics/ephemeris';
import { HudToggle, IconToggleButton } from '../hud/buttons';
import { FramePicker } from '../hud/frame-picker';
import { hudDock } from '../hud/dom';
import { BodyClassToggles } from '../celestial/body-visibility';

// クラス別トグルの1行分。orbitKey が null のクラス(衛星・ラグランジュ点)は軌道線ボタンを持たない
// ——衛星の参照軌道線はフォーカス中の系かどうかで別途決まり、ラグランジュ点はそもそも軌道を持たない。
type BodyClassRow = {
  readonly label: string;
  readonly iconKey: keyof BodyClassToggles;
  readonly labelKey: keyof BodyClassToggles;
  readonly orbitKey: keyof BodyClassToggles | null;
};

const BODY_CLASS_ROWS: readonly BodyClassRow[] = [
  { label: '衛星', iconKey: 'satelliteIcon', labelKey: 'satelliteLabel', orbitKey: null },
  { label: '準惑星', iconKey: 'dwarfIcon', labelKey: 'dwarfLabel', orbitKey: 'dwarfOrbit' },
  { label: '小天体', iconKey: 'smallBodyIcon', labelKey: 'smallBodyLabel', orbitKey: 'smallBodyOrbit' },
  { label: 'ラグランジュ点', iconKey: 'lagrangeIcon', labelKey: 'lagrangeLabel', orbitKey: null },
];

export class OverviewCameraPanel {
  onFrameSelect: ((frame: ReferenceFrame) => void) | null = null;
  onAmmoToggle: ((show: boolean) => void) | null = null;
  onBodyClassToggle: ((key: keyof BodyClassToggles, on: boolean) => void) | null = null;

  showAmmo = false;
  private readonly ammoToggle: HudToggle;
  private readonly bodyClassButtons: readonly (readonly [keyof BodyClassToggles, IconToggleButton])[];

  private readonly panel: HTMLElement;
  private readonly frame: FramePicker;
  // 直近に選択肢を組んだ重力天体 id の集合(登録天体は変わらないので、生存中の重力を持つ
  // GameEntity の増減だけを見ればよい)。変化した回だけボタン列を組み直す。
  private lastDynamicIds = '';

  constructor(root: HTMLElement, private readonly ephemeris: Ephemeris) {
    // パネル本体とタイトル
    this.panel = document.createElement('div');
    this.panel.id = 'hud-overview-camera';
    this.panel.className = 'panel';
    this.panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const title = document.createElement('h3');
    title.textContent = 'MAP VIEW';
    this.panel.appendChild(title);

    // 視点座標系の選択コントロール
    this.frame = new FramePicker(root, '視点', ephemeris);
    this.frame.onSelect = (frame) => this.onFrameSelect?.(frame);
    this.frame.setFrames(ephemeris.frames, []);
    this.panel.appendChild(this.frame.element);

    this.ammoToggle = new HudToggle('弾薬', (on) => {
      this.showAmmo = on;
      this.onAmmoToggle?.(on);
    });
    this.ammoToggle.setOn(false);
    this.panel.appendChild(this.ammoToggle.element);

    // マップに出す天体のクラスごとに、アイコン(点)・ラベル(名前)・軌道線を個別に切り替える。
    // 恒星・惑星と、フォーカス中の系の親子は常に出るので、ここで足すのは「その外まで見たい」
    // という明示の意思表示にあたる。
    const buttons: (readonly [keyof BodyClassToggles, IconToggleButton])[] = [];
    for (const row of BODY_CLASS_ROWS) {
      const rowEl = document.createElement('div');
      rowEl.className = 'body-class-row';
      const titleEl = document.createElement('span');
      titleEl.className = 'body-class-title';
      titleEl.textContent = row.label;
      rowEl.appendChild(titleEl);

      const btnsEl = document.createElement('div');
      btnsEl.className = 'body-class-btns';
      rowEl.appendChild(btnsEl);

      const icon = new IconToggleButton('●', 'アイコン', (on) => this.onBodyClassToggle?.(row.iconKey, on));
      icon.setOn(false);
      btnsEl.appendChild(icon.element);
      buttons.push([row.iconKey, icon]);

      const label = new IconToggleButton('Aa', 'ラベル', (on) => this.onBodyClassToggle?.(row.labelKey, on));
      label.setOn(false);
      btnsEl.appendChild(label.element);
      buttons.push([row.labelKey, label]);

      if (row.orbitKey !== null) {
        const orbitKey = row.orbitKey;
        const orbit = new IconToggleButton('⌒', '軌道線', (on) => this.onBodyClassToggle?.(orbitKey, on));
        orbit.setOn(false);
        btnsEl.appendChild(orbit.element);
        buttons.push([orbitKey, orbit]);
      }

      this.panel.appendChild(rowEl);
    }
    this.bodyClassButtons = buttons;

    hudDock(root, 'left').appendChild(this.panel);
  }

  // パネルの表示/非表示を切り替える。
  setVisible(visible: boolean): void {
    this.panel.style.display = visible ? 'block' : 'none';
  }

  // クラス別トグルの表示状態を現在値へ合わせる。
  setBodyClassToggles(toggles: BodyClassToggles): void {
    for (const [key, btn] of this.bodyClassButtons) btn.setOn(toggles[key]);
  }

  // 視点座標系の選択表示を更新する。
  setFrame(frame: ReferenceFrame): void {
    this.frame.setSelected(frame);
  }

  // 生存中の重力天体の増減を反映して選択肢を組み直す(登録天体は変わらないので変化しない回は
  // 何もしない)。呼び出し側は setFrame で選択表示を別途更新する。
  refreshFrameItems(attractors: readonly Attractor[]): void {
    const dynamicIds = attractors.filter((a) => !(a.id in this.ephemeris.registry)).map((a) => a.id).join(',');
    if (dynamicIds === this.lastDynamicIds) return;
    this.lastDynamicIds = dynamicIds;
    const dynamicFrames = attractors.filter((a) => !(a.id in this.ephemeris.registry))
      .map((a) => this.ephemeris.frameFor(a.id));
    this.frame.setFrames([...this.ephemeris.frames, ...dynamicFrames], attractors);
  }
}
