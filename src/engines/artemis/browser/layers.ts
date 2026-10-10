import type {AsbTag} from '../../../formats/artemis/asb.js';
import type {DrawListTarget} from '../../../graphics/draw-list.js';
import type {TriangleImage} from '../../../graphics/triangle-draw.js';
import type {ArtemisImageSource} from '../image-loader.js';
import {
  ArtemisImageGraphics,
  type ArtemisDisplayActor,
  type ArtemisImageShaderPrograms,
  type ArtemisTextSource,
  type ArtemisTextSprite,
} from '../image-graphics.js';
import type {ArtemisRasterPolicy} from '../gpu-raster.js';
import {ArtemisLayerOwner, type ArtemisMessageActorOwner} from '../layer-owner.js';
import type {ArtemisRuleImage} from '../transition.js';
import type {ArtemisMessageResource, ArtemisRuntimeLayerHost} from '../runtime.js';
import type {ArtemisRuntimeGlyphOwner} from '../runtime-glyphs.js';

export interface ArtemisBrowserLayerOptions {
  readonly executableSha256: string;
  readonly target: DrawListTarget;
  readonly raster: ArtemisRasterPolicy;
  /** The surface manager: layer images share its cache and loans. */
  readonly images: ArtemisImageSource;
  readonly runMode: ArtemisRuntimeLayerHost;
  loadRule(path: string): Promise<ArtemisRuleImage | null>;
  readVideoFile(path: string): Promise<Uint8Array | null>;
  /** timeGetTime of the presentation clock (animation and video layers). */
  readonly clock: {now(): number};
  readonly shaderPrograms?: ArtemisImageShaderPrograms;
  /** Message-layer text. */
  readonly glyphs: ArtemisRuntimeGlyphOwner;
  /** Display properties of an animated glyph or block. */
  textProperties(key: object): ReadonlyMap<string, number> | undefined;
  /** Native script error reports (c7260) of failed layer resources; the layer stays. */
  report(message: string): void;
}

export type ArtemisBrowserLayers = ArtemisLayerOwner<
  ArtemisDisplayActor,
  TriangleImage,
  ArtemisMessageResource
>;

const f = Math.fround;
const property = (values: ReadonlyMap<string, number> | undefined, name: string, base: number) =>
  values?.get(name) ?? base;

/** Glyph sprites of a message layer. Each glyph keeps the font attributes it was inserted
 * with: `left`/`top` place the text in the layer and `alpha` multiplies the entire and
 * per-glyph opacity; invisible fonts draw nothing. Text display tweens offset glyphs and
 * blocks (`left`, `top`), scale and rotate them about the glyph origin and multiply their
 * opacity. */
export function artemisTextSprites(
  options: Pick<ArtemisBrowserLayerOptions, 'glyphs' | 'textProperties'>,
  message: ArtemisMessageResource,
): ArtemisTextSprite[] {
  const insertion = options.glyphs.peek(message);
  if (!insertion) return [];
  const sprites: ArtemisTextSprite[] = [];
  for (const line of insertion.displayLines())
    for (const positioned of line.geometry.blocks) {
      const block = positioned.block,
        blockValues = options.textProperties(block);
      for (const glyph of [...block.main, ...block.ruby]) {
        const resource = glyph.glyph,
          surface = resource.surface,
          image = surface.image,
          font = resource.font;
        if (!image || !font.visible) continue;
        const values = options.textProperties(resource);
        const xscale = f(property(values, 'xscale', 1) * property(blockValues, 'xscale', 1)),
          yscale = f(property(values, 'yscale', 1) * property(blockValues, 'yscale', 1)),
          radians =
            ((property(values, 'rotate', 0) + property(blockValues, 'rotate', 0)) * Math.PI) / 180,
          cos = Math.cos(radians),
          sin = Math.sin(radians);
        const x = f(
            font.left +
              positioned.x +
              glyph.x +
              surface.left +
              property(values, 'left', 0) +
              property(blockValues, 'left', 0),
          ),
          y = f(
            font.top +
              line.y +
              positioned.y +
              glyph.y +
              surface.top +
              property(values, 'top', 0) +
              property(blockValues, 'top', 0),
          );
        sprites.push({
          image,
          matrix: new Float32Array([
            f(cos * xscale),
            f(-sin * yscale),
            x,
            f(sin * xscale),
            f(cos * yscale),
            y,
          ]),
          alpha: f(
            font.alpha *
              font.entirealpha *
              property(values, 'alpha', 1) *
              property(blockValues, 'alpha', 1),
          ),
        });
      }
    }
  return sprites;
}

