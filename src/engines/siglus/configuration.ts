import type {ByteSource} from '../../core/source.js';
import {
  parseDialogTemplate,
  type DialogItemTemplate,
  type DialogTemplate,
} from '../../formats/pe/dialog-template.js';
import {parsePeResources} from '../../formats/pe/resources.js';
import {
  browserDesktopSize,
  type ViewportFullscreenLayout,
  type ViewportPresentation,
} from '../../platform/browser-window-display.js';
import {
  dialogFontBaseUnits,
  SYSTEM_DIALOG_BASE_UNITS,
} from '../../platform/windows-dialog-units.js';

const movieDialogResource = 124;
const screenDialogResource = 127;
const autoModeDialogResource = 115;
const sdWrapImageOffset = 0x1c000;
const moviePlayers = new Map<number, SiglusMoviePlayer>([
  [1164, 'mci'],
  [1165, 'wmp'],
]);
export type SiglusMoviePlayer = 'mci' | 'wmp';
type AutoModeSettings = {autoCharacterWait: number; autoMinimumWait: number};
export interface SiglusScreenSettings extends ViewportPresentation {
  fullscreen: boolean;
  syncScale: boolean;
}

const windowSizes = [0.5, 0.75, 1, 1.5, 2];
const layouts = new Map<number, ViewportFullscreenLayout>([
  [1158, 'native'],
  [1156, 'stretch'],
  [1160, 'fit'],
  [1159, 'height'],
  [1157, 'width'],
  [1155, 'custom'],
]);
const sliders = new Map([
  [1182, {key: 'scaleY', display: 1019, min: 50, max: 300, label: '上下倍率'}],
  [1181, {key: 'scaleX', display: 1018, min: 50, max: 300, label: '左右倍率'}],
  [1180, {key: 'offsetY', display: 1017, min: -100, max: 100, label: '上下移動'}],
  [1179, {key: 'offsetX', display: 1016, min: -100, max: 100, label: '左右移動'}],
] as const);
const hidePlaceholders = new Set([1219, 1217, 1215, 1213]);
export interface SiglusFontSettings {
  name: string;
  bold: boolean;
  shadow: number;
  showProportional: boolean;
}

export interface SiglusFontChoice {
  name: string;
  family: string;
  proportional: boolean;
}

const shadowLabels = ['影なし', '影あり', '縁取る', '縁＋影'];
const shadowStyles = [
  'none',
  '1px 1px 3px #000',
  '-1px 0 #000, 1px 0 #000, 0 -1px #000, 0 1px #000',
  '-1px 0 #000, 1px 0 #000, 0 -1px #000, 0 1px #000, 1px 2px 3px #000',
];

export function siglusFontShadow(shadow: number): string {
  return shadowStyles[shadow] ?? shadowStyles[0]!;
}

export class SiglusConfiguration {
  private templates?: Promise<Map<number, DialogTemplate>>;

  constructor(
    private readonly owner: HTMLElement,
    private readonly engine: ByteSource | undefined,
    private readonly signal: AbortSignal,
  ) {}

  private async readTemplates(): Promise<Map<number, DialogTemplate>> {
    if (!this.engine) throw new Error('SiglusEngine.exe is needed for these configuration dialogs');
    const outer = await this.engine.read(0, this.engine.size);
    const embedded = outer.subarray(sdWrapImageOffset);
    const images = [outer];
    if (embedded[0] === 0x4d && embedded[1] === 0x5a) images.push(embedded);
    const result = new Map<number, DialogTemplate>();
    for (const image of images)
      for (const {id, language, bytes} of parsePeResources(image, [5]))
        if (language === 1041 && (id === movieDialogResource || id === screenDialogResource || id === autoModeDialogResource))
          result.set(id, parseDialogTemplate(bytes, 0));
    return result;
  }

  private async template(id: number): Promise<DialogTemplate> {
    const template = (await (this.templates ??= this.readTemplates())).get(id);
    if (!template) throw new Error(`Missing Siglus settings dialog resource ${id}`);
    this.signal.throwIfAborted();
    return template;
  }

