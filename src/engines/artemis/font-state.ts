import {artemisRevision} from './revision.js';
import {artemisFontProperties, type ArtemisFontPropertyPatch} from './font-properties.js';

export type ArtemisFontFace = string | readonly number[];
export type ArtemisFontAttributes = Readonly<
  Required<Omit<ArtemisFontPropertyPatch, 'face' | 'rubyface' | 'overflow'>> & {
    face: ArtemisFontFace;
    rubyface: ArtemisFontFace;
  }
>;
/** 193720 uses this exact 13-byte Shift-JIS label even for a UTF-8 game. Retain
 * those bytes until an actual file-font name replaces them; don't invent a web
 * font or reinterpret them as UTF-8. System-font resolution is a separate owner. */
const defaultFace = Object.freeze([
  0x82, 0x6c, 0x82, 0x72, 0x20, 0x83, 0x53, 0x83, 0x56, 0x83, 0x62, 0x83, 0x4e,
]);
export function artemisDefaultFontAttributes(hash: string): ArtemisFontAttributes {
  artemisRevision(hash);
  return Object.freeze({
    left: 0,
    top: 0,
    width: 640,
    height: 480,
    entireanchorx: 0,
    entireanchory: 0,
    anchorcenter: true,
    entirealpha: 1,
    entirexscale: 1,
    entireyscale: 1,
    entirerotate: 0,
    layermode: 'normal',
    visible: true,
    alpha: 1,
    xscale: 1,
    yscale: 1,
    rotate: 0,
    face: defaultFace,
    rubyface: defaultFace,
    size: 24,
    shadow: 0,
    outline: 0,
    rubysize: 8,
    rubyshadow: 0,
    rubyoutline: 0,
    spacetop: 0,
    spacemiddle: 0,
    spacebottom: 0,
    kerning: 0,
    rubykerning: 0,
    color: 0xffffff,
    shadowcolor: 0,
    outlinecolor: 0,
    align: 'left',
    styleBits: 0,
    vertical: false,
    hung: true,
  });
}
/** Native font attributes and the history frame's extra overflow int stay distinct. */
export function artemisPatchFontAttributes(
  hash: string,
  before: ArtemisFontAttributes,
  args: ReadonlyMap<string, string>,
): {readonly font: ArtemisFontAttributes; readonly overflow: number | undefined} {
  artemisRevision(hash);
  const {overflow, ...patch} = artemisFontProperties(args);
  return Object.freeze({font: Object.freeze({...before, ...patch}), overflow});
}
