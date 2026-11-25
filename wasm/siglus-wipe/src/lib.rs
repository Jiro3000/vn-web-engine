use core::{ptr::write_bytes, slice};

fn round(value: f64) -> i32 {
    let floor = value.floor();
    (floor as i32) + i32::from(value - floor >= 0.5)
}

/// Fill the inclusive scanlines of the fan triangles in draw order.
///
/// # Safety
/// The output must hold `width * height` pixels. Each triangle must have
/// space for three x/y pairs and a level. The two buffers must be disjoint.
#[no_mangle]
pub unsafe extern "C" fn siglus_fan_wipe(
    output: *mut u8,
    width: i32,
    height: i32,
    triangles: *const [i32; 7],
    count: usize,
) {
    write_bytes(output, 0, width as usize * height as usize);
    for &[ax, ay, bx, by, cx, cy, level] in slice::from_raw_parts(triangles, count) {
        let top = ay.min(by).min(cy).max(0);
        let bottom = ay.max(by).max(cy).min(height - 1);
        let edges = [(ax, ay, bx, by), (bx, by, cx, cy), (cx, cy, ax, ay)];
        for y in top..=bottom {
            let mut left = f64::from(width);
            let mut right = -1.0_f64;
            for (x0, y0, x1, y1) in edges {
                if y < y0.min(y1) || y > y0.max(y1) {
                    continue;
                }
                if y0 == y1 {
                    left = left.min(f64::from(x0.min(x1)));
                    right = right.max(f64::from(x0.max(x1)));
                } else {
                    let x =
                        f64::from(x0) + f64::from(x1 - x0) * f64::from(y - y0) / f64::from(y1 - y0);
                    left = left.min(x);
                    right = right.max(x);
                }
            }
            let left = round(left).max(0);
            let right = round(right).min(width - 1);
            if right >= left {
                let start = (y * width + left) as usize;
                write_bytes(output.add(start), level as u8, (right - left + 1) as usize);
            }
        }
    }
}
