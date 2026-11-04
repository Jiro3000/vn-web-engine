/**
 * The engine settings of `yscfg.dat` (32 little-endian words written by settings.exe), as
 * 0x466AC0 reads them at start-up. Words outside their listed values leave the setting at its
 * default. The program stops with a message (0x87D380) when the file cannot be read.
 */
export class YurisStartupSettings {
  /** 0x59B794 (word 0). */
  value0 = 1;
  /** 0x59B040 (word 1). */
  value1 = 1;
  /** 0x59B04C (word 2): the SSE image routines are used. */
  simd = 1;
  /** 0x59B050 (word 3): the CG preload thread runs. */
  preload = 1;
  /** 0x59B728 (word 4: 0 sets it to 1). */
  value4 = 4;
  /** 0x872038 (word 5). */
  value5 = 0;
  /** 0x87203C (word 6, inverted). */
  value6 = 0;
  /** 0x59B764 (word 7: 0, 1, 2, 3 give 1, 2, 3, 0). */
  value7 = 1;
  /** 0x872040 and 0x59B768 (word 8: 0..3 give 3/1, 2/1, 1/1, 0/0). */
  value8 = 0;
  flag8 = 1;
  /** 0x872044 (word 9). */
  value9 = 0;
  /** 0x872048 (word 10). */
  value10 = 0;
  /** 0x87201C (word 12). */
  value12 = 0;
  /** 0x872020 (word 13); it selects 0x872C38/0x872C3C = 0x10/0x1A instead of 0x20/0x15. */
  value13 = 0;
  /** 0x59B71C (word 14). */
  value14 = 1;
  /** 0x872024 (word 15: 0..2). */
  value15 = 0;
  /** 0x8722E0 (word 0x16). */
  value22 = 0;
  /** 0x87204C (word 0x17: 0..3), also read and rewritten by PRODUCT COM 0x38/0x39. */
  value23 = 0;
  /** Words 2 and 3 of 0x466AC0 with 8 = 2 or 3 also clear 0x871FF4 (Direct3D composition). */
  direct = true;

  /** 0x466AC0 applied to the file's words (missing words read as 0). */
  static read(file: Uint8Array): YurisStartupSettings {
    const s = new YurisStartupSettings(),
      data = new Uint8Array(0x80);
    data.set(file.subarray(0, 0x80));
    const view = new DataView(data.buffer),
      w = (n: number): number => view.getInt32(n * 4, true);
    const flag = (n: number, current: number): number => (w(n) === 0 ? 0 : w(n) === 1 ? 1 : current);
    s.value0 = flag(0, s.value0);
    s.value22 = flag(0x16, s.value22);
    s.value1 = flag(1, s.value1);
    s.simd = flag(2, s.simd);
    s.preload = flag(3, s.preload);
    if (w(4) === 0) s.value4 = 1;
    s.value5 = flag(5, s.value5);
    if (w(6) === 0) s.value6 = 1;
    else if (w(6) === 1) s.value6 = 0;
    const seven = [1, 2, 3, 0][w(7)];
    if (seven !== undefined) s.value7 = seven;
    // 0x872000 (never set) would turn word 8 = 0 into 1.
    const eight = w(8);
    if (eight >= 0 && eight <= 3) {
      s.value8 = 3 - eight;
      s.flag8 = eight === 3 ? 0 : 1;
      if (eight >= 2) s.direct = false;
    }
    s.value9 = flag(9, s.value9);
    s.value10 = flag(10, s.value10);
    s.value12 = flag(12, s.value12);
    s.value13 = flag(13, s.value13);
    s.value14 = flag(14, s.value14);
    if (w(15) >= 0 && w(15) <= 2) s.value15 = w(15);
    if (w(0x17) >= 0 && w(0x17) <= 3) s.value23 = w(0x17);
    if (s.flag8 > 1) s.flag8 = 1;
    return s;
  }
}

/** 0x87D380: the message of a missing or unreadable `yscfg.dat` (GBK in the executable). */
export const STARTUP_SETTINGS_MISSING = '无法读取 [ yscfg.dat ] 。';
