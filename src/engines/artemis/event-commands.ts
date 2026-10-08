import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisInteger} from './numbers.js';

const registrations = [
  'setonautomodein',
  'setonautomodeout',
  'setoncommandskipin',
  'setoncommandskipout',
  'setoncontrolskipin',
  'setoncontrolskipout',
  'setonhidein',
  'setonhideout',
  'setonbacklogin',
  'setonbacklogout',
  'setondirchg',
] as const;
export type ArtemisCommandEvent = (typeof registrations)[number];

/** Native 0x1400df0c0 captures the current file only for label-only registrations. */
export function captureEventCommand(tag: AsbTag, currentFile: () => string): AsbTag {
  const args = new Map(tag.args);
  if (!args.has('file') && args.has('label')) args.set('file', currentFile());
  return {...tag, args};
}

/** Copied native command events; delon* clears a slot. Mode/input owners determine when to
 * dispatch them.
 */
export class ArtemisEventCommands {
  private readonly commands = new Map<ArtemisCommandEvent, AsbTag>();
  private readonly windowButtons = new Map<number | null, AsbTag>();
  constructor(private readonly currentFile: () => string) {}
  /** bf210 empties the eleven seton* slots (38b0..3ce0); window buttons (3c70/3c80) remain. */
  reset(): void {
    this.commands.clear();
  }
  /** delon* (0x1400e0330) move-assigns an empty block (a2300), which c6730 skips. */
  dispatch(tag: AsbTag): boolean {
    if (tag.name === 'setonwindowbutton' || tag.name === 'delonwindowbutton') {
      // df0c0/e0330: atoi(button) keys map 3c70; without button the single slot 3c80.
      const button = tag.args.has('button') ? artemisInteger(tag.args.get('button')!) : null;
      if (tag.name === 'delonwindowbutton') this.windowButtons.delete(button);
      else this.windowButtons.set(button, captureEventCommand(tag, this.currentFile));
      return true;
    }
    if (tag.name.startsWith('delon')) {
      const event = 'seton' + tag.name.slice(5);
      if (!(registrations as readonly string[]).includes(event)) return false;
      this.commands.delete(event as ArtemisCommandEvent);
      return true;
    }
    if (!(registrations as readonly string[]).includes(tag.name)) return false;
    this.commands.set(tag.name as ArtemisCommandEvent, captureEventCommand(tag, this.currentFile));
    return true;
  }
  /** Window-button command for a numbered button, or the button-less slot for null. */
  windowButton(button: number | null): AsbTag | undefined {
    const command = this.windowButtons.get(button);
    return command ? {...command, args: new Map(command.args)} : undefined;
  }
  command(event: ArtemisCommandEvent): AsbTag | undefined {
    const command = this.commands.get(event);
    return command ? {...command, args: new Map(command.args)} : undefined;
  }
}