function textSource(
  options: ArtemisBrowserLayerOptions,
  message: ArtemisMessageResource,
  owner: ArtemisMessageActorOwner<ArtemisMessageResource>,
): ArtemisTextSource {
  let revision = 0,
    previous: ArtemisTextSprite[] = [];
  const sprites = () => {
    // Native insertion is synchronous: frames during an asynchronous glyph load keep the
    // text from before the insertion.
    if (options.glyphs.peek(message)?.busy) return previous;
    const next = artemisTextSprites(options, message);
    const same =
      next.length === previous.length &&
      next.every(
        (sprite, index) =>
          sprite.image === previous[index]!.image &&
          sprite.alpha === previous[index]!.alpha &&
          sprite.matrix.every((value, entry) => value === previous[index]!.matrix[entry]),
      );
    if (!same) revision++;
    previous = next;
    return next;
  };
  return {
    // Sprites are compared with the previous sample: insertion, clearing and display
    // tweens all change them.
    get revision() {
      sprites();
      return revision;
    },
    sprites,
    retain: () => owner.retain(message),
    release: () => owner.release(message),
  };
}

/** The browser layer system: image, group, animation, video and message-layer actors
 * drawn through the shared raster target. Layer images load through the surface manager
 * so they share its cache and loans. */
export function createArtemisBrowserLayers(options: ArtemisBrowserLayerOptions): {
  readonly owner: ArtemisBrowserLayers;
  readonly graphics: ArtemisImageGraphics;
} {
  let graphics: ArtemisImageGraphics | undefined;
  const name = (tag: AsbTag, key: string) => tag.args.get(key) ?? '';
  const owner: ArtemisBrowserLayers = new ArtemisLayerOwner<
    ArtemisDisplayActor,
    TriangleImage,
    ArtemisMessageResource
  >(options.executableSha256, {
    createGraphics: (registry) =>
      (graphics = new ArtemisImageGraphics(
        options.executableSha256,
        options.target,
        {
          creationMode: () => 0,
          clearLayerCommands: (ids) => registry.clearLayerCommands(ids),
          resetLayerCommands: (id, tag) => registry.resetLayerCommands(id, tag),
          recordLayerProperties: (tag) => registry.recordLayerProperties(tag),
          appendLayerCommand: (id, tag) => registry.appendLayerCommand!(id, tag),
          imageLoadFailed: (tag) => options.report(`Image not found: ${name(tag, 'file')}`),
          layerNotFound: (tag) => options.report(`Layer not found: ${name(tag, 'id')}`),
          animationError: (tag, error) =>
            options.report(
              `Animation ${error === 'mode' ? 'mode error' : 'not found'}: ${name(tag, 'id')}`,
            ),
          readVideoFile: (path) => options.readVideoFile(path),
          videoError: (tag, error) =>
            options.report(
              `Video ${error === 'unsupported' ? 'unsupported' : 'not found'}: ${name(tag, 'file')}`,
            ),
        },
        options.raster,
        options.shaderPrograms,
        options.clock,
      )),
    images: options.images,
    runMode: options.runMode,
    loadRule: (path) => options.loadRule(path),
    createMessageActor: (message, messageOwner) =>
      graphics!.createTextLayer(textSource(options, message, messageOwner)),
    applyTweenProperties: (id, actor, patch) => graphics!.applyImageProperties(id, actor, patch),
    videoOf: (actor) => graphics!.videoOf(actor),
    layerInfo: (actor) => graphics!.layerInfo(actor),
  });
  return {owner, graphics: graphics!};
}
