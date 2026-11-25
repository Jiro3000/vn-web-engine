import assert from 'node:assert/strict';
import test from 'node:test';
import {captureLayers} from '../dist/engines/siglus/capture.js';
import {SiglusDisplay} from '../dist/engines/siglus/display.js';

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
