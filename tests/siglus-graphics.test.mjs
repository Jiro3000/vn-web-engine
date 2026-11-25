import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test from 'node:test';
import {captureLayers} from '../dist/engines/siglus/capture.js';
import {SiglusDisplay} from '../dist/engines/siglus/display.js';
import {fanWipeMask, g00MaskValues} from '../dist/engines/siglus/wipe.js';
import {bgraLuminanceMask} from '../dist/graphics/bgra-effects-wasm.js';

test('full-screen fan wipes preserve inclusive edges and reversed odd-size masks', () => {
  for (const [width, height, quadrant, reverse, expected] of [
    [1920, 1080, 2, false, '20fe7553c6841e0811943986633b9fb25dee8c1998331c075b2568a9d6266020'],
    [1919, 1079, 3, true, '369a4476558930569c23ddad9a7ca9c9a90286caecf604552acddb2ca0fc8682'],
  ]) {
    const mask = fanWipeMask(width, height, {softness: 0.5, quadrant, reverse});
    assert.equal(createHash('sha256').update(mask).digest('hex'), expected);
  }
});

test('large G00 wipe masks preserve integer luminance, reversal, and odd band tails', () => {
  const width = 513;
  const height = 515;
  const bgra = new Uint8Array(width * height * 4);
  const expected = new Uint8Array(width * height);
  for (let i = 0; i < expected.length; i++) {
    const blue = (i >>> 3) & 255;
    const green = i % 4 === 0 ? blue : (i * 79) & 255;
    const red = i % 4 === 0 ? blue : (i * 131 + 1) & 255;
    bgra.set([blue, green, red, i & 255], i * 4);
    expected[i] = Math.floor((299 * red + 587 * green + 114 * blue) / 1000);
  }
  const accelerated = new Uint8Array(expected.length);
  assert.equal(bgraLuminanceMask(bgra, accelerated, false), true);
  assert.deepEqual(accelerated, expected);
  assert.deepEqual(g00MaskValues(bgra, width, height), expected);
  assert.deepEqual(
    g00MaskValues(bgra, width, height, true),
    expected.map((value) => 255 - value),
  );
});

