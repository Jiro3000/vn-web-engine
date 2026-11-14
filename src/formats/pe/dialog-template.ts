const DS_SETFONT = 0x40;

/** A name or an ordinal (`sz_Or_Ord`). */
export type NameOrOrdinal = string | number | null;

export interface DialogItemTemplate {
  readonly helpId: number;
  readonly style: number;
  readonly exStyle: number;
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
  readonly id: number;
  readonly className: NameOrOrdinal;
  readonly title: NameOrOrdinal;
  /** Address of the creation data, 0 without. */
  readonly data: number;
}

export interface DialogTemplate {
  readonly extended: boolean;
  readonly helpId: number;
  readonly style: number;
  readonly exStyle: number;
  readonly x: number;
  readonly y: number;
  readonly cx: number;
  readonly cy: number;
  readonly menu: NameOrOrdinal;
  readonly className: NameOrOrdinal;
  readonly title: string;
  readonly font: {
    readonly pointSize: number;
    readonly weight: number;
    readonly italic: boolean;
    readonly charset: number;
    readonly face: string;
  } | null;
  readonly items: readonly DialogItemTemplate[];
}

/** Reads a `DLGTEMPLATE` or `DLGTEMPLATEEX` at `address`. */
export function parseDialogTemplate(u8: Uint8Array, address: number): DialogTemplate {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = address;
  const u16 = () => {
    const v = dv.getUint16(p, true);
    p += 2;
    return v;
  };
  const i16 = () => {
    const v = dv.getInt16(p, true);
    p += 2;
    return v;
  };
  const u32 = () => {
    const v = dv.getUint32(p, true);
    p += 4;
    return v;
  };
  const sz = (): string => {
    let s = '';
    for (;;) {
      const c = u16();
      if (!c) return s;
      s += String.fromCharCode(c);
    }
  };
  const szOrOrd = (): NameOrOrdinal => {
    const first = dv.getUint16(p, true);
    if (first === 0) {
      p += 2;
      return null;
    }
    if (first === 0xffff) {
      p += 2;
      return u16();
    }
    return sz();
  };
  const align4 = () => {
    p = address + ((p - address + 3) & ~3);
  };

  const extended = dv.getUint16(p, true) === 1 && dv.getUint16(p + 2, true) === 0xffff;
  let helpId = 0;
  let style: number;
  let exStyle: number;
  if (extended) {
    p += 4;
    helpId = u32();
    exStyle = u32();
    style = u32();
  } else {
    style = u32();
    exStyle = u32();
  }
  const count = u16();
  const x = i16();
  const y = i16();
  const cx = i16();
  const cy = i16();
  const menu = szOrOrd();
  const className = szOrOrd();
  const title = szOrOrd();
  let font: DialogTemplate['font'] = null;
  if (style & DS_SETFONT) {
    const pointSize = u16();
    let weight = 0;
    let italic = false;
    let charset = 1;
    if (extended) {
      weight = u16();
      italic = dv.getUint8(p) !== 0;
      charset = dv.getUint8(p + 1);
      p += 2;
    }
    font = {pointSize, weight, italic, charset, face: sz()};
  }
  const items: DialogItemTemplate[] = [];
  for (let i = 0; i < count; i++) {
    align4();
    let itemHelp = 0;
    let itemStyle: number;
    let itemExStyle: number;
    if (extended) {
      itemHelp = u32();
      itemExStyle = u32();
      itemStyle = u32();
    } else {
      itemStyle = u32();
      itemExStyle = u32();
    }
    const ix = i16();
    const iy = i16();
    const icx = i16();
    const icy = i16();
    const id = extended ? u32() : u16();
    const cls = szOrOrd();
    const ititle = szOrOrd();
    const extra = u16();
    const data = extra ? p : 0;
    p += extra;
    items.push({
      helpId: itemHelp,
      style: itemStyle,
      exStyle: itemExStyle,
      x: ix,
      y: iy,
      cx: icx,
      cy: icy,
      id,
      className: cls,
      title: ititle,
      data,
    });
  }
  return {
    extended,
    helpId,
    style,
    exStyle,
    x,
    y,
    cx,
    cy,
    menu,
    className,
    title: typeof title === 'string' ? title : '',
    font,
    items,
  };
}
