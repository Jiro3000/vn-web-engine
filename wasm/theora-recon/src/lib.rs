use core::arch::wasm32::*;
use core::ptr::copy_nonoverlapping;

mod tokens;

#[inline]
unsafe fn load_four(bytes: *const u8) -> v128 {
    u32x4_extend_low_u16x8(u16x8_extend_low_u8x16(v128_load32_zero(bytes.cast())))
}

#[inline]
fn byte_lanes(lanes: v128) -> v128 {
    i32x4_min(i32x4_max(lanes, i32x4_splat(0)), i32x4_splat(255))
}

#[inline]
fn rgb601(y: f64, cb: f64, cr: f64) -> [u8; 4] {
    [
        (y + 1.402 * cr).round_ties_even() as u8,
        (y - 0.34414 * cb - 0.71414 * cr).round_ties_even() as u8,
        (y + 1.772 * cb).round_ties_even() as u8,
        255,
    ]
}

#[inline]
unsafe fn full_range_row(
    out: *mut u8,
    first: *const u8,
    second: *const u8,
    third: *const u8,
    width: usize,
) {
    let mut col = 0;
    while col + 4 <= width {
        let y = load_four(first.add(col));
        let cb = i32x4_sub(load_four(second.add(col)), i32x4_splat(128));
        let cr = i32x4_sub(load_four(third.add(col)), i32x4_splat(128));
        let fy = f32x4_convert_i32x4(y);
        let red = f32x4_add(fy, f32x4_mul(f32x4_splat(1.402), f32x4_convert_i32x4(cr)));
        let blue = f32x4_add(fy, f32x4_mul(f32x4_splat(1.772), f32x4_convert_i32x4(cb)));
        // Use the exact integer chroma adjustment before rounding. Its only two
        // half values need the original double-precision evaluation order.
        let green_offset = i32x4_add(
            i32x4_mul(cb, i32x4_splat(-34414)),
            i32x4_mul(cr, i32x4_splat(-71414)),
        );
        let green = i32x4_add(
            y,
            i32x4_trunc_sat_f32x4(f32x4_nearest(f32x4_mul(
                f32x4_convert_i32x4(green_offset),
                f32x4_splat(0.00001),
            ))),
        );
        let r = byte_lanes(i32x4_trunc_sat_f32x4(f32x4_nearest(red)));
        let g = i32x4_shl(byte_lanes(green), 8);
        let b = i32x4_shl(byte_lanes(i32x4_trunc_sat_f32x4(f32x4_nearest(blue))), 16);
        let rgba = v128_or(v128_or(r, g), v128_or(b, u32x4_splat(0xff000000)));
        v128_store(out.add(col * 4).cast(), rgba);
        let mut ties = i32x4_bitmask(i32x4_eq(i32x4_abs(green_offset), i32x4_splat(1850000)));
        while ties != 0 {
            let pixel = col + ties.trailing_zeros() as usize;
            let y = *first.add(pixel) as f64;
            let cb = *second.add(pixel) as f64 - 128.0;
            let cr = *third.add(pixel) as f64 - 128.0;
            *out.add(pixel * 4 + 1) = rgb601(y, cb, cr)[1];
            ties &= ties - 1;
        }
        col += 4;
    }
    for col in col..width {
        let rgba = rgb601(
            *first.add(col) as f64,
            *second.add(col) as f64 - 128.0,
            *third.add(col) as f64 - 128.0,
        );
        copy_nonoverlapping(rgba.as_ptr(), out.add(col * 4), 4);
    }
}

