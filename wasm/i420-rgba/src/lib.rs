#![no_std]
use core::arch::wasm32::*;

#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    unreachable()
}

/// One row of the centered bilinear sample, with the vertical weights applied.
struct ChromaRow {
    near: *const u8,
    far: *const u8,
    width: usize,
}

impl ChromaRow {
    #[inline]
    unsafe fn column(&self, column: usize) -> i32 {
        3 * i32::from(*self.near.add(column)) + i32::from(*self.far.add(column))
    }

    #[inline]
    unsafe fn sample(&self, x: usize) -> i32 {
        let column = x / 2;
        let other = if x & 1 == 0 {
            column.saturating_sub(1)
        } else {
            (column + 1).min(self.width - 1)
        };
        3 * self.column(column) + self.column(other)
    }

    #[inline]
    unsafe fn samples8(&self, column: usize) -> v128 {
        let near = u16x8_extend_low_u8x16(v128_load64_zero(self.near.add(column - 1).cast()));
        let far = u16x8_extend_low_u8x16(v128_load64_zero(self.far.add(column - 1).cast()));
        let vertical = i16x8_add(i16x8_mul(near, i16x8_splat(3)), far);
        let center = i16x8_shuffle::<1, 1, 2, 2, 3, 3, 4, 4>(vertical, vertical);
        let adjacent = i16x8_shuffle::<0, 2, 1, 3, 2, 4, 3, 5>(vertical, vertical);
        i16x8_add(i16x8_mul(center, i16x8_splat(3)), adjacent)
    }
}

#[inline]
fn byte<const BGRA: bool>(v: f64) -> u8 {
    let lower = v as u8;
    let fraction = v - f64::from(lower);
    if fraction == 0.5 && BGRA {
        lower.saturating_add(lower & 1)
    } else {
        lower.saturating_add(u8::from(fraction >= 0.5))
    }
}

#[inline]
fn pixel<const BGRA: bool>(y: u8, cb16: i32, cr16: i32) -> [u8; 4] {
    let l = ((f64::from(y) - 16.0) * 255.0) / 219.0;
    let b = ((f64::from(cb16) / 16.0 - 128.0) * 255.0) / 224.0;
    let r = ((f64::from(cr16) / 16.0 - 128.0) * 255.0) / 224.0;
    let red = byte::<BGRA>(l + 1.402 * r);
    let green = byte::<BGRA>(l - 0.344136 * b - 0.714136 * r);
    let blue = byte::<BGRA>(l + 1.772 * b);
    if BGRA {
        [blue, green, red, 255]
    } else {
        [red, green, blue, 255]
    }
}

const SHIFT: u32 = 22;
const SCALE: i64 = 1 << SHIFT;
const LUMA: i32 = ((255 * SCALE + 219 / 2) / 219) as i32;

const fn chroma_factor(millionths: i64) -> i32 {
    let divisor = 224 * 16 * 1_000_000;
    ((millionths * 255 * SCALE + divisor / 2) / divisor) as i32
}

#[inline]
fn convert4(y: v128, cb16: v128, cr16: v128) -> ([v128; 3], u8) {
    let mul = |v, k| i32x4_mul(v, i32x4_splat(k));
    // Center output at 128 to keep the widest blue result in signed 32 bits.
    let l = i32x4_add(
        mul(i32x4_sub(y, i32x4_splat(16)), LUMA),
        i32x4_splat((SCALE / 2 - SCALE * 128) as i32),
    );
    let b = i32x4_sub(cb16, i32x4_splat(128 * 16));
    let r = i32x4_sub(cr16, i32x4_splat(128 * 16));
    let red = i32x4_add(l, mul(r, chroma_factor(1_402_000)));
    let green = i32x4_sub(
        i32x4_sub(l, mul(b, chroma_factor(344_136))),
        mul(r, chroma_factor(714_136)),
    );
    let blue = i32x4_add(l, mul(b, chroma_factor(1_772_000)));
    // Each coefficient contributes at most half a fixed-point unit of
    // error per input unit. The sum is bounded by (239 + 2048 + 2048) / 2.
    // Resolve pixels near a byte boundary with double-precision arithmetic.
    let near_half = |v| {
        let distance = v128_and(
            i32x4_add(v, i32x4_splat(2200)),
            i32x4_splat((SCALE - 1) as i32),
        );
        i32x4_lt(distance, i32x4_splat(4400))
    };
    let ties = i32x4_bitmask(v128_or(
        v128_or(near_half(red), near_half(green)),
        near_half(blue),
    ));
    let channel = |v| i32x4_add(i32x4_shr(v, SHIFT), i32x4_splat(128));
    ([channel(red), channel(green), channel(blue)], ties)
}