  async moviePlayer(current: SiglusMoviePlayer): Promise<SiglusMoviePlayer> {
    const template = await this.template(movieDialogResource);
    const document = this.owner.ownerDocument;
    const {dialog, form, place} = this.templateDialog('movie', template);
    for (const item of template.items) {
      if (typeof item.title !== 'string') continue;
      let element: HTMLElement;
      const method = moviePlayers.get(item.id);
      if (method) {
        const label = document.createElement('label');
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'method';
        radio.value = method;
        radio.checked = method === current;
        radio.style.cssText = 'margin:0 3px 0 0;vertical-align:middle';
        label.append(radio, item.title);
        element = label;
      } else if (item.id === 1026) {
        const button = document.createElement('button');
        button.type = 'submit';
        button.textContent = item.title;
        element = button;
      } else {
        element = document.createElement('div');
        element.textContent = item.title;
        element.style.whiteSpace = 'pre';
      }
      place(item, element);
    }
    await this.show(dialog);
    const selected = new FormData(form).get('method');
    return selected === 'mci' || selected === 'wmp' ? selected : current;
  }

  async autoMode(
    current: AutoModeSettings,
    defaults: AutoModeSettings,
    limits: AutoModeSettings,
    apply: (settings: AutoModeSettings) => void,
  ): Promise<void> {
    const template = await this.template(autoModeDialogResource);
    const {dialog, place} = this.templateDialog('auto-mode', template);
    const document = this.owner.ownerDocument;
    const settings = {...current};
    const fields = new Map<number, keyof AutoModeSettings>([
      [1177, 'autoCharacterWait'],
      [1176, 'autoMinimumWait'],
    ]);
    const refresh: (() => void)[] = [];
    const update = () => {
      for (const render of refresh) render();
      apply({...settings});
    };
    for (const item of template.items) {
      const {id, title} = item;
      const field = fields.get(id);
      if (field) {
        const slider = document.createElement('input');
        slider.type = 'range';
        slider.min = '0';
        slider.max = String(limits[field]);
        slider.setAttribute('aria-label', field === 'autoCharacterWait' ? '文字時間' : '最小時間');
        slider.addEventListener('input', () => {
          settings[field] = slider.valueAsNumber;
          update();
        });
        refresh.push(() => { slider.value = String(settings[field]); });
        place(item, slider);
      } else if (id === 1002 || id === 1003) {
        const button = document.createElement('button');
        button.type = id === 1002 ? 'submit' : 'button';
        button.textContent = typeof title === 'string' ? title : '';
        if (id === 1003) button.addEventListener('click', () => {
          Object.assign(settings, defaults);
          update();
        });
        place(item, button);
      } else if (id >= 1205 && id <= 1207) {
        const readout = document.createElement('output');
        refresh.push(() => {
          const time = id === 1205 ? settings.autoMinimumWait : id === 1206 ? settings.autoCharacterWait :
            settings.autoMinimumWait + settings.autoCharacterWait * 10;
          readout.value = `${(time / 1000).toFixed(3)} 秒`;
        });
        place(item, readout);
      } else if (typeof title === 'string') {
        const group = item.className === 128 && (item.style & 15) === 7;
        const label = document.createElement(group ? 'fieldset' : 'div');
        if (group) {
          label.style.cssText = 'margin:0;padding:0;min-width:0;pointer-events:none';
          const legend = document.createElement('legend');
          legend.textContent = title;
          label.append(legend);
        } else label.textContent = title;
        place(item, label);
      }
    }
    for (const render of refresh) render();
    await this.show(dialog);
  }

