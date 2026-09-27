//! Calendar helpers (UTC, proleptic Gregorian) without a date-time dependency.

/// (year, month 1..=12, day 1..=31) for days since 1970-01-01. Howard Hinnant's algorithm.
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    let y = yoe + era * 400 + i64::from(m <= 2);
    (y, m, d)
}

/// Months since 1970-01 for a unix timestamp, clamped into u16 (dates before 1970 map to 0).
pub fn month_index(unix_secs: i64) -> u16 {
    let (y, m, _) = civil_from_days(unix_secs.div_euclid(86_400));
    ((y - 1970) * 12 + i64::from(m) - 1).clamp(0, i64::from(u16::MAX)) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_dates() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(month_index(0), 0);
        // 2026-09-27T12:00:00Z
        assert_eq!(civil_from_days(1_790_510_400 / 86_400), (2026, 9, 27));
        assert_eq!(month_index(1_790_510_400), (2026 - 1970) * 12 + 8);
        // 2000-02-29 (leap day)
        assert_eq!(civil_from_days(11_016), (2000, 2, 29));
        assert_eq!(month_index(-5), 0);
    }
}
