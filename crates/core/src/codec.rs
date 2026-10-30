//! Reading the chain's byte layouts (ADR 0011): fields one after another, integers big-endian and
//! fixed width. Writing needs no helper: `bytes.extend_from_slice(&n.to_be_bytes())`.

use crate::{ADDRESS_LEN, Address, Error};

/// Reads fields front to back. Running out is `Truncated`, and `finish` refuses leftovers, so a
/// layout is read exactly or not at all.
pub struct Reader<'a> {
    rest: &'a [u8],
}

impl<'a> Reader<'a> {
    pub fn new(bytes: &'a [u8]) -> Self {
        Reader { rest: bytes }
    }

    pub fn bytes(&mut self, len: usize) -> Result<&'a [u8], Error> {
        let (field, rest) = self.rest.split_at_checked(len).ok_or(Error::Truncated)?;
        self.rest = rest;
        Ok(field)
    }

    pub fn array<const N: usize>(&mut self) -> Result<[u8; N], Error> {
        Ok(self.bytes(N)?.try_into().expect("bytes(N) returns N bytes"))
    }

    pub fn u8(&mut self) -> Result<u8, Error> {
        Ok(u8::from_be_bytes(self.array()?))
    }

    pub fn u32(&mut self) -> Result<u32, Error> {
        Ok(u32::from_be_bytes(self.array()?))
    }

    pub fn u64(&mut self) -> Result<u64, Error> {
        Ok(u64::from_be_bytes(self.array()?))
    }

    pub fn address(&mut self) -> Result<Address, Error> {
        Address::from_bytes(&self.array::<ADDRESS_LEN>()?)
    }

    pub fn finish(self) -> Result<(), Error> {
        if self.rest.is_empty() {
            Ok(())
        } else {
            Err(Error::TrailingBytes)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SEED_LEN, SigningKey};

    #[test]
    fn reads_fields_in_order() {
        let address = SigningKey::from_seed(&[7u8; SEED_LEN]).address();
        let mut bytes = vec![0xab];
        bytes.extend_from_slice(&0x0102_0304u32.to_be_bytes());
        bytes.extend_from_slice(&u64::MAX.to_be_bytes());
        bytes.extend_from_slice(&address.to_bytes());
        bytes.extend_from_slice(b"memo");

        let mut reader = Reader::new(&bytes);
        assert_eq!(reader.u8(), Ok(0xab));
        assert_eq!(reader.u32(), Ok(0x0102_0304));
        assert_eq!(reader.u64(), Ok(u64::MAX));
        assert_eq!(reader.address(), Ok(address));
        assert_eq!(reader.bytes(4), Ok(&b"memo"[..]));
        assert_eq!(reader.finish(), Ok(()));
    }

    #[test]
    fn integers_are_big_endian() {
        assert_eq!(Reader::new(&[0, 0, 0, 1]).u32(), Ok(1));
        assert_eq!(Reader::new(&[1, 0, 0, 0, 0, 0, 0, 0]).u64(), Ok(1 << 56));
    }

    #[test]
    fn refuses_short_and_long_input() {
        assert_eq!(Reader::new(&[0; 7]).u64(), Err(Error::Truncated));
        assert_eq!(Reader::new(&[0; 33]).address(), Err(Error::Truncated));
        let mut reader = Reader::new(&[1, 2]);
        assert_eq!(reader.bytes(3), Err(Error::Truncated));
        assert_eq!(reader.u8(), Ok(1), "a failed read takes nothing");
        assert_eq!(reader.finish(), Err(Error::TrailingBytes));
    }

    #[test]
    fn refuses_a_bad_address() {
        let mut bytes = [0u8; ADDRESS_LEN];
        bytes[1] = 2;
        assert_eq!(Reader::new(&bytes).address(), Err(Error::UnknownScheme));
    }
}