function installRenderingDom(t) {
  class Element extends EventTarget {
    style = {};
    dataset = {};
    children = [];
    animations = [];
    isConnected = false;
    append(child) {
      this.children.push(child);
    }
    animate(keyframes) {
      this.animations.push(keyframes);
      return {currentTime: null};
    }
    setAttribute() {}
    querySelectorAll(selector) {
      const property =
        selector === '[data-siglus-positioned]' ? 'siglusPositioned' : 'siglusDstClip';
      return this.children.flatMap((child) => [
        ...(Object.hasOwn(child.dataset, property) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
  }
  class Canvas extends Element {
    clips = [];
    transforms = [];
    context = {
      canvas: this,
      drawImage: (image) => {
        this.image = image;
      },
      rect: (...box) => this.clips.push(box),
      transform: (...matrix) => this.transforms.push(matrix),
      clearRect() {},
      setTransform() {},
      fillRect() {},
      save() {},
      restore() {},
      beginPath() {},
      clip() {},
    };
    getContext() {
      return this.context;
    }
  }
  class Button extends Element {}
  const document = {
    createElement(tag) {
      return tag === 'canvas' ? new Canvas() : tag === 'button' ? new Button() : new Element();
    },
  };
  for (const [name, value] of Object.entries({
    document,
    HTMLElement: Element,
    HTMLCanvasElement: Canvas,
    HTMLButtonElement: Button,
    getComputedStyle: (element) => ({
      opacity: '1',
      mixBlendMode: 'normal',
      clipPath: 'none',
      filter: 'none',
      backgroundColor: 'rgba(0, 0, 0, 0)',
      ...element.style,
    }),
  })) {
    const previous = Object.getOwnPropertyDescriptor(globalThis, name);
    Object.defineProperty(globalThis, name, {value, configurable: true});
    t.after(() => {
      if (previous) Object.defineProperty(globalThis, name, previous);
      else delete globalThis[name];
    });
  }
  return {document, Button};
}

function renderFixture(t, config = []) {
  const {document, Button} = installRenderingDom(t);
  const display = Object.assign(Object.create(SiglusDisplay.prototype), {
    width: 200,
    height: 100,
    config: new Map(config),
    hitPaths: new WeakMap(),
  });
  const frame = (image) => ({
    image,
    width: 20,
    height: 20,
    x: 0,
    y: 0,
    centerX: 0,
    centerY: 0,
    pixels: new Uint8ClampedArray(20 * 20 * 4).fill(255),
  });
  const base = {name: 'control', frames: [frame('normal')], visible: true, pattern: 0, x: 5, y: 10};
  return {display, stage: document.createElement('div'), frame, base, Button};
}

function systemLayerFixture() {
  const container = () => ({
    children: [],
    append(page) {
      this.children.push(page);
      page.remove = () => {
        this.children = this.children.filter((child) => child !== page);
      };
    },
    replaceChildren(...pages) {
      this.children = [];
      for (const page of pages) this.append(page);
    },
  });
  return Object.assign(Object.create(SiglusDisplay.prototype), {
    signal: new AbortController().signal,
    systemLayer: container(),
    systemFrontLayer: container(),
    systemLayerDraws: new WeakMap(),
    preserveStageFocus(update) {
      update();
    },
    async drawObjects([page]) {
      return page;
    },
  });
}

test('closing or replacing a system page discards its pending drawing', async () => {
  const display = systemLayerFixture();
  const slow = Promise.withResolvers();
  const newer = {childElementCount: 1};
  const pending = display.showSystemObjects([slow.promise], () => {});
  await display.showSystemObjects([newer], () => {});
  slow.resolve({childElementCount: 1});
  await pending;
  assert.deepEqual(display.systemLayer.children, [newer]);

  const closing = Promise.withResolvers();
  const pendingFront = display.showSystemObjects([closing.promise], () => {}, true);
  display.clearSystemFrontObjects();
  closing.resolve({childElementCount: 1});
  await pendingFront;
  assert.deepEqual(display.systemFrontLayer.children, []);
  assert.deepEqual(display.systemLayer.children, [newer]);
});

test('a completed system fade-out removes only the pages it started with', async () => {
  const display = systemLayerFixture();
  const fade = Promise.withResolvers();
  const outgoing = {childElementCount: 1, animate: () => ({finished: fade.promise})};
  const incoming = {childElementCount: 1};
  await display.showSystemObjects([outgoing], () => {});
  const closing = display.showSystemObjects(
    [{childElementCount: 0, animate() {}}],
    () => {},
    false,
    100,
  );
  await Promise.resolve();
  await display.showSystemObjects([incoming], () => {});
  fade.resolve();
  await closing;
  assert.deepEqual(display.systemLayer.children, [incoming]);
});

test('late object masks cannot undo a clear or a restored mask slot', async (t) => {
  const {display} = renderFixture(t);
  const old = Promise.withResolvers();
  const canvas = document.createElement('canvas');
  canvas.toDataURL = () => 'mask-url';
  Object.assign(display, {
    objectMasks: new Map(),
    maskUrlCache: new Map(),
    pendingObjectMasks: new Map(),
    objectMaskRestoreGeneration: 0,
    graphic: () => old.promise,
  });
  const pending = display.setObjectMask(4, 'old-mask');
  await display.setObjectMask(4);
  old.resolve({image: canvas});
  await pending;
  assert.deepEqual(display.saveObjectMasks(), []);

  const loading = Promise.withResolvers();
  display.graphic = () => loading.promise;
  const beforeLoad = display.setObjectMask(4, 'before-load');
  await display.restoreObjectMasks([[4, {x: 12, y: 7}]]);
  loading.resolve({image: canvas});
  await beforeLoad;
  assert.deepEqual(display.saveObjectMasks(), [[4, {name: undefined, x: 12, y: 7}]]);

  const replaced = Promise.withResolvers();
  const current = Promise.withResolvers();
  display.graphic = (name) => (name === 'current' ? current.promise : replaced.promise);
  const superseded = display.setObjectMask(4, 'replaced');
  const replacing = display.setObjectMask(4, 'current');
  display.setObjectMaskOffset(4, 'x', 40);
  current.resolve({image: canvas});
  await replacing;
  replaced.resolve({image: canvas});
  await superseded;
  assert.deepEqual(display.saveObjectMasks(), [[4, {name: 'current', x: 40, y: 7}]]);

  const restoring = Promise.withResolvers();
  display.graphic = () => restoring.promise;
  const previousLoad = display.restoreObjectMasks([
    [4, {name: 'previous-load', x: 1, y: 2}],
    [5, {x: 3, y: 4}],
  ]);
  await display.restoreObjectMasks([[6, {x: 5, y: 6}]]);
  restoring.resolve({image: canvas});
  await previousLoad;
  assert.deepEqual(display.saveObjectMasks(), [[6, {name: undefined, x: 5, y: 6}]]);
});

test('stage buttons render their initial disabled and selected graphics offscreen', async (t) => {
  const {display, stage, frame, base} = renderFixture(t, [
    ['BUTTON.ACTION.000.NORMAL', '0,0,0,255'],
    ['BUTTON.ACTION.000.DISABLE', '1,0,0,255'],
    ['BUTTON.ACTION.000.SELECT', '2,0,0,255'],
  ]);
  const frames = [base.frames[0], frame('disabled')];
  display.objectGraphic = async (_name, cut) => (cut === 2 ? frame('selected') : undefined);
  const button = {id: 0, group: 0, actionNo: 0};
  await display.appendObjects(
    stage,
    [
      {...base, frames, button, buttonState: 'disable', disabled: true},
      {...base, frames, button, buttonState: 'select'},
    ],
    () => {},
    false,
  );
  assert.deepEqual(
    stage.children.map(({children}) => children[0].image),
    ['disabled', 'selected'],
  );
});

test('the source crop encloses the alpha hit path and every animated image pattern', async (t) => {
  const {display, stage, frame, base, Button} = renderFixture(t);
  await display.appendObjects(
    stage,
    [
      {
        ...base,
        frames: [base.frames[0], frame('second pattern')],
        button: {id: 0, group: 0},
        alphaTest: true,
        sourceClipEnabled: true,
        sourceClipBounds: [4, 3, 18, 19],
        patternCycle: {count: 2, duration: 1000, started: performance.now()},
      },
    ],
    () => {},
    false,
  );
  const [crop] = stage.children;
  assert.equal(crop.style.clipPath, 'inset(3px 2px 1px 4px)');
  const [button] = crop.children;
  assert.ok(button instanceof Button);
  assert.match(button.style.clipPath, /^path\("/);
  assert.deepEqual(
    button.children.map(({image}) => image),
    ['normal', 'second pattern'],
  );
});

test('capture scales local pixel insets and keeps percentage edges relative to the rendered box', (t) => {
  const {document} = installRenderingDom(t);
  const sprite = document.createElement('canvas');
  sprite.offsetWidth = sprite.offsetHeight = 20;
  sprite.getBoundingClientRect = () => ({left: 120, top: 10, width: 40, height: 30});
  sprite.style.scale = '2 1.5';
  sprite.style.clipPath = 'inset(2px 10% 4px 4px)';
  const bounds = {left: 0, top: 0, width: 200, height: 100};
  const capture = captureLayers(200, 100, bounds, [sprite]);
  assert.deepEqual(capture.clips, [[4, 2, 14, 14]]);
  assert.deepEqual(capture.transforms, [
    [2, 0, 0, 1.5, 120, 10],
    [2, 0, 0, 1.5, 120, 10],
  ]);
});

test('captures keep reflected sprite pixels and their clip in the same local coordinates', (t) => {
  const {document} = installRenderingDom(t);
  const sprite = document.createElement('canvas');
  sprite.offsetWidth = sprite.offsetHeight = 20;
  sprite.getBoundingClientRect = () => ({left: 120, top: 10, width: 40, height: 30});
  sprite.style.scale = '-2 1.5';
  sprite.style.clipPath = 'inset(0px 10px 0px 0px)';
  const capture = captureLayers(200, 100, {left: 0, top: 0, width: 200, height: 100}, [sprite]);
  assert.deepEqual(capture.clips, [[0, 0, 10, 20]]);
  assert.deepEqual(capture.transforms, [
    [-2, 0, 0, 1.5, 160, 10],
    [-2, 0, 0, 1.5, 160, 10],
  ]);
});

test('plain stage movement retains the rendered canvas and respects clipping fallbacks', async (t) => {
  const {display, stage, base} = renderFixture(t);
  stage.isConnected = true;
  display.objectLayer = stage;
  const group = {
    ...base,
    name: '',
    frames: [],
    children: new Map([[0, base]]),
    clip: [1, 0, 0, 200, 100],
  };
  display.stage = stage;
  stage.ownerDocument = document;
  await display.appendObjects(stage, [group], () => {}, false);
  const [crop] = stage.children;
  const [position] = crop.children;
  const [original] = position.children;
  group.positionOffsets = {y: [15]};
  assert.equal(display.updateStageObjectPositions(new Set([group])), true);
  assert.deepEqual(position.children, [original]);
  assert.equal(position.style.top, '25px');
  assert.equal(crop.style.clipPath, 'inset(0px 0px 0px 0px)');

  const nestedCrop = document.createElement('div');
  nestedCrop.dataset.siglusDstClip = '';
  position.append(nestedCrop);
  group.y = 30;
  assert.equal(display.updateStageObjectPositions(new Set([group])), false);
  assert.equal(position.style.top, '25px');
});

test('translation animations preserve sprite rotation and combine across axes', async (t) => {
  const {display, stage, base} = renderFixture(t);
  await display.appendObjects(
    stage,
    [
      {
        ...base,
        rotateY: 600,
        horizontalMotion: {
          from: -35,
          duration: 1000,
          delay: 0,
          easing: 0,
          started: performance.now(),
        },
        movement: [40, 1000, 0, 0, 10],
      },
    ],
    () => {},
    true,
  );
  const [sprite] = stage.children;
  assert.equal(sprite.style.transform, 'rotateY(60deg)');
  assert.deepEqual(sprite.animations, [
    [
      {translate: '-40px 0px', composite: 'add'},
      {translate: '0px 0px', composite: 'add'},
    ],
    [
      {translate: '0px 10px', composite: 'add'},
      {translate: '0px 40px', composite: 'add'},
    ],
  ]);
});
