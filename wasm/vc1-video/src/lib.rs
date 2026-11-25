//! Progressive VC-1 pixel kernels, derived from FFmpeg 7.1.1.
//! LGPL-2.1-or-later; see src/formats/vc1/NOTICE and LICENSE for copyright and terms.
//! Host-owned planes and coefficient buffers live in this instance's linear memory.
#![no_std]
use core::arch::wasm32::*;
mod bits;
mod block_support;
mod blocks;
mod tables;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    core::arch::wasm32::unreachable()
}

#[inline(always)]
fn clip(x: i32) -> u8 {
    x.clamp(0, 255) as u8
}
#[inline(always)]
fn tx8(x: [i32; 8], round: i32, shift: u32, bias: i32) -> [i32; 8] {
    let a = 12 * (x[0] + x[4]) + round;
    let b = 12 * (x[0] - x[4]) + round;
    let c = 16 * x[2] + 6 * x[6];
    let d = 6 * x[2] - 16 * x[6];
    let e = 16 * x[1] + 15 * x[3] + 9 * x[5] + 4 * x[7];
    let f = 15 * x[1] - 4 * x[3] - 16 * x[5] - 9 * x[7];
    let g = 9 * x[1] - 16 * x[3] + 4 * x[5] + 15 * x[7];
    let h = 4 * x[1] - 9 * x[3] + 15 * x[5] - 16 * x[7];
    [
        (a + c + e) >> shift,
        (b + d + f) >> shift,
        (b - d + g) >> shift,
        (a - c + h) >> shift,
        (a - c - h + bias) >> shift,
        (b - d - g + bias) >> shift,
        (b + d - f + bias) >> shift,
        (a + c - e + bias) >> shift,
    ]
}
#[inline(always)]
fn tx4(x: [i32; 4], round: i32, shift: u32) -> [i32; 4] {
    let a = 17 * (x[0] + x[2]) + round;
    let b = 17 * (x[0] - x[2]) + round;
    let c = 22 * x[1] + 10 * x[3];
    let d = 22 * x[3] - 10 * x[1];
    [
        (a + c) >> shift,
        (b - d) >> shift,
        (b + d) >> shift,
        (a - c) >> shift,
    ]
}
#[inline(always)]
unsafe fn read8(p: *const i16, step: usize) -> [i32; 8] {
    let mut x = [0; 8];
    for i in 0..8 {
        x[i] = *p.add(i * step) as i32;
    }
    x
}
#[inline(always)]
unsafe fn read4(p: *const i16, step: usize) -> [i32; 4] {
    let mut x = [0; 4];
    for i in 0..4 {
        x[i] = *p.add(i * step) as i32;
    }
    x
}
#[inline(always)]
fn mul(v: v128, n: i32) -> v128 {
    i32x4_mul(v, i32x4_splat(n))
}
#[inline(always)]
fn tx8v(x: [v128; 8], round: i32, shift: u32, bias: i32) -> [v128; 8] {
    let a = i32x4_add(mul(i32x4_add(x[0], x[4]), 12), i32x4_splat(round));
    let b = i32x4_add(mul(i32x4_sub(x[0], x[4]), 12), i32x4_splat(round));
    let c = i32x4_add(mul(x[2], 16), mul(x[6], 6));
    let d = i32x4_sub(mul(x[2], 6), mul(x[6], 16));
    let e = i32x4_add(
        i32x4_add(mul(x[1], 16), mul(x[3], 15)),
        i32x4_add(mul(x[5], 9), mul(x[7], 4)),
    );
    let f = i32x4_sub(
        i32x4_sub(mul(x[1], 15), mul(x[3], 4)),
        i32x4_add(mul(x[5], 16), mul(x[7], 9)),
    );
    let g = i32x4_add(
        i32x4_sub(mul(x[1], 9), mul(x[3], 16)),
        i32x4_add(mul(x[5], 4), mul(x[7], 15)),
    );
    let h = i32x4_sub(
        i32x4_add(mul(x[1], 4), mul(x[5], 15)),
        i32x4_add(mul(x[3], 9), mul(x[7], 16)),
    );
    let ac = i32x4_add(a, c);
    let bd = i32x4_add(b, d);
    let bm = i32x4_sub(b, d);
    let am = i32x4_sub(a, c);
    let r = i32x4_splat(bias);
    [
        i32x4_shr(i32x4_add(ac, e), shift),
        i32x4_shr(i32x4_add(bd, f), shift),
        i32x4_shr(i32x4_add(bm, g), shift),
        i32x4_shr(i32x4_add(am, h), shift),
        i32x4_shr(i32x4_add(i32x4_sub(am, h), r), shift),
        i32x4_shr(i32x4_add(i32x4_sub(bm, g), r), shift),
        i32x4_shr(i32x4_add(i32x4_sub(bd, f), r), shift),
        i32x4_shr(i32x4_add(i32x4_sub(ac, e), r), shift),
    ]
}
#[inline(always)]
fn tx8_pass(rows: [v128; 8], round: i32, shift: u32, bias: i32) -> [v128; 8] {
    let left = tx8v(
        rows.map(|row| i32x4_extend_low_i16x8(row)),
        round,
        shift,
        bias,
    );
    let right = tx8v(
        rows.map(|row| i32x4_extend_high_i16x8(row)),
        round,
        shift,
        bias,
    );
    // Select the low half of each 32-bit lane to wrap to a signed coefficient.
    core::array::from_fn(|i| i16x8_shuffle::<0, 2, 4, 6, 8, 10, 12, 14>(left[i], right[i]))
}

