import type {AsbTag} from '../../formats/artemis/asb.js';
import {artemisInteger} from './numbers.js';

/** CArtemis::CGlyphInfo (node constructor 0x140105530): click-wait glyph placement for one
 * message layer. */
export interface ArtemisClickGlyph {
  /** +8: homing="0" clears it, any other homing value sets it; absent keeps it. */
  homing: boolean;
  /** +9 / +0x10: the glyph is the named layer. */
  layer: boolean;
  layerName: string;
  /** +0x50 TPoint<int>. */
  left: number;
  top: number;
  /** +10 / +0x30 / +0x60: the read-ahead (rplayer) glyph; absent copies the layer fields. */
  rplayer: boolean;
  rplayerName: string;
  rpleft: number;
  rptop: number;
}

export interface ArtemisClickGlyphHost {
  /** Current message layer name (script +0x35e0). */
  currentMessageLayer(): string;
  /** Layer set +0x140 lookup by name; when the layer exists, its virtual +0xf0 (0x1400a4970)
   * stores the byte argument at layer +0x16c. The glyph tag always passes 0. */
  setLayerByte16c(name: string, value: boolean): void;
}

/** Glyph tag 0x1400d3290 over the per-message-layer map at script +0x3818 (find-or-create
 * 0x1400eb500). bf210 clears the map. */
export class ArtemisClickGlyphs {
  private readonly entries = new Map<string, ArtemisClickGlyph>();
  constructor(private readonly host: ArtemisClickGlyphHost) {}
  get(name: string): Readonly<ArtemisClickGlyph> | undefined {
    return this.entries.get(name);
  }
  private entry(): ArtemisClickGlyph {
    const name = this.host.currentMessageLayer();
    let entry = this.entries.get(name);
    if (!entry)
      this.entries.set(
        name,
        (entry = {
          homing: false,
          layer: false,
          layerName: '',
          left: 0,
          top: 0,
          rplayer: false,
          rplayerName: '',
          rpleft: 0,
          rptop: 0,
        }),
      );
    return entry;
  }
  reset(): void {
    this.entries.clear();
  }
  dispatch(tag: AsbTag): boolean {
    if (tag.name !== 'glyph') return false;
    const args = tag.args;
    const entry = this.entry();
    // Without layer only the flag clears; the stored name is kept.
    entry.layer = args.has('layer');
    if (entry.layer) {
      entry.layerName = args.get('layer')!;
      this.host.setLayerByte16c(entry.layerName, false);
    }
    if (args.has('left')) entry.left = artemisInteger(args.get('left')!);
    if (args.has('top')) entry.top = artemisInteger(args.get('top')!);
    if (!args.has('rplayer')) {
      entry.rplayer = entry.layer;
      entry.rplayerName = entry.layerName;
      entry.rpleft = entry.left;
      entry.rptop = entry.top;
    } else {
      entry.rplayer = true;
      entry.rplayerName = args.get('rplayer')!;
      if (args.has('rpleft')) entry.rpleft = artemisInteger(args.get('rpleft')!);
      if (args.has('rptop')) entry.rptop = artemisInteger(args.get('rptop')!);
      this.host.setLayerByte16c(entry.rplayerName, false);
    }
    if (args.has('homing')) entry.homing = args.get('homing') !== '0';
    return true;
  }
}