#[inline]
unsafe fn bgr_row(
    out: *mut u8,
    b: *const u8,
    g: *const u8,
    r: *const u8,
    alpha: Option<*const u8>,
    width: usize,
) {
    let mut col = 0;
    while col + 16 <= width {
        let r = v128_load(r.add(col).cast());
        let g = v128_load(g.add(col).cast());
        let b = v128_load(b.add(col).cast());
        let a = alpha.map_or(u8x16_splat(255), |a| v128_load(a.add(col).cast()));
        let rg0 = u8x16_shuffle::<0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23>(r, g);
        let rg1 =
            u8x16_shuffle::<8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31>(r, g);
        let ba0 = u8x16_shuffle::<0, 16, 1, 17, 2, 18, 3, 19, 4, 20, 5, 21, 6, 22, 7, 23>(b, a);
        let ba1 =
            u8x16_shuffle::<8, 24, 9, 25, 10, 26, 11, 27, 12, 28, 13, 29, 14, 30, 15, 31>(b, a);
        let packed = [
            u8x16_shuffle::<0, 1, 16, 17, 2, 3, 18, 19, 4, 5, 20, 21, 6, 7, 22, 23>(rg0, ba0),
            u8x16_shuffle::<8, 9, 24, 25, 10, 11, 26, 27, 12, 13, 28, 29, 14, 15, 30, 31>(rg0, ba0),
            u8x16_shuffle::<0, 1, 16, 17, 2, 3, 18, 19, 4, 5, 20, 21, 6, 7, 22, 23>(rg1, ba1),
            u8x16_shuffle::<8, 9, 24, 25, 10, 11, 26, 27, 12, 13, 28, 29, 14, 15, 30, 31>(rg1, ba1),
        ];
        for (index, pixels) in packed.into_iter().enumerate() {
            v128_store(out.add(col * 4 + index * 16).cast(), pixels);
        }
        col += 16;
    }
    for col in col..width {
        let a = alpha.map_or(255, |p| *p.add(col));
        let rgba = [*r.add(col), *g.add(col), *b.add(col), a];
        copy_nonoverlapping(rgba.as_ptr(), out.add(col * 4), 4);
    }
}

/// Convert validated 4:4:4 OMV planes to a top-down RGBA frame.
#[no_mangle]
unsafe extern "C" fn theora_rgba(
    output: *mut u8,
    first: *const u8,
    second: *const u8,
    third: *const u8,
    stride: usize,
    x: usize,
    bottom: usize,
    width: usize,
    height: usize,
    mode: u32,
) {
    let planes = [first, second, third];
    let alpha_rows = height.div_ceil(3);
    for row in 0..height {
        let dest = output.add(row * width * 4);
        let source = (bottom - row) * stride + x;
        let [first, second, third] = planes.map(|plane| plane.add(source));
        if mode == 2 {
            full_range_row(dest, first, second, third, width);
        } else {
            let alpha = (mode == 1).then(|| {
                let offset = (bottom - height - row % alpha_rows) * stride + x;
                planes[row / alpha_rows].add(offset)
            });
            bgr_row(dest, first, second, third, alpha, width);
        }
    }
}

const INTRA: u8 = 1;
const GOLDEN_NO_MV: u8 = 5;
const GOLDEN_MV: u8 = 6;
const PREDICTORS: [[i32; 5]; 16] = [
    [0, 0, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 1, 0, 0, 1],
    [1, 0, 0, 0, 1],
    [0, 0, 1, 0, 1],
    [1, 0, 1, 0, 2],
    [0, 0, 1, 0, 1],
    [29, -26, 29, 0, 32],
    [0, 0, 0, 1, 1],
    [75, 0, 0, 53, 128],
    [0, 1, 0, 1, 2],
    [75, 0, 0, 53, 128],
    [0, 0, 1, 0, 1],
    [75, 0, 0, 53, 128],
    [0, 3, 10, 3, 16],
    [29, -26, 29, 0, 32],
];
const ZIGZAG: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

#[repr(C)]
struct Fragments {
    coded: *const u8,
    mode: *const u8,
    motion_x: *const i8,
    motion_y: *const i8,
    qi_index: *const u8,
    coefficients: *const i16,
    count: *const u8,
    dc: *mut i16,
}

#[inline]
fn reference(mode: u8) -> usize {
    match mode {
        INTRA => 0,
        GOLDEN_NO_MV | GOLDEN_MV => 2,
        _ => 1,
    }
}