  async screen(
    current: SiglusScreenSettings,
    defaults: SiglusScreenSettings,
    apply: (settings: SiglusScreenSettings) => void,
  ): Promise<void> {
    const template = await this.template(screenDialogResource);
    const document = this.owner.ownerDocument;
    const {dialog, place} = this.templateDialog('screen', template);
    const settings = {...current};
    const refresh: (() => void)[] = [];
    const update = () => {
      for (const render of refresh) render();
      apply({...settings});
    };
    const choice = (
      title: string,
      group: string,
      checked: () => boolean,
      change: (value: boolean) => void,
      disabled?: () => boolean,
    ) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = group === 'sync' ? 'checkbox' : 'radio';
      input.name = group;
      input.style.cssText = 'margin:0 2px 0 0;vertical-align:middle';
      label.append(input, title);
      refresh.push(() => {
        input.checked = checked();
        input.disabled = disabled?.() ?? false;
      });
      input.addEventListener('change', () => {
        change(input.checked);
        update();
      });
      return label;
    };
    const view = document.defaultView!;
    const [width, height] = browserDesktopSize(view);
    for (const item of template.items) {
      const {id} = item;
      if (hidePlaceholders.has(id)) continue;
      const title = typeof item.title === 'string' ? item.title : '';
      const layout = layouts.get(id);
      const slider = sliders.get(id as 1182 | 1181 | 1180 | 1179);
      let element: HTMLElement;
      if (id === 1166 || id === 1167) {
        const active = id === 1166;
        element = choice(
          title,
          'mode',
          () => settings.fullscreen === active,
          () => {
            settings.fullscreen = active;
          },
        );
      } else if (id >= 1170 && id <= 1174) {
        const value = windowSizes[id - 1170]!;
        element = choice(
          title,
          'size',
          () => settings.windowScale === value,
          () => {
            settings.windowScale = value;
          },
          () => settings.fullscreen,
        );
      } else if (layout) {
        element = choice(
          title,
          'layout',
          () => settings.fullscreenLayout === layout,
          () => {
            settings.fullscreenLayout = layout;
          },
          () => !settings.fullscreen,
        );
      } else if (id === 1047) {
        element = choice(
          title,
          'sync',
          () => settings.syncScale,
          (checked) => {
            settings.syncScale = checked;
            if (checked) settings.scaleY = settings.scaleX;
          },
          () => !settings.fullscreen || settings.fullscreenLayout !== 'custom',
        );
      } else if (slider) {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(slider.min);
        input.max = String(slider.max);
        input.style.margin = '0';
        input.setAttribute('aria-label', slider.label);
        refresh.push(() => {
          input.value = String(Math.round(settings[slider.key] * 100));
          input.disabled = !settings.fullscreen || settings.fullscreenLayout !== 'custom';
        });
        input.addEventListener('input', () => {
          settings[slider.key] = input.valueAsNumber / 100;
          if (settings.syncScale && (slider.key === 'scaleX' || slider.key === 'scaleY'))
            settings.scaleX = settings.scaleY = settings[slider.key];
          update();
        });
        element = input;
      } else if (id === 1036 || id === 1020 || id === 1021 || id === 1022) {
        const button = document.createElement('button');
        button.type = id === 1036 ? 'submit' : 'button';
        button.textContent = title;
        button.disabled = id === 1022;
        if (id === 1020)
          button.addEventListener('click', () => {
            Object.assign(settings, defaults);
            update();
          });
        if (id === 1021)
          button.addEventListener('click', () => {
            const info = this.dialog('resolution', title);
            const explanation = document.createElement('p');
            explanation.textContent = 'ブラウザーではディスプレイの解像度を変更できません。';
            const close = document.createElement('button');
            close.textContent = '閉じる';
            info.form.style.padding = '12px';
            info.form.append(explanation, close);
            void this.show(info.dialog).catch(() => {});
          });
        element = button;
      } else if (id === 1238) {
        const label = document.createElement('label');
        const control = document.createElement('input');
        control.type = 'checkbox';
        control.disabled = true;
        label.append(control, title);
        element = label;
      } else if (id === 1240 || id === 1239) {
        const select = document.createElement('select');
        select.add(new Option(id === 1240 ? '現在のディスプレイ' : `${width} × ${height}`));
        select.disabled = true;
        element = select;
      } else {
        const frame = item.className === 128 && (item.style & 15) === 7;
        const field = [...sliders.values()].find(({display}) => display === id);
        element = document.createElement(frame ? 'fieldset' : 'div');
        if (frame) {
          element.style.cssText =
            'padding:0;margin:0;min-width:0;border:1px solid #aaa;pointer-events:none';
          const caption = document.createElement('legend');
          caption.textContent = title;
          element.append(caption);
        } else if (field) {
          refresh.push(() => {
            element.textContent = Math.round(settings[field.key] * 100) + '%';
          });
        } else {
          element.textContent = title;
        }
      }
      place(item, element, id === 1240 || id === 1239 ? 14 : item.cy);
    }
    for (const render of refresh) render();
    await this.show(dialog);
  }

  font(
    current: SiglusFontSettings,
    defaults: SiglusFontSettings,
    choices: readonly SiglusFontChoice[],
    apply: (settings: SiglusFontSettings) => void,
  ): Promise<void> {
    const document = this.owner.ownerDocument;
    const {dialog, form} = this.dialog('font', 'フォントの設定');
    form.style.cssText =
      'box-sizing:border-box;width:456px;max-width:90vw;padding:12px;display:grid;gap:8px';
    const settings = {...current};
    const chooser = document.createElement('select');
    chooser.size = 8;
    chooser.setAttribute('aria-label', 'フォント');
    chooser.style.cssText = 'width:216px;max-width:100%';
    const fonts = document.createElement('fieldset');
    const legend = document.createElement('legend');
    legend.textContent = 'フォント';
    const checkbox = (name: string, caption: string) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = name;
      label.append(input, caption);
      return {label, input};
    };
    const proportional = checkbox('proportional', 'プロポーショナルフォントを表示する');
    const bold = checkbox('bold', '文字を太くする');
    const note = document.createElement('div');
    note.textContent =
      '※プロポーショナルフォントを使うと、文章のレイアウトが崩れる可能性があります。';
    fonts.append(legend, chooser, proportional.label, note);
    const effects = document.createElement('div');
    effects.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap';
    const radios = shadowLabels.map((caption, mode) => {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio';
      input.name = 'shadow';
      input.value = String(mode);
      input.addEventListener('change', () => {
        settings.shadow = mode;
        update();
      });
      label.append(input, caption);
      effects.append(label);
      return input;
    });
    const sample = document.createElement('div');
    sample.textContent = '「あいう漢字カナＡＢＣ０１２薔薇」';
    sample.style.cssText = 'padding:6px;background:#888;color:white;font-size:20px';
    const buttons = document.createElement('div');
    buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:6px';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '初期状態に戻す';
    const close = document.createElement('button');
    close.type = 'submit';
    close.textContent = '閉じる';
    buttons.append(reset, close);
    form.append(fonts, bold.label, effects, sample, buttons);

    const renderSelection = () => {
      chooser.replaceChildren();
      for (const choice of choices) {
        if (choice.proportional && !settings.showProportional && choice.name !== settings.name)
          continue;
        chooser.add(new Option(choice.name, choice.name));
      }
      chooser.value = settings.name;
      bold.input.checked = settings.bold;
      proportional.input.checked = settings.showProportional;
      radios[settings.shadow]!.checked = true;
    };
    const renderSample = () => {
      sample.style.fontFamily =
        choices.find(({name}) => name === settings.name)?.family ?? 'sans-serif';
      sample.style.fontWeight = settings.bold ? 'bold' : 'normal';
      sample.style.textShadow = siglusFontShadow(settings.shadow);
    };
    const update = () => {
      renderSample();
      apply({...settings});
    };
    chooser.addEventListener('change', () => {
      if (!chooser.value) return;
      settings.name = chooser.value;
      update();
    });
    proportional.input.addEventListener('change', () => {
      settings.showProportional = proportional.input.checked;
      renderSelection();
      update();
    });
    bold.input.addEventListener('change', () => {
      settings.bold = bold.input.checked;
      update();
    });
    reset.addEventListener('click', () => {
      Object.assign(settings, defaults);
      renderSelection();
      update();
    });
    renderSelection();
    renderSample();
    return this.show(dialog);
  }

  private dialog(kind: string, caption: string) {
    const document = this.owner.ownerDocument;
    const dialog = document.createElement('dialog');
    dialog.dataset.siglusConfiguration = kind;
    dialog.setAttribute('aria-label', caption);
    dialog.style.cssText =
      'padding:0;border:1px solid #666;background:#f0f0f0;color:#000;font:11px sans-serif';
    const title = document.createElement('div');
    title.textContent = caption;
    title.style.cssText = 'padding:4px 6px;background:#fff;border-bottom:1px solid #ccc';
    const form = document.createElement('form');
    form.method = 'dialog';
    dialog.append(title, form);
    return {dialog, form};
  }

  async shareCapture(
    png: Uint8Array,
    text?: string,
    saveFile?: File,
    caption?: string,
  ): Promise<boolean> {
    const sharing = text !== undefined;
    const {dialog, form} = this.dialog(
      sharing ? 'share-capture' : 'save-capture',
      caption || (sharing ? 'キャプチャを共有' : 'キャプチャを保存'),
    );
    const document = dialog.ownerDocument;
    const preview = new File([new Uint8Array(png)], 'siglus-capture.png', {type: 'image/png'});
    const file = saveFile ?? preview;
    const url = URL.createObjectURL(file);
    const previewUrl = file === preview ? url : URL.createObjectURL(preview);
    let exported = false;
    form.style.cssText = 'padding:12px;display:grid;gap:8px;width:min(480px,80vw)';
    const image = document.createElement('img');
    image.src = previewUrl;
    image.alt = 'キャプチャ画像';
    image.style.cssText = 'display:block;max-width:100%;max-height:55vh;object-fit:contain';
    const save = document.createElement('a');
    save.href = url;
    save.download = file.name;
    save.textContent = '画像を保存';
    save.addEventListener('click', () => {
      exported = true;
      if (!sharing) document.defaultView?.requestAnimationFrame(() => {
        if (dialog.open) dialog.close();
      });
    });
    const close = document.createElement('button');
    close.textContent = '閉じる';
    form.append(image, save);
    const navigator = document.defaultView?.navigator;
    if (sharing && navigator?.share && navigator.canShare?.({files: [file]})) {
      const message = document.createElement('textarea');
      message.value = text;
      message.setAttribute('aria-label', '共有するテキスト');
      const share = document.createElement('button');
      share.type = 'button';
      share.textContent = '共有';
      const status = document.createElement('div');
      status.setAttribute('role', 'status');
      share.addEventListener('click', () => {
        void navigator.share({files: [file], text: message.value}).then(
          () => { exported = true; if (dialog.open) dialog.close(); },
          (error: unknown) => {
            if (!(error instanceof DOMException && error.name === 'AbortError'))
              status.textContent = '共有できませんでした。画像を保存できます。';
          },
        );
      });
      form.append(message, share, status);
    }
    form.append(close);
    try {
      await this.show(dialog);
      return exported;
    } finally {
      URL.revokeObjectURL(url);
      if (previewUrl !== url) URL.revokeObjectURL(previewUrl);
    }
  }

  async pickCaptureBmp(caption: string): Promise<File | undefined> {
    const {dialog, form} = this.dialog('open-capture', caption || 'ファイルの選択');
    const document = dialog.ownerDocument;
    form.style.cssText = 'padding:12px;display:grid;gap:8px';
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.bmp,image/bmp';
    input.setAttribute('aria-label', 'BMP ファイル');
    let file: File | undefined;
    input.addEventListener('change', () => {
      file = input.files?.[0];
      if (file) dialog.close();
    });
    const close = document.createElement('button');
    close.textContent = 'キャンセル';
    form.append(input, close);
    await this.show(dialog);
    return file;
  }

  private templateDialog(kind: string, template: DialogTemplate) {
    const {dialog, form} = this.dialog(kind, template.title);
    const {font} = template;
    const units = font ? dialogFontBaseUnits(font.face, font.pointSize) : SYSTEM_DIALOG_BASE_UNITS;
    const horizontal = (value: number) => Math.round((value * units.cx) / 4);
    const vertical = (value: number) => Math.round((value * units.cy) / 8);
    form.style.cssText = `position:relative;width:${horizontal(template.cx)}px;height:${vertical(template.cy)}px`;
    const place = (item: DialogItemTemplate, element: HTMLElement, height = item.cy) => {
      element.dataset.siglusControl = String(item.id);
      Object.assign(element.style, {
        position: 'absolute',
        boxSizing: 'border-box',
        left: `${horizontal(item.x)}px`,
        top: `${vertical(item.y)}px`,
        width: `${horizontal(item.cx)}px`,
        height: `${vertical(height)}px`,
      });
      form.append(element);
    };
    return {dialog, form, place};
  }

  private show(dialog: HTMLDialogElement): Promise<void> {
    this.signal.throwIfAborted();
    return new Promise<void>((resolve, reject) => {
      const abort = (): void => {
        dialog.remove();
        reject(this.signal.reason);
      };
      this.signal.addEventListener('abort', abort, {once: true});
      dialog.addEventListener(
        'close',
        () => {
          this.signal.removeEventListener('abort', abort);
          dialog.remove();
          resolve();
        },
        {once: true},
      );
      try {
        this.owner.append(dialog);
        dialog.showModal();
      } catch (error) {
        this.signal.removeEventListener('abort', abort);
        dialog.remove();
        reject(error);
      }
    });
  }
}
