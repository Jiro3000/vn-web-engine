import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Vc1Decoder,
  FOURCC_WMV3,
  FOURCC_WVC1,
  VC1_PACKET_LIMIT,
} from '../dist/formats/vc1/reference.js';

// Synthetic 16×16 Main-profile stream: quantizer 8, no AC or DC differentials.
// The default DC predictor and inverse transform produce constant sample value 143.
// The following P picture skips the single macroblock. No media fixture is used.
const mainExtra = Buffer.from('4ff94801', 'hex');
const mainI = Buffer.from('00100bc0', 'hex');
const mainP = Buffer.from('28200840', 'hex');
const main = () => new Vc1Decoder(FOURCC_WMV3, 16, 16, mainExtra);

function constantPicture(picture, type, time, value) {
  assert.equal(picture.type, type);
  assert.equal(picture.time, time);
  assert.equal(picture.stride, 16);
  assert.equal(picture.chromaStride, 8);
  for (const [plane, size] of [
    [picture.y, 256],
    [picture.cb, 64],
    [picture.cr, 64],
  ])
    assert.deepEqual(plane.subarray(0, size), new Uint8Array(size).fill(value));
}

const bits = (text) =>
  Buffer.from(
    text
      .padEnd(Math.ceil(text.length / 8) * 8, '0')
      .match(/.{8}/g)
      .map((x) => parseInt(x, 2)),
  );
const field = (width, value) => value.toString(2).padStart(width, '0');
function advancedExtra({rangeY = false, rangeUv = false, interlace = false} = {}) {
  const sequence = bits(
    '11' +
      '000' +
      '01' +
      '000' +
      '00000' +
      '0' +
      field(12, 7) +
      field(12, 7) +
      '0' +
      Number(interlace) +
      '00' +
      '1000',
  );
  const entry = bits(
    '01000000000000' +
      Number(rangeY) +
      (rangeY ? '001' : '') +
      Number(rangeUv) +
      (rangeUv ? '001' : ''),
  );
  return Buffer.concat([Buffer.from([0, 0, 1, 15]), sequence, Buffer.from([0, 0, 1, 14]), entry]);
}

test('VC-1 Main emits I and skipped P pictures immediately with packet timestamps', () => {
  const decoder = main();
  constantPicture(decoder.decode(mainI, 12), 1, 12, 143);
  constantPicture(decoder.decode(mainP, 45), 2, 45, 143);
  constantPicture(decoder.decode(mainI, 78), 1, 78, 143);
  assert.equal(decoder.decode(null, 0), null);
  assert.equal(decoder.decode(null, 0), null);
});

test('VC-1 Advanced delays reference pictures and drains the last picture once', () => {
  const decoder = new Vc1Decoder(FOURCC_WVC1, 16, 16, advancedExtra());
  // I header: 110 type, rounding, quantizer 8, HALFQP 0; raw AC-prediction plane,
  // TRANSACFRM/TRANSDCTAB zero, CBP zero, raw AC-prediction zero and six zero DCs.
  const intra = bits('110' + '1' + '01000' + '0' + '00000' + '000' + '1' + '0' + '11110000');
  assert.equal(decoder.decode(intra, 12), null);
  constantPicture(decoder.decode(bits('1111'), 45), 1, 12, 128);
  constantPicture(decoder.decode(null, 0), 2, 45, 128);
  assert.equal(decoder.decode(null, 0), null);
});

test('VC-1 keeps decoder state private between streams', () => {
  const first = main();
  const second = main();
  constantPicture(first.decode(mainI, 1), 1, 1, 143);
  constantPicture(second.decode(mainI, 200), 1, 200, 143);
  constantPicture(first.decode(mainP, 2), 2, 2, 143);
  constantPicture(second.decode(mainP, 201), 2, 201, 143);
});

test('VC-1 refuses unsupported tools and bounds storage before allocation', () => {
  for (const [width, height] of [
    [0, 16],
    [-1, 16],
    [16.5, 16],
    [4097, 16],
    [16, 2161],
    [NaN, 16],
  ])
    assert.throws(() => new Vc1Decoder(FOURCC_WMV3, width, height, mainExtra), /dimensions/);
  assert.throws(() => new Vc1Decoder(FOURCC_WMV3, 16, 16, new Uint8Array(1)), /decode error/);
  assert.throws(() => main().decode(new Uint8Array(VC1_PACKET_LIMIT + 1), 0), /packet size/);
  for (const [options, message] of [
    [{rangeY: true}, /luma range mapping/],
    [{rangeUv: true}, /chroma range mapping/],
    [{interlace: true}, /interlaced coding/],
  ])
    assert.throws(() => new Vc1Decoder(FOURCC_WVC1, 16, 16, advancedExtra(options)), message);
  const decoder = new Vc1Decoder(FOURCC_WVC1, 16, 16, advancedExtra());
  assert.throws(() => decoder.decode(bits('1110' + '1' + '01000' + '0'), 1), /B pictures/);
});
