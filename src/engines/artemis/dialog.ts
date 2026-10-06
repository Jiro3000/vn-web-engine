import type {TextDialogHost} from '../../platform/text-dialog.js';
import type {AsbTag} from '../../formats/artemis/asb.js';

export interface ArtemisDialogEffects {
  blocked(): boolean;
  beginWait(): void;
  endWait(): void;
  writeVariable(name: string, value: string): void;
}
function integer(value: string): number {
  const token = /^[\t\n\v\f\r ]*([+-]?\d+)/.exec(value);
  const number = token ? Number(token[1]) : 0;
  if (!Number.isInteger(number) || number < -0x80000000 || number > 0x7fffffff)
    throw new Error('Unsupported Artemis dialog integer');
  return number;
}

/** UTF-8 message-dialog subset of 0x1400c91e0 and completion 0x1400b7460.
 * Text entry requires native encoding/length handling and is refused explicitly.
 */
export class ArtemisDialog {
  private active: object | null = null;
  constructor(
    private readonly host: TextDialogHost,
    private readonly effects: ArtemisDialogEffects,
  ) {}
  get pending(): boolean {
    return this.active !== null;
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'dialog') return false;
    if (this.effects.blocked()) return true;
    if (this.active) throw new Error('Artemis dialog is already pending');
    const p = tag.args;
    if (p.has('textfield')) throw new Error('Artemis dialog text entry is not implemented');
    const request = Object.freeze({
      title: p.get('title') ?? '',
      message: p.get('message') ?? '',
      canCancel: p.has('varname'),
      fontSize: p.has('fontsize') ? integer(p.get('fontsize')!) : 20,
      minimumWidth: p.has('minwidth') ? integer(p.get('minwidth')!) : 240,
      applyDesktopScale: p.has('applydesktopscale') && p.get('applydesktopscale') !== '0',
    });
    const variable = p.get('varname') ?? '';
    const token = {};
    this.active = token;
    try {
      this.effects.beginWait();
      this.host.present(request, (outcome) => {
        if (this.active !== token) throw new Error('Stale or repeated Artemis dialog completion');
        if (
          !Number.isInteger(outcome.result) ||
          outcome.result < -0x80000000 ||
          outcome.result > 0x7fffffff
        )
          throw new Error('Invalid Artemis dialog result');
        if (variable) this.effects.writeVariable(variable, String(outcome.result));
        this.active = null;
        this.effects.endWait();
      });
    } catch (error) {
      if (this.active === token) {
        this.active = null;
        this.effects.endWait();
      }
      throw error;
    }
    return true;
  }
}
