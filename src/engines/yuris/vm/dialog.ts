import type {YurisMachine} from './machine.js';
import {cString, type ByteString} from './numbers.js';
import type {WindowsMessageBoxResult} from '../../../platform/windows-message-box.js';

export interface YurisDialogHost {
  dialogMessage(
    text: ByteString,
    caption: ByteString,
    type: number,
  ): Promise<WindowsMessageBoxResult>;
  dialogInput(
    text: ByteString,
    caption: ByteString,
    initial: ByteString,
    limit: number | null,
  ): Promise<ByteString>;
}

/** DIALOG 0x43CD48. STR2..8, CHECKBOX/SLIDER and NOWAIT are unused in this native build. */
export function installDialog(m: YurisMachine, host: YurisDialogHost): void {
  m.define(0x0a, async () => {
    m.decode();
    const a = m.args;
    // The FILEOPEN branch is empty in this executable, including FILEEXT/FOLDER.
    if (a.has(20)) return 0;
    const text = a.has(1) ? a.text(1) : '',
      caption = a.has(0) ? a.text(0) : '';
    const store = (id: number, value: bigint) => {
      const slot = a.has(id);
      if (slot) m.setInt(a.variable[slot]!, a.variableIndex[slot]!, value);
    };
    // 0x43D590 / 0x43D5B8: make the cursor visible before entering either modal loop.
    m.input.show();
    m.input.applyCursor();
    if (a.has(16)) {
      const limit = a.has(17) ? Number(BigInt.asIntN(32, a.int(17))) : 0;
      const value = await host.dialogInput(
        text,
        caption,
        a.has(9) ? a.text(9) : '',
        limit > 0 ? limit : null,
      );
      store(11, 1n);
      const slot = a.has(10);
      // 0x43D5F0: GetWindowTextA's 0x1000-byte output includes the terminating NUL.
      if (slot)
        m.setString(a.variable[slot]!, a.variableIndex[slot]!, cString(value).slice(0, 0xfff));
      return 0;
    }
    let buttons = a.has(13) ? 1 : 0;
    if (a.has(14)) buttons = 4;
    if (a.has(15)) buttons = 3;
    const def = a.has(18) ? a.int(18) : 1n,
      icon = a.has(19) ? a.int(19) : 0n;
    const flags =
      buttons |
      (def === 2n ? 0x100 : def === 3n ? 0x200 : 0) |
      (icon === 1n ? 0x40 : icon === 2n ? 0x20 : icon === 3n ? 0x30 : icon === 4n ? 0x10 : 0);
    const result = await host.dialogMessage(text, caption, flags);
    // Native IDs YES/NO/CANCEL become the script's 1/2/3; OK/CANCEL stay 1/2.
    if (buttons === 3 || buttons === 4) {
      if (result === 6) store(11, 1n);
      else if (result === 7) store(11, 2n);
      else if (result === 2) store(11, 3n);
    } else if (result === 1 || result === 2) store(11, BigInt(result));
    return 0;
  });
}
