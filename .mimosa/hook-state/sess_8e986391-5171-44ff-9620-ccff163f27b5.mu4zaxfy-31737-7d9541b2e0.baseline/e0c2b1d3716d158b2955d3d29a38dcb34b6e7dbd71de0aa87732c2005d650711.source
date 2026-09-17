use std::borrow::Cow;

use russh::{cipher, kex, mac, Preferred};

/// Returns the negotiation set every connection offers. There is no
/// per-connection algorithm selector: russh's modern defaults stay first so
/// a capable server never negotiates anything weaker, and the algorithms its
/// defaults omit (SHA-1 MACs, SHA-1 DH groups, CBC, 3DES) are appended at
/// the tail, weakest last, for legacy appliances. Fixed DH groups precede
/// GEX-SHA1 because the GEX group-size floor can abort a handshake against
/// appliances whose largest moduli are smaller than the requested minimum.
pub fn preferred() -> Preferred {
    let mut preferred = Preferred::default();
    preferred.mac = append_unique(
        preferred.mac.as_ref(),
        &[mac::HMAC_SHA1_ETM, mac::HMAC_SHA1],
    );
    preferred.kex = append_unique(
        preferred.kex.as_ref(),
        &[kex::DH_G14_SHA1, kex::DH_GEX_SHA1, kex::DH_G1_SHA1],
    );
    preferred.cipher = append_unique(
        preferred.cipher.as_ref(),
        &[
            cipher::AES_256_CBC,
            cipher::AES_192_CBC,
            cipher::AES_128_CBC,
            cipher::TRIPLE_DES_CBC,
        ],
    );
    preferred
}

fn append_unique<T: Copy + PartialEq>(base: &[T], additions: &[T]) -> Cow<'static, [T]> {
    let mut values = base.to_vec();
    for &addition in additions {
        if !values.contains(&addition) {
            values.push(addition);
        }
    }
    Cow::Owned(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn modern_defaults_stay_first_in_every_list() {
        let actual = preferred();
        let defaults = Preferred::default();
        assert_eq!(
            &actual.mac.as_ref()[..defaults.mac.len()],
            defaults.mac.as_ref()
        );
        assert_eq!(
            &actual.kex.as_ref()[..defaults.kex.len()],
            defaults.kex.as_ref()
        );
        assert_eq!(
            &actual.cipher.as_ref()[..defaults.cipher.len()],
            defaults.cipher.as_ref()
        );
    }

    #[test]
    fn legacy_tail_appends_sha1_dh_cbc_and_3des_weakest_last() {
        let actual = preferred();
        assert_eq!(actual.mac.last(), Some(&mac::HMAC_SHA1));
        assert!(actual.mac.contains(&mac::HMAC_SHA1_ETM));

        let kex_list = actual.kex.as_ref();
        let g14 = kex_list
            .iter()
            .position(|name| *name == kex::DH_G14_SHA1)
            .expect("group14-sha1 appended");
        let gex = kex_list
            .iter()
            .position(|name| *name == kex::DH_GEX_SHA1)
            .expect("group-exchange-sha1 appended");
        let g1 = kex_list
            .iter()
            .position(|name| *name == kex::DH_G1_SHA1)
            .expect("group1-sha1 appended");
        assert!(g14 < gex, "fixed group14-sha1 must precede GEX-SHA1");
        assert!(gex < g1, "group1-sha1 stays weakest-last");

        let ciphers = actual.cipher.as_ref();
        assert!(ciphers.contains(&cipher::AES_128_CBC));
        assert_eq!(ciphers.last(), Some(&cipher::TRIPLE_DES_CBC));
    }
}