#[inline(always)]
fn transpose_8x8(rows: [v128; 8]) -> [v128; 8] {
    let pairs: [v128; 8] = core::array::from_fn(|i| {
        let a = rows[i & !1];
        let b = rows[(i & !1) + 1];
        if i & 1 == 0 {
            i16x8_shuffle::<0, 8, 1, 9, 2, 10, 3, 11>(a, b)
        } else {
            i16x8_shuffle::<4, 12, 5, 13, 6, 14, 7, 15>(a, b)
        }
    });
    let quads: [v128; 8] = core::array::from_fn(|i| {
        let a = pairs[i & !2];
        let b = pairs[(i & !2) + 2];
        if i & 2 == 0 {
            i32x4_shuffle::<0, 4, 1, 5>(a, b)
        } else {
            i32x4_shuffle::<2, 6, 3, 7>(a, b)
        }
    });
    core::array::from_fn(|i| {
        let pair = (i >> 2) | (i & 2);
        if i & 1 == 0 {
            i64x2_shuffle::<0, 2>(quads[pair], quads[pair + 4])
        } else {
            i64x2_shuffle::<1, 3>(quads[pair], quads[pair + 4])
        }
    })
}

/// Two column passes with signed-16 wrapping and a transpose between them.
#[no_mangle]
pub unsafe extern "C" fn vc1_tx8(block: *mut i16) {
    let rows = core::array::from_fn(|row| v128_load(block.add(row * 8).cast()));
    let columns = transpose_8x8(tx8_pass(rows, 4, 3, 0));
    for (row, pixels) in tx8_pass(columns, 64, 7, 1).into_iter().enumerate() {
        v128_store(block.add(row * 8).cast(), pixels);
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_tx_small(
    dst: *mut u8,
    stride: usize,
    block: *mut i16,
    width: usize,
    height: usize,
) {
    for row in 0..height {
        if width == 8 {
            let y = tx8(read8(block.add(row * 8), 1), 4, 3, 0);
            for i in 0..8 {
                *block.add(row * 8 + i) = y[i] as i16;
            }
        } else {
            let y = tx4(read4(block.add(row * 8), 1), 4, 3);
            for i in 0..4 {
                *block.add(row * 8 + i) = y[i] as i16;
            }
        }
    }
    for col in 0..width {
        if height == 8 {
            let y = tx8(read8(block.add(col), 8), 64, 7, 1);
            for row in 0..8 {
                let p = dst.add(row * stride + col);
                *p = clip(*p as i32 + y[row]);
            }
        } else {
            let y = tx4(read4(block.add(col), 8), 64, 7);
            for row in 0..4 {
                let p = dst.add(row * stride + col);
                *p = clip(*p as i32 + y[row]);
            }
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_tx_dc(
    dst: *mut u8,
    stride: usize,
    width: usize,
    height: usize,
    mut dc: i32,
) {
    if width == 8 {
        dc = (3 * dc + 1) >> 1;
    } else {
        dc = (17 * dc + 4) >> 3;
    }
    dc = if height == 8 {
        if width == 8 {
            (3 * dc + 16) >> 5
        } else {
            (12 * dc + 64) >> 7
        }
    } else {
        (17 * dc + 64) >> 7
    };
    let value = i16x8_splat(dc as i16);
    for row in 0..height {
        let p = dst.add(row * stride);
        let old = u16x8_extend_low_u8x16(v128_load64_zero(p.cast()));
        let sum = i16x8_add_sat(old, value);
        let packed = u8x16_narrow_i16x8(sum, i16x8_splat(0));
        if width == 8 {
            v128_store64_lane::<0>(packed, p.cast());
        } else {
            v128_store32_lane::<0>(packed, p.cast());
        }
    }
}
/// mode 0: unsigned put; 1: signed put; 2: add to prediction.
#[no_mangle]
pub unsafe extern "C" fn vc1_pixels(block: *const i16, dst: *mut u8, stride: usize, mode: i32) {
    for row in 0..8 {
        let mut value = v128_load(block.add(row * 8).cast());
        let p = dst.add(row * stride);
        if mode == 1 {
            value = i16x8_add_sat(value, i16x8_splat(128));
        }
        if mode == 2 {
            value = i16x8_add_sat(value, u16x8_extend_low_u8x16(v128_load64_zero(p.cast())));
        }
        v128_store64_lane::<0>(u8x16_narrow_i16x8(value, i16x8_splat(0)), p.cast());
    }
}
#[inline(always)]
unsafe fn line(p: *mut u8, stride: isize, pq: i32) -> bool {
    let at = |n: isize| *p.offset(n * stride) as i32;
    let m2 = at(-2);
    let m1 = at(-1);
    let p0 = at(0);
    let difference = m1 - p0;
    let c = difference.abs() >> 1;
    if c == 0 {
        return false;
    }
    let p1 = at(1);
    let raw = (2 * (m2 - p1) - 5 * difference + 4) >> 3;
    let a0 = raw.abs();
    if a0 < pq {
        let a1 = ((2 * (at(-4) - m1) - 5 * (at(-3) - m2) + 4) >> 3).abs();
        let a2 = ((2 * (p0 - at(3)) - 5 * (p1 - at(2)) + 4) >> 3).abs();
        let slope = a0 - a1.min(a2);
        if slope > 0 {
            if (raw ^ difference) < 0 {
                let magnitude = ((5 * slope) >> 3).min(c);
                let d = if difference < 0 {
                    -magnitude
                } else {
                    magnitude
                };
                *p.offset(-stride) = (m1 - d) as u8;
                *p = (p0 + d) as u8;
            }
            return true;
        }
    }
    false
}
#[inline(always)]
unsafe fn loop_strided<const N: usize>(p: *mut u8, step: isize, pq: i32) {
    for i in (0..N).step_by(4) {
        let q = p.offset(i as isize * step);
        if line(q.offset(2 * step), 1, pq) {
            line(q, 1, pq);
            line(q.offset(step), 1, pq);
            line(q.offset(3 * step), 1, pq);
        }
    }
}

#[inline(always)]
fn edge_response(outer: v128, inner: v128) -> v128 {
    let twice_outer = i16x8_shl(outer, 1);
    let five_inner = i16x8_mul(inner, i16x8_splat(5));
    i16x8_shr(
        i16x8_add(i16x8_sub(twice_outer, five_inner), i16x8_splat(4)),
        3,
    )
}

#[inline(always)]
unsafe fn loop_contiguous<const N: usize>(p: *mut u8, pitch: isize, pq: i32) {
    let read = |line| {
        let ptr = p.offset(line * pitch);
        let data = if N == 4 {
            v128_load32_zero(ptr.cast())
        } else {
            v128_load64_zero(ptr.cast())
        };
        u16x8_extend_low_u8x16(data)
    };
    let m1 = read(-1);
    let p0 = read(0);
    let difference = i16x8_sub(m1, p0);
    let limit = u16x8_shr(i16x8_abs(difference), 1);
    // A group is filtered only when its third pixel passes the decision.
    let anchors = if N == 4 { 0b0000_0100 } else { 0b0100_0100 };
    let usable = i16x8_gt(limit, i16x8_splat(0));
    if i16x8_bitmask(usable) & anchors == 0 {
        return;
    }
    let m2 = read(-2);
    let p1 = read(1);
    let raw = edge_response(i16x8_sub(m2, p1), difference);
    let a0 = i16x8_abs(raw);
    let eligible = v128_and(usable, i16x8_lt(a0, i16x8_splat(pq as i16)));
    if i16x8_bitmask(eligible) & anchors == 0 {
        return;
    }
    let a1 = edge_response(i16x8_sub(read(-4), m1), i16x8_sub(read(-3), m2));
    let a2 = edge_response(i16x8_sub(p0, read(3)), i16x8_sub(p1, read(2)));
    let slope = i16x8_sub(a0, i16x8_min(i16x8_abs(a1), i16x8_abs(a2)));
    let active = v128_and(eligible, i16x8_gt(slope, i16x8_splat(0)));
    if i16x8_bitmask(active) & anchors == 0 {
        return;
    }
    let group = i16x8_shuffle::<2, 2, 2, 2, 6, 6, 6, 6>(active, active);
    let direction = i16x8_shr(difference, 15);
    let sign_matches = i16x8_shr(v128_xor(raw, difference), 15);
    let mask = v128_and(v128_and(active, group), sign_matches);
    let magnitude = i16x8_min(i16x8_shr(i16x8_mul(slope, i16x8_splat(5)), 3), limit);
    let delta = v128_and(i16x8_sub(v128_xor(magnitude, direction), direction), mask);
    let m = i16x8_sub(m1, delta);
    let q = i16x8_add(p0, delta);
    let packed = u8x16_narrow_i16x8(m, q);
    if N == 4 {
        v128_store32_lane::<0>(packed, p.offset(-pitch).cast());
        v128_store32_lane::<2>(packed, p.cast());
    } else {
        v128_store64_lane::<0>(packed, p.offset(-pitch).cast());
        v128_store64_lane::<1>(packed, p.cast());
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_loop(p: *mut u8, step: isize, stride: isize, length: usize, pq: i32) {
    // Direction and edge length are fixed at each VC-1 call site. Specializing them
    // removes generic address calculations and lets LLVM unroll the 4-pixel groups.
    if step == 1 {
        match length {
            4 => loop_contiguous::<4>(p, stride, pq),
            8 => loop_contiguous::<8>(p, stride, pq),
            _ => {
                loop_contiguous::<8>(p, stride, pq);
                loop_contiguous::<8>(p.add(8), stride, pq);
            }
        }
    } else {
        match length {
            4 => loop_strided::<4>(p, step, pq),
            8 => loop_strided::<8>(p, step, pq),
            _ => loop_strided::<16>(p, step, pq),
        }
    }
}
#[inline(always)]
unsafe fn load_bytes(p: *const u8) -> v128 {
    i32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(p.cast())))
}
#[inline(always)]
unsafe fn write_bytes(p: *mut u8, mut value: v128, avg: bool) {
    value = i32x4_min(i32x4_max(value, i32x4_splat(0)), i32x4_splat(255));
    if avg {
        value = i32x4_shr(
            i32x4_add(i32x4_add(value, load_bytes(p)), i32x4_splat(1)),
            1,
        );
    }
    let packed = u8x16_narrow_i16x8(i16x8_narrow_i32x4(value, i32x4_splat(0)), i16x8_splat(0));
    v128_store32_lane::<0>(packed, p.cast());
}
const MSPEL_COEFFICIENTS: [[i16; 4]; 4] = [
    [0, 1, 0, 0],
    [-4, 53, 18, -3],
    [-1, 9, 9, -1],
    [-3, 18, 53, -4],
];

#[inline(always)]
unsafe fn filter_bytes8(p: *const u8, step: isize, weights: [v128; 4]) -> v128 {
    let load = |at: isize| u16x8_extend_low_u8x16(v128_load64_zero(p.offset(at).cast()));
    // A four-tap sum of unsigned bytes fits in signed 16-bit lanes.
    i16x8_add(
        i16x8_add(
            i16x8_mul(load(-step), weights[0]),
            i16x8_mul(load(0), weights[1]),
        ),
        i16x8_add(
            i16x8_mul(load(step), weights[2]),
            i16x8_mul(load(2 * step), weights[3]),
        ),
    )
}

#[inline(always)]
unsafe fn filter_words4(p: *const i16, w01: v128, w23: v128) -> v128 {
    // After the vertical pass the horizontal sum needs 32-bit lanes.
    let samples = v128_load(p.cast());
    let first = i16x8_shuffle::<0, 1, 1, 2, 2, 3, 3, 4>(samples, samples);
    let last = i16x8_shuffle::<2, 3, 3, 4, 4, 5, 5, 6>(samples, samples);
    i32x4_add(i32x4_dot_i16x8(first, w01), i32x4_dot_i16x8(last, w23))
}

#[inline(always)]
unsafe fn write_mspel8(dst: *mut u8, value: v128, avg: bool) {
    let mut bytes = u8x16_narrow_i16x8(value, value);
    if avg {
        bytes = u8x16_avgr(bytes, v128_load64_zero(dst.cast()));
    }
    v128_store64_lane::<0>(bytes, dst.cast());
}
/// Integral motion needs no interpolation or clipping. Reference and output planes
/// are disjoint; averaging is the unsigned rounded average of corresponding bytes.
#[inline(always)]
unsafe fn copy_block(dst: *mut u8, src: *const u8, stride: usize, w: usize, h: usize, avg: bool) {
    for row in 0..h {
        let d = dst.add(row * stride);
        let s = src.add(row * stride);
        if w == 16 {
            let mut v = v128_load(s.cast());
            if avg {
                v = u8x16_avgr(v, v128_load(d.cast()));
            }
            v128_store(d.cast(), v);
        } else if w == 8 {
            let mut v = v128_load64_zero(s.cast());
            if avg {
                v = u8x16_avgr(v, v128_load64_zero(d.cast()));
            }
            v128_store64_lane::<0>(v, d.cast());
        } else {
            for col in (0..w).step_by(4) {
                let mut v = v128_load32_zero(s.add(col).cast());
                if avg {
                    v = u8x16_avgr(v, v128_load32_zero(d.add(col).cast()));
                }
                v128_store32_lane::<0>(v, d.add(col).cast());
            }
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_mspel(
    dst: *mut u8,
    src: *const u8,
    stride: usize,
    n: usize,
    hm: i32,
    vm: i32,
    rnd: i32,
    avg: bool,
) {
    if hm == 0 && vm == 0 {
        copy_block(dst, src, stride, n, n, avg);
        return;
    }
    if hm != 0 && vm != 0 {
        let shifts = [0, 5, 1, 5];
        let shift = (shifts[hm as usize] + shifts[vm as usize]) >> 1;
        let round = i16x8_splat(((1 << (shift - 1)) + rnd - 1) as i16);
        let vertical = MSPEL_COEFFICIENTS[vm as usize].map(|weight| i16x8_splat(weight));
        let [a, b, c, d] = MSPEL_COEFFICIENTS[hm as usize];
        let w01 = i16x8(a, b, a, b, a, b, a, b);
        let w23 = i16x8(c, d, c, d, c, d, c, d);
        let horizontal_round = i32x4_splat(64 - rnd);
        let mut tmp = [0i16; 20];
        for row in 0..n {
            let input = src.add(row * stride).sub(1);
            let output = dst.add(row * stride);
            let mut vertical_at = |col| {
                let sum = filter_bytes8(input.add(col), stride as isize, vertical);
                v128_store(
                    tmp.as_mut_ptr().add(col).cast(),
                    i16x8_shr(i16x8_add(sum, round), shift),
                );
            };
            for col in (0..n).step_by(8) {
                vertical_at(col);
            }
            // The last load overlaps five pixels and ends at the final border sample.
            vertical_at(n - 5);
            for col in (0..n).step_by(8) {
                let p = tmp.as_ptr().add(col);
                let half =
                    |q| i32x4_shr(i32x4_add(filter_words4(q, w01, w23), horizontal_round), 7);
                write_mspel8(
                    output.add(col),
                    i16x8_narrow_i32x4(half(p), half(p.add(4))),
                    avg,
                );
            }
        }
    } else {
        let (mode, r, step) = if vm != 0 {
            (vm, 1 - rnd, stride as isize)
        } else {
            (hm, rnd, 1)
        };
        let weights = MSPEL_COEFFICIENTS[mode as usize].map(|weight| i16x8_splat(weight));
        let (shift, round) = if mode == 2 { (4, 8 - r) } else { (6, 32 - r) };
        let round = i16x8_splat(round as i16);
        for row in 0..n {
            for col in (0..n).step_by(8) {
                let p = src.add(row * stride + col);
                let shifted = i16x8_shr(i16x8_add(filter_bytes8(p, step, weights), round), shift);
                write_mspel8(dst.add(row * stride + col), shifted, avg);
            }
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_hpel(
    dst: *mut u8,
    src: *const u8,
    stride: usize,
    n: usize,
    dxy: i32,
    no_rnd: bool,
    avg: bool,
) {
    if dxy == 0 {
        copy_block(dst, src, stride, n, n, avg);
        return;
    }
    let r2 = i32x4_splat(if no_rnd { 0 } else { 1 });
    let r4 = i32x4_splat(if no_rnd { 1 } else { 2 });
    for row in 0..n {
        for col in (0..n).step_by(4) {
            let p = src.add(row * stride + col);
            let a = load_bytes(p);
            let v = match dxy {
                1 => i32x4_shr(i32x4_add(i32x4_add(a, load_bytes(p.add(1))), r2), 1),
                2 => i32x4_shr(i32x4_add(i32x4_add(a, load_bytes(p.add(stride))), r2), 1),
                3 => i32x4_shr(
                    i32x4_add(
                        i32x4_add(a, load_bytes(p.add(1))),
                        i32x4_add(
                            i32x4_add(load_bytes(p.add(stride)), load_bytes(p.add(stride + 1))),
                            r4,
                        ),
                    ),
                    2,
                ),
                _ => a,
            };
            write_bytes(dst.add(row * stride + col), v, avg);
        }
    }
}
#[no_mangle]
pub unsafe extern "C" fn vc1_chroma(
    dst: *mut u8,
    src: *const u8,
    stride: usize,
    w: usize,
    h: usize,
    x: i32,
    y: i32,
    no_rnd: bool,
    avg: bool,
) {
    if x == 0 && y == 0 {
        copy_block(dst, src, stride, w, h, avg);
        return;
    }
    let a = (8 - x) * (8 - y);
    let b = x * (8 - y);
    let c = (8 - x) * y;
    let d = x * y;
    let r = i32x4_splat(if no_rnd { 28 } else { 32 });
    for row in 0..h {
        for col in (0..w).step_by(4) {
            let p = src.add(row * stride + col);
            let v = i32x4_add(
                i32x4_add(mul(load_bytes(p), a), mul(load_bytes(p.add(1)), b)),
                i32x4_add(
                    mul(load_bytes(p.add(stride)), c),
                    mul(load_bytes(p.add(stride + 1)), d),
                ),
            );
            write_bytes(
                dst.add(row * stride + col),
                i32x4_shr(i32x4_add(v, r), 6),
                avg,
            );
        }
    }
}