unsafe fn convert<const BGRA: bool>(
    output: *mut u8,
    y: *const u8,
    cb: *const u8,
    cr: *const u8,
    width: usize,
    height: usize,
    stride: usize,
    padded_height: usize,
) {
    let cw = stride / 2;
    let ch = padded_height / 2;
    for row in 0..height {
        let near = row / 2;
        let far = if row & 1 == 0 {
            near.saturating_sub(1)
        } else {
            (near + 1).min(ch - 1)
        };
        let cb = ChromaRow {
            near: cb.add(near * cw),
            far: cb.add(far * cw),
            width: cw,
        };
        let cr = ChromaRow {
            near: cr.add(near * cw),
            far: cr.add(far * cw),
            width: cw,
        };
        let y = y.add(row * stride);
        let out = output.add(row * width * 4);
        let write_pixel = |x: usize| {
            let bytes = pixel::<BGRA>(*y.add(x), cb.sample(x), cr.sample(x));
            out.add(x * 4).cast::<[u8; 4]>().write(bytes);
        };
        let mut x = 0;
        while x < width.min(2) {
            write_pixel(x);
            x += 1;
        }
        while x + 8 <= width && x / 2 + 6 < cw {
            let l = u16x8_extend_low_u8x16(v128_load64_zero(y.add(x).cast()));
            let b = cb.samples8(x / 2);
            let r = cr.samples8(x / 2);
            let low = u32x4_extend_low_u16x8;
            let high = u32x4_extend_high_u16x8;
            let (left, left_ties) = convert4(low(l), low(b), low(r));
            let (right, right_ties) = convert4(high(l), high(b), high(r));
            let red = i16x8_narrow_i32x4(left[0], right[0]);
            let green = i16x8_narrow_i32x4(left[1], right[1]);
            let blue = i16x8_narrow_i32x4(left[2], right[2]);
            let (first, third) = if BGRA { (blue, red) } else { (red, blue) };
            let fg = u8x16_narrow_i16x8(first, green);
            let ta = u8x16_narrow_i16x8(third, i16x8_splat(255));
            let pixels0 =
                u8x16_shuffle::<0, 8, 16, 24, 1, 9, 17, 25, 2, 10, 18, 26, 3, 11, 19, 27>(fg, ta);
            let pixels1 =
                u8x16_shuffle::<4, 12, 20, 28, 5, 13, 21, 29, 6, 14, 22, 30, 7, 15, 23, 31>(fg, ta);
            v128_store(out.add(x * 4).cast(), pixels0);
            v128_store(out.add(x * 4 + 16).cast(), pixels1);
            let mut ties = left_ties | (right_ties << 4);
            while ties != 0 {
                write_pixel(x + ties.trailing_zeros() as usize);
                ties &= ties - 1;
            }
            x += 8;
        }
        while x < width {
            write_pixel(x);
            x += 1;
        }
    }
}

/// Convert validated, top-down 4:2:0 planes to opaque, top-down pixels.
#[no_mangle]
unsafe extern "C" fn i420_rgba(
    output: *mut u8,
    y: *const u8,
    cb: *const u8,
    cr: *const u8,
    width: usize,
    height: usize,
    stride: usize,
    padded_height: usize,
    bgra: bool,
) {
    if bgra {
        convert::<true>(output, y, cb, cr, width, height, stride, padded_height);
    } else {
        convert::<false>(output, y, cb, cr, width, height, stride, padded_height);
    }
}
