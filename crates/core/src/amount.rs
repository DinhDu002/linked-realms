//! Amounts as people read and type them (docs/protocols/transactions.md): GOLD with at most 8
//! decimals, for the Shell and the Land UI. Transactions hold base units.

use crate::Error;
use crate::issuance::BASE_UNITS_PER_GOLD;

const DECIMALS: usize = 8;

/// Base units from `text`: digits, then optionally a dot and 1 to 8 digits. Nothing else, not even
/// a sign or a space.
pub fn parse_amount(text: &str) -> Result<u64, Error> {
    let (whole, fraction) = text.split_once('.').unwrap_or((text, ""));
    let digits = |part: &str| !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit());
    if !digits(whole) || (text.contains('.') && !digits(fraction)) || fraction.len() > DECIMALS {
        return Err(Error::BadAmount);
    }
    // Only digits now, so a failure to parse is a number past `u64::MAX`.
    let whole: u64 = whole.parse().map_err(|_| Error::Overflow)?;
    let fraction: u64 = format!("{fraction:0<DECIMALS$}").parse().unwrap();
    whole
        .checked_mul(BASE_UNITS_PER_GOLD)
        .and_then(|units| units.checked_add(fraction))
        .ok_or(Error::Overflow)
}

/// `units` in GOLD, without trailing zeros: `150000000` is `1.5`, `1` is `0.00000001`.
pub fn format_amount(units: u64) -> String {
    let (whole, fraction) = (units / BASE_UNITS_PER_GOLD, units % BASE_UNITS_PER_GOLD);
    match fraction {
        0 => whole.to_string(),
        _ => format!("{whole}.{fraction:0DECIMALS$}")
            .trim_end_matches('0')
            .to_string(),
    }
}