unsafe fn predict_dc(flags: &Fragments, origin: usize, cols: usize, rows: usize) {
    let mut last = [0i32; 3];
    for y in 0..rows {
        for x in 0..cols {
            let at = origin + y * cols + x;
            if *flags.coded.add(at) == 0 {
                continue;
            }
            let frame = reference(*flags.mode.add(at));
            let mut neighbours = 0;
            let mut value = |present: bool, index: usize, flag: usize| {
                if present
                    && *flags.coded.add(index) != 0
                    && reference(*flags.mode.add(index)) == frame
                {
                    neighbours |= flag;
                    *flags.dc.add(index) as i32
                } else {
                    0
                }
            };
            let l = value(x > 0, at.wrapping_sub(1), 1);
            let dl = value(y > 0 && x > 0, at.wrapping_sub(cols + 1), 2);
            let d = value(y > 0, at.wrapping_sub(cols), 4);
            let dr = value(y > 0 && x + 1 < cols, at.wrapping_sub(cols - 1), 8);
            let prediction = if neighbours == 0 {
                last[frame]
            } else {
                let [wl, wdl, wd, wdr, divisor] = PREDICTORS[neighbours];
                let prediction = (wl * l + wdl * dl + wd * d + wdr * dr) / divisor;
                if neighbours & 7 != 7 {
                    prediction
                } else if (prediction - d).abs() > 128 {
                    d
                } else if (prediction - l).abs() > 128 {
                    l
                } else if (prediction - dl).abs() > 128 {
                    dl
                } else {
                    prediction
                }
            };
            let dc = (*flags.coefficients.add(at * 64) as i32 + prediction) as i16;
            *flags.dc.add(at) = dc;
            last[frame] = dc as i32;
        }
    }
}

#[inline]
unsafe fn filter_columns(mut at: *mut u8, stride: usize, limit: i32) {
    for _ in 0..8 {
        let p = *at.add(1) as i32;
        let q = *at.add(2) as i32;
        let r = (*at as i32 - *at.add(3) as i32 + 3 * (q - p) + 4) >> 3;
        let magnitude = r.abs().min((2 * limit - r.abs()).max(0));
        let f = if r < 0 { -magnitude } else { magnitude };
        *at.add(1) = (p + f).clamp(0, 255) as u8;
        *at.add(2) = (q - f).clamp(0, 255) as u8;
        at = at.wrapping_add(stride);
    }
}

#[inline]
unsafe fn filter_rows(at: *mut u8, stride: usize, limit: i32) {
    let load = |row| u16x8_extend_low_u8x16(v128_load64_zero(at.add(row * stride).cast()));
    let p = load(1);
    let q = load(2);
    let r = i16x8_shr(
        i16x8_add(
            i16x8_sub(load(0), load(3)),
            i16x8_add(i16x8_mul(i16x8_sub(q, p), i16x8_splat(3)), i16x8_splat(4)),
        ),
        3,
    );
    let abs = i16x8_abs(r);
    let magnitude = i16x8_min(
        abs,
        i16x8_max(
            i16x8_sub(i16x8_splat((2 * limit) as i16), abs),
            i16x8_splat(0),
        ),
    );
    let f = v128_bitselect(i16x8_neg(magnitude), magnitude, i16x8_shr(r, 15));
    let p = i16x8_add(p, f);
    let q = i16x8_sub(q, f);
    v128_store64_lane::<0>(u8x16_narrow_i16x8(p, p), at.add(stride).cast());
    v128_store64_lane::<0>(u8x16_narrow_i16x8(q, q), at.add(2 * stride).cast());
}

unsafe fn loop_filter(output: *mut u8, coded: *const u8, width: usize, height: usize, limit: i32) {
    let cols = width / 8;
    let rows = height / 8;
    for y in 0..rows {
        for x in 0..cols {
            let fragment = coded.add(y * cols + x);
            if *fragment == 0 {
                continue;
            }
            let at = output.add((y * width + x) * 8);
            if x > 0 {
                filter_columns(at.sub(2), width, limit);
            }
            if y > 0 {
                filter_rows(at.sub(2 * width), width, limit);
            }
            if x + 1 < cols && *fragment.add(1) == 0 {
                filter_columns(at.add(6), width, limit);
            }
            if y + 1 < rows && *fragment.add(cols) == 0 {
                filter_rows(at.add(6 * width), width, limit);
            }
        }
    }
}

