use core::ptr::{read_unaligned, write_bytes};
use core::slice;

// The first 256 entries map an eight-bit prefix to a token and its code length,
// or to a node in the following tree. A tree has at most 31 two-way nodes.
const TABLE_ENTRIES: usize = 256 + 62;

struct PacketBits {
    data: *const u8,
    len: usize,
    position: usize,
}

impl PacketBits {
    #[inline]
    unsafe fn peek(&self, count: u32) -> u32 {
        let byte = self.position >> 3;
        if byte >= self.len {
            return 0;
        }
        // The caller pads the packet with three zero bytes. Missing frame data
        // reads as zero, including reads that straddle the packet boundary.
        let word = u32::from_be(read_unaligned(self.data.add(byte).cast()));
        (word << (self.position & 7)) >> (32 - count)
    }

    #[inline]
    unsafe fn read(&mut self, count: u32) -> u32 {
        let value = self.peek(count);
        self.position += count as usize;
        value
    }

    #[inline]
    unsafe fn token(&mut self, table: *const i16) -> u32 {
        let entry = *table.add(self.peek(8) as usize);
        if entry >= 0 {
            self.position += (entry >> 5) as usize;
            return (entry & 31) as u32;
        }
        self.position += 8;
        let mut node = !entry;
        while node >= 0 {
            node = *table.add(256 + node as usize + self.read(1) as usize);
        }
        (!node) as u32
    }
}

#[inline]
unsafe fn end_run(bits: &mut PacketBits, token: u32) -> usize {
    match token {
        0..=2 => token as usize + 1,
        3 => 4 + bits.read(2) as usize,
        4 => 8 + bits.read(3) as usize,
        5 => 16 + bits.read(4) as usize,
        _ => match bits.read(12) as usize {
            0 => usize::MAX,
            run => run,
        },
    }
}

#[inline]
fn signed(value: i16, negative: u32) -> i16 {
    if negative == 0 {
        value
    } else {
        -value
    }
}

// Tokens 9–31 give a zero run and a nonzero coefficient. Sign bits precede
// magnitude and run bits.
#[inline]
unsafe fn coefficient(bits: &mut PacketBits, token: u32) -> (usize, i16) {
    match token {
        9 => (0, 1),
        10 => (0, -1),
        11 => (0, 2),
        12 => (0, -2),
        13..=16 => (0, signed(token as i16 - 10, bits.read(1))),
        17..=22 => {
            let index = (token - 17) as usize;
            let count = [1, 2, 3, 4, 5, 9][index];
            let extra = bits.read(count + 1);
            let magnitude = [7, 9, 13, 21, 37, 69][index] + (extra & ((1 << count) - 1)) as i16;
            (0, signed(magnitude, extra >> count))
        }
        23..=27 => ((token - 22) as usize, signed(1, bits.read(1))),
        28 => {
            let extra = bits.read(3);
            (6 + (extra & 3) as usize, signed(1, extra >> 2))
        }
        29 => {
            let extra = bits.read(4);
            (10 + (extra & 7) as usize, signed(1, extra >> 3))
        }
        30 => {
            let extra = bits.read(2);
            (1, signed(2 + (extra & 1) as i16, extra >> 1))
        }
        _ => {
            let extra = bits.read(3);
            (
                2 + (extra & 1) as usize,
                signed(2 + ((extra >> 1) & 1) as i16, extra >> 2),
            )
        }
    }
}

/// Decode DCT tokens in coded-fragment order, sharing the coefficient buffers
/// with reconstruction. Return false for a run past the end of a block.
#[no_mangle]
pub unsafe extern "C" fn theora_tokens(
    packet: *const u8,
    bytes: usize,
    position: usize,
    tables: *const i16,
    lists: *mut u32,
    luma: usize,
    cb: usize,
    cr: usize,
    coefficients: *mut i16,
    counts: *mut u8,
) -> bool {
    let mut bits = PacketBits {
        data: packet,
        len: bytes,
        position,
    };
    let (luma_list, chroma) = slice::from_raw_parts_mut(lists, luma + cb + cr).split_at_mut(luma);
    let (cb_list, cr_list) = chroma.split_at_mut(cb);
    let mut planes = [luma_list, cb_list, cr_list];
    let mut lengths = [luma, cb, cr];
    for list in &mut planes {
        for entry in list.iter_mut() {
            write_bytes(coefficients.add(*entry as usize * 64), 0, 64);
            // Store the fragment and its next coefficient index together so
            // the pending list can be scanned without a separate indexed load.
            *entry <<= 6;
        }
    }
    let mut end = 0;
    let mut luma_table = 0;
    let mut chroma_table = 0;
    for index in 0..64 {
        if index < 2 {
            luma_table = bits.read(4) as usize;
            chroma_table = bits.read(4) as usize;
        }
        if lengths == [0; 3] {
            break;
        }
        let group = match index {
            0 => 0,
            1..=5 => 1,
            6..=14 => 2,
            15..=27 => 3,
            _ => 4,
        };
        for (plane, list) in planes.iter_mut().enumerate() {
            let table = if plane == 0 { luma_table } else { chroma_table };
            let table = tables.add((group * 16 + table) * TABLE_ENTRIES);
            let mut remaining = 0;
            let list = list.as_mut_ptr();
            for offset in 0..lengths[plane] {
                let entry = *list.add(offset);
                if entry & 63 != index as u32 {
                    *list.add(remaining) = entry;
                    remaining += 1;
                    continue;
                }
                let fragment = (entry >> 6) as usize;
                if end > 0 {
                    end -= 1;
                    *counts.add(fragment) = index as u8;
                    continue;
                }
                let token = bits.token(table);
                if token < 7 {
                    end = end_run(&mut bits, token) - 1;
                    *counts.add(fragment) = index as u8;
                    continue;
                }
                let next = if token < 9 {
                    index + bits.read(if token == 7 { 3 } else { 6 }) as usize + 1
                } else {
                    let (run, value) = coefficient(&mut bits, token);
                    let at = index + run;
                    if at < 64 {
                        *coefficients.add(fragment * 64 + at) = value;
                    }
                    at + 1
                };
                if next < 64 {
                    *list.add(remaining) = (entry & !63) | next as u32;
                    remaining += 1;
                } else if next == 64 {
                    *counts.add(fragment) = 64;
                } else {
                    return false;
                }
            }
            lengths[plane] = remaining;
        }
    }
    true
}
