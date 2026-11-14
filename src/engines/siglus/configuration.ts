import type {ByteSource} from '../../core/source.js';
import {parseDialogTemplate} from '../../formats/pe/dialog-template.js';
import {parsePeResources} from '../../formats/pe/resources.js';
import {
  dialogFontBaseUnits,
  SYSTEM_DIALOG_BASE_UNITS,
} from '../../platform/windows-dialog-units.js';

const movieDialogResource = 124;
const sdWrapImageOffset = 0x1c000;
const moviePlayers = new Map<number, SiglusMoviePlayer>([
  [1164, 'mci'],
  [1165, 'wmp'],
]);
export type SiglusMoviePlayer = 'mci' | 'wmp';

export class SiglusConfiguration {
  private movieTemplate?: Promise<ReturnType<typeof parseDialogTemplate>>;

  constructor(
    private readonly owner: HTMLElement,
    private readonly engine: ByteSource | undefined,
    private readonly signal: AbortSignal,
  ) {}

  private async readMovieTemplate(): Promise<ReturnType<typeof parseDialogTemplate>> {
    if (!this.engine) throw new Error('SiglusEngine.exe is needed for the movie settings');
    const outer = await this.engine.read(0, this.engine.size);
    const embedded = outer.subarray(sdWrapImageOffset);
    const images = [outer];
    if (embedded[0] === 0x4d && embedded[1] === 0x5a) images.push(embedded);
    for (const image of images) {
      const resources = parsePeResources(image, [5]);
      const template = resources.find(
        ({id, language}) => id === movieDialogResource && language === 1041,
      );
      if (template) return parseDialogTemplate(template.bytes, 0);
    }
    throw new Error('Missing Siglus movie settings dialog resource');
  }

  async moviePlayer(current: SiglusMoviePlayer): Promise<SiglusMoviePlayer> {
    const template = await (this.movieTemplate ??= this.readMovieTemplate());
    this.signal.throwIfAborted();
    const document = this.owner.ownerDocument;
    const dialog = document.createElement('dialog');
    const {font} = template;
    const units = font ? dialogFontBaseUnits(font.face, font.pointSize) : SYSTEM_DIALOG_BASE_UNITS;
    const horizontal = (value: number) => Math.round((value * units.cx) / 4);
    const vertical = (value: number) => Math.round((value * units.cy) / 8);
    dialog.dataset.siglusConfiguration = 'movie';
    dialog.setAttribute('aria-label', template.title);
    dialog.style.cssText =
      'padding:0;border:1px solid #666;background:#f0f0f0;color:#000;font:11px sans-serif';
    const title = document.createElement('div');
    title.textContent = template.title;
    title.style.cssText = 'padding:4px 6px;background:#fff;border-bottom:1px solid #ccc';
    const form = document.createElement('form');
    form.method = 'dialog';
    form.style.cssText = `position:relative;width:${horizontal(template.cx)}px;height:${vertical(template.cy)}px`;
    dialog.append(title, form);
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
      element.dataset.siglusControl = String(item.id);
      Object.assign(element.style, {
        position: 'absolute',
        left: `${horizontal(item.x)}px`,
        top: `${vertical(item.y)}px`,
        width: `${horizontal(item.cx)}px`,
        height: `${vertical(item.cy)}px`,
      });
      form.append(element);
    }
    return new Promise((resolve, reject) => {
      const abort = (): void => {
        dialog.remove();
        reject(this.signal.reason);
      };
      this.signal.addEventListener('abort', abort, {once: true});
      dialog.addEventListener(
        'close',
        () => {
          this.signal.removeEventListener('abort', abort);
          const selected = new FormData(form).get('method');
          dialog.remove();
          resolve(selected === 'mci' || selected === 'wmp' ? selected : current);
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