#[inline]
fn mul_shift(constant: i32, value: i32) -> i32 {
    constant.wrapping_mul(value) >> 16
}

#[inline]
fn short(value: i32) -> i32 {
    value as i16 as i32
}

// The same truncated 1-D transform as the portable decoder. The destination is
// transposed, so the second pass writes a raster-ordered block.
#[inline]
fn idct8(output: &mut [i16; 64], column: usize, input: &[i16; 64], row: usize) {
    let [x0, x1, x2, x3, x4, x5, x6, x7] = (*input)[row * 8..row * 8 + 8]
        .try_into()
        .map(|row: [i16; 8]| row.map(i32::from))
        .unwrap();
    let t0 = mul_shift(46341, short(x0 + x4));
    let t1 = mul_shift(46341, short(x0 - x4));
    let t2 = mul_shift(25080, x2) - mul_shift(60547, x6);
    let t3 = mul_shift(60547, x2) + mul_shift(25080, x6);
    let t4 = mul_shift(12785, x1) - mul_shift(64277, x7);
    let t5 = mul_shift(54491, x5) - mul_shift(36410, x3);
    let t6 = mul_shift(36410, x5) + mul_shift(54491, x3);
    let t7 = mul_shift(64277, x1) + mul_shift(12785, x7);
    let x4 = t4 + t5;
    let x7 = t7 + t6;
    let x5 = mul_shift(46341, short(t4 - t5));
    let x6 = mul_shift(46341, short(t7 - t6));
    let x0 = t0 + t3;
    let x3 = t0 - t3;
    let x1 = t1 + t2;
    let x2 = t1 - t2;
    let t6 = x6 + x5;
    let t5 = x6 - x5;
    let out = [
        x0 + x7,
        x1 + t6,
        x2 + t5,
        x3 + x4,
        x3 - x4,
        x2 - t5,
        x1 - t6,
        x0 - x7,
    ];
    for (index, value) in out.into_iter().enumerate() {
        output[index * 8 + column] = value as i16;
    }
}

#[inline]
fn motion(value: i32, divisor: i32) -> (i32, i32) {
    let first = value / divisor;
    let second = first
        + if value % divisor == 0 {
            0
        } else {
            value.signum()
        };
    (first, second)
}

#[inline]
unsafe fn load_row(source: *const u8, width: usize, x: i32, y: usize) -> v128 {
    let row = source.add(y * width);
    if x >= 0 && x as usize + 8 <= width {
        return v128_load64_zero(row.add(x as usize).cast());
    }
    let mut edge = [0u8; 8];
    for (column, pixel) in edge.iter_mut().enumerate() {
        *pixel = *row.add((x + column as i32).clamp(0, width as i32 - 1) as usize);
    }
    v128_load64_zero(edge.as_ptr().cast())
}

