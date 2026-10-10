//! Bounded diagnostic retention and line framing for temporary Windows commands.
pub(super) const LIMIT: usize = 64 * 1024;

#[derive(Default)]
pub(super) struct Capture {
    pub bytes: Vec<u8>,
    pub truncated: bool,
    pending: Vec<u8>,
    overlong: bool,
}

impl Capture {
    pub fn push(&mut self, bytes: &[u8], log: &mut impl FnMut(&str)) {
        let keep = bytes.len().min(LIMIT - self.bytes.len());
        self.bytes.extend_from_slice(&bytes[..keep]);
        self.truncated |= keep != bytes.len();
        for &byte in bytes {
            if byte == b'\n' {
                self.emit(log);
            } else {
                self.push_byte(byte);
            }
        }
    }

    fn push_byte(&mut self, byte: u8) {
        if self.overlong {
            return;
        }
        if self.pending.len() == LIMIT {
            self.pending.clear();
            self.overlong = true;
            return;
        }
        self.pending.push(byte);
    }

    fn emit(&mut self, log: &mut impl FnMut(&str)) {
        if self.overlong {
            log("[overlong output line omitted]");
        } else {
            let line = String::from_utf8_lossy(&self.pending);
            log(line.strip_suffix('\r').unwrap_or(&line));
        }
        self.pending.clear();
        self.overlong = false;
    }

    pub fn finish(&mut self, log: &mut impl FnMut(&str)) {
        if self.overlong || !self.pending.is_empty() {
            self.emit(log);
        }
    }
}
