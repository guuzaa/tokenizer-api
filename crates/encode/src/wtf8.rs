//! WTF-8 strings, matching JavaScript strings that may hold unpaired surrogates.
//!
//! Byte length equals `TextEncoder` length: an unpaired surrogate is 3 bytes here
//! and `U+FFFD` is 3 bytes in UTF-8.

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Wtf8 {
    bytes: Vec<u8>,
}

impl Wtf8 {
    pub fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    pub fn from_text(value: &str) -> Self {
        Self {
            bytes: value.as_bytes().to_vec(),
        }
    }

    /// Combine well-formed surrogate pairs. Leave unpaired surrogates as themselves.
    pub fn from_utf16(units: &[u16]) -> Self {
        let mut out = Self::new();
        let mut index = 0;
        while index < units.len() {
            let unit = units[index];
            if (0xD800..=0xDBFF).contains(&unit)
                && let Some(&low) = units.get(index + 1)
                && (0xDC00..=0xDFFF).contains(&low)
            {
                let cp = 0x10000 + (((unit as u32 - 0xD800) << 10) | (low as u32 - 0xDC00));
                out.push_code_point(cp);
                index += 2;
                continue;
            }
            out.push_code_point(unit as u32);
            index += 1;
        }
        out
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.bytes
    }

    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    pub fn as_str(&self) -> Option<&str> {
        std::str::from_utf8(&self.bytes).ok()
    }

    pub fn eq_str(&self, value: &str) -> bool {
        self.bytes == value.as_bytes()
    }

    pub fn is_well_formed(&self) -> bool {
        self.as_str().is_some()
    }

    pub fn to_string_lossy(&self) -> String {
        let mut out = String::new();
        for cp in self.code_points() {
            if let Some(ch) = char::from_u32(cp) {
                out.push(ch);
            } else {
                out.push('\u{FFFD}');
            }
        }
        out
    }

    pub fn push_str(&mut self, value: &str) {
        self.bytes.extend_from_slice(value.as_bytes());
    }

    pub fn push_wtf8(&mut self, value: &Wtf8) {
        self.bytes.extend_from_slice(&value.bytes);
    }

    pub fn push_code_point(&mut self, cp: u32) {
        if let Some(ch) = char::from_u32(cp) {
            let mut buf = [0u8; 4];
            self.bytes
                .extend_from_slice(ch.encode_utf8(&mut buf).as_bytes());
            return;
        }
        self.bytes.push((0xE0 | (cp >> 12)) as u8);
        self.bytes.push((0x80 | ((cp >> 6) & 0x3F)) as u8);
        self.bytes.push((0x80 | (cp & 0x3F)) as u8);
    }

    pub fn contains_str(&self, needle: &str) -> bool {
        let needle = needle.as_bytes();
        !needle.is_empty()
            && self
                .bytes
                .windows(needle.len())
                .any(|window| window == needle)
    }

    pub fn code_points(&self) -> CodePoints<'_> {
        CodePoints { rest: &self.bytes }
    }

    pub fn to_utf16(&self) -> Vec<u16> {
        let mut units = Vec::new();
        for cp in self.code_points() {
            if cp <= 0xFFFF {
                units.push(cp as u16);
            } else {
                let v = cp - 0x10000;
                units.push((0xD800 + (v >> 10)) as u16);
                units.push((0xDC00 + (v & 0x3FF)) as u16);
            }
        }
        units
    }

    pub fn utf16_len(&self) -> usize {
        self.code_points()
            .map(|cp| if cp > 0xFFFF { 2 } else { 1 })
            .sum()
    }

    /// JavaScript `String.prototype.slice` on UTF-16 code units. `end` is exclusive.
    pub fn slice_units(&self, start: usize, end: Option<usize>) -> Wtf8 {
        let units = self.to_utf16();
        let end = end.unwrap_or(units.len()).min(units.len());
        let start = start.min(end);
        Wtf8::from_utf16(&units[start..end])
    }

    /// JavaScript `String.prototype.indexOf` for a well-formed needle.
    pub fn find_str(&self, needle: &str) -> Option<usize> {
        if needle.is_empty() {
            return Some(0);
        }
        let hay = self.to_utf16();
        let needle: Vec<u16> = needle.encode_utf16().collect();
        hay.windows(needle.len())
            .position(|window| window == needle.as_slice())
    }
}

impl From<&str> for Wtf8 {
    fn from(value: &str) -> Self {
        Self::from_text(value)
    }
}

impl From<String> for Wtf8 {
    fn from(value: String) -> Self {
        Self {
            bytes: value.into_bytes(),
        }
    }
}

pub struct CodePoints<'a> {
    rest: &'a [u8],
}

impl Iterator for CodePoints<'_> {
    type Item = u32;

    fn next(&mut self) -> Option<u32> {
        let bytes = self.rest;
        if bytes.is_empty() {
            return None;
        }
        let b0 = bytes[0];
        let (cp, width) = if b0 < 0x80 {
            (b0 as u32, 1)
        } else if b0 & 0xE0 == 0xC0 && bytes.len() >= 2 {
            (((b0 as u32 & 0x1F) << 6) | (bytes[1] as u32 & 0x3F), 2)
        } else if b0 & 0xF0 == 0xE0 && bytes.len() >= 3 {
            (
                ((b0 as u32 & 0x0F) << 12)
                    | ((bytes[1] as u32 & 0x3F) << 6)
                    | (bytes[2] as u32 & 0x3F),
                3,
            )
        } else if b0 & 0xF8 == 0xF0 && bytes.len() >= 4 {
            (
                ((b0 as u32 & 0x07) << 18)
                    | ((bytes[1] as u32 & 0x3F) << 12)
                    | ((bytes[2] as u32 & 0x3F) << 6)
                    | (bytes[3] as u32 & 0x3F),
                4,
            )
        } else {
            (0xFFFD, 1)
        };
        self.rest = &bytes[width..];
        Some(cp)
    }
}