/// Reconstruct one plane from validated, raster-ordered Theora fragment metadata.
/// Pixel buffers have width stride and do not alias. For intra frames, references
/// may be null. Quantizers are laid out as [intra/inter][qi][frequency] for this plane.
#[no_mangle]
unsafe extern "C" fn theora_reconstruct(
    output: *mut u8,
    previous: *const u8,
    golden: *const u8,
    width: usize,
    height: usize,
    first_fragment: usize,
    divisors: u32,
    flags: *const Fragments,
    quantizers: *const u16,
    qis: u32,
    filter_limit: i32,
) {
    let flags = &*flags;
    predict_dc(flags, first_fragment, width / 8, height / 8);
    let x_divisor = (divisors & 0xff) as i32;
    let y_divisor = (divisors >> 8) as i32;
    let qi0 = (qis & 63) as usize;
    let intra = previous.is_null();
    if !intra {
        copy_nonoverlapping(previous, output, width * height);
    }
    let mut input = [0i16; 64];
    let mut columns = [0i16; 64];
    let mut residual = [0i16; 64];
    let mut fragment = first_fragment;
    for y in (0..height).step_by(8) {
        for x in (0..width).step_by(8) {
            let current = fragment;
            fragment += 1;
            if *flags.coded.add(current) == 0 {
                continue;
            }
            let mode = *flags.mode.add(current);
            let is_intra = mode == INTRA;
            let matrices = quantizers.add(if is_intra { 0 } else { 64 * 64 });
            let dc = *flags.dc.add(current) as i32 * *matrices.add(qi0 * 64) as i32;
            let count = *flags.count.add(current) as usize;
            let dc_only = count < 2;
            let dc_residual = ((dc + 15) >> 5) as i16;
            let mut single = i16x8_splat(dc_residual);
            if !dc_only {
                input.fill(0);
                input[0] = dc as i16;
                let qi_index = *flags.qi_index.add(current) as u32;
                let qi = ((qis >> (qi_index * 6)) & 63) as usize;
                let ac = matrices.add(qi * 64);
                let coefficients = flags.coefficients.add(current * 64);
                for (index, &frequency) in ZIGZAG.iter().enumerate().take(count).skip(1) {
                    input[frequency] =
                        ((*coefficients.add(index) as i32) * (*ac.add(frequency) as i32)) as i16;
                }
                for row in 0..8 {
                    idct8(&mut columns, row, &input, row);
                }
                for row in 0..8 {
                    idct8(&mut residual, row, &columns, row);
                }
                // Widen before the rounding add, preserving the portable decoder
                // even when the signed 16-bit IDCT output is close to its limit.
                for value in &mut residual {
                    *value = ((*value as i32 + 8) >> 4) as i16;
                }
            }
            let dest = output.add(y * width + x);
            if is_intra {
                let bias = i16x8_splat(128);
                single = i16x8_add_sat(single, bias);
                for row in 0..8 {
                    let samples = if dc_only {
                        single
                    } else {
                        i16x8_add_sat(v128_load(residual.as_ptr().add(row * 8).cast()), bias)
                    };
                    v128_store64_lane::<0>(
                        u8x16_narrow_i16x8(samples, samples),
                        dest.add(row * width).cast(),
                    );
                }
                continue;
            }
            let reference = if reference(mode) == 2 {
                golden
            } else {
                previous
            };
            let (x0, x1) = motion(*flags.motion_x.add(current) as i32, x_divisor);
            let (y0, y1) = motion(*flags.motion_y.add(current) as i32, y_divisor);
            let two = x0 != x1 || y0 != y1;
            if !two && x0 == 0 && y0 == 0 && dc_only && dc_residual == 0 && reference == previous {
                continue;
            }
            for row in 0..8 {
                let sy = (y + row) as i32;
                let first = load_row(
                    reference,
                    width,
                    x as i32 + x0,
                    (sy + y0).clamp(0, height as i32 - 1) as usize,
                );
                let mut prediction = u16x8_extend_low_u8x16(first);
                if two {
                    let second = load_row(
                        reference,
                        width,
                        x as i32 + x1,
                        (sy + y1).clamp(0, height as i32 - 1) as usize,
                    );
                    prediction =
                        u16x8_shr(u16x8_add(prediction, u16x8_extend_low_u8x16(second)), 1);
                }
                let delta = if dc_only {
                    single
                } else {
                    v128_load(residual.as_ptr().add(row * 8).cast())
                };
                let samples = i16x8_add_sat(prediction, delta);
                v128_store64_lane::<0>(
                    u8x16_narrow_i16x8(samples, samples),
                    dest.add(row * width).cast(),
                );
            }
        }
    }
    if filter_limit != 0 {
        loop_filter(
            output,
            flags.coded.add(first_fragment),
            width,
            height,
            filter_limit,
        );
    }
}
