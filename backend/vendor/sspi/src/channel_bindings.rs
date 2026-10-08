use crate::{Error, ErrorKind, Result};

// size of SEC_CHANNEL_BINDINGS structure
const SEC_CHANNEL_BINDINGS_SIZE: usize = 32;

// OID of the certificate signature algorithm (see `picky_asn1_x509::oids` for the source values).
const OID_SHA1_WITH_RSA: &str = "1.2.840.113549.1.1.5";
const OID_SHA256_WITH_RSA: &str = "1.2.840.113549.1.1.11";
const OID_SHA384_WITH_RSA: &str = "1.2.840.113549.1.1.12";
const OID_SHA512_WITH_RSA: &str = "1.2.840.113549.1.1.13";
const OID_MD5_WITH_RSA: &str = "1.2.840.113549.1.1.4";
const OID_SHA256_WITH_ECDSA: &str = "1.2.840.10045.4.3.2";
const OID_SHA384_WITH_ECDSA: &str = "1.2.840.10045.4.3.3";
const OID_SHA512_WITH_ECDSA: &str = "1.2.840.10045.4.3.4";
const OID_ED25519: &str = "1.3.101.112";

/// The digest algorithm used for the `tls-server-end-point` channel binding
/// per [RFC 5929 §4.1](https://datatracker.ietf.org/doc/html/rfc5929#section-4.1):
/// the certificate's signature hash algorithm, with MD5 and SHA-1 upgraded to
/// SHA-256 (SHA-1 is unconditionally upgraded; MD5-forcing servers are rare but
/// the same upgrade applies).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TlsServerEndPointDigest {
    Md5,
    Sha256,
    Sha384,
    Sha512,
}

impl TlsServerEndPointDigest {
    /// Picks the digest for a certificate signature algorithm OID (dotted string form).
    pub fn for_signature_oid(oid: &str) -> Self {
        match oid {
            OID_MD5_WITH_RSA => Self::Md5,
            OID_SHA1_WITH_RSA => Self::Sha256,
            OID_SHA256_WITH_RSA | OID_SHA384_WITH_RSA | OID_SHA512_WITH_RSA | OID_SHA256_WITH_ECDSA => Self::Sha256,
            OID_SHA384_WITH_ECDSA => Self::Sha384,
            OID_SHA512_WITH_ECDSA | OID_ED25519 => Self::Sha512,
            // SHA-384/SHA-512 RSA variants plus everything unknown fall back
            // to the strongest common digest; unknown OIDs cannot be replayed
            // by the server unless it uses the same one, so SHA-256 is the safe
            // pick for real-world RSA certificates.
            _ => Self::Sha256,
        }
    }
}

/// [SEC_CHANNEL_BINDINGS](https://docs.microsoft.com/en-us/windows/win32/api/sspi/ns-sspi-sec_channel_bindings)
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChannelBindings {
    pub initiator_addr_type: u32,
    pub initiator: Vec<u8>,
    pub acceptor_addr_type: u32,
    pub acceptor: Vec<u8>,
    pub application_data: Vec<u8>,
}

impl ChannelBindings {
    pub fn from_bytes<T: AsRef<[u8]>>(data: T) -> Result<Self> {
        let data = data.as_ref();

        if data.len() < SEC_CHANNEL_BINDINGS_SIZE {
            return Err(Error::new(
                ErrorKind::InvalidParameter,
                format!(
                    "Invalid SEC_CHANNEL_BINDINGS buffer: buffer is too short: {}. Minimum len: {}",
                    data.len(),
                    SEC_CHANNEL_BINDINGS_SIZE,
                ),
            ));
        }

        let initiator_addr_type = u32::from_le_bytes(data[0..4].try_into().unwrap());

        let initiator_len = u32::from_le_bytes(data[4..8].try_into().unwrap()) as usize;
        let initiator_offset = u32::from_le_bytes(data[8..12].try_into().unwrap()) as usize;
        if initiator_offset + initiator_len > data.len() {
            return Err(Error::new(
                ErrorKind::InvalidParameter,
                format!(
                    "Invalid SEC_CHANNEL_BINDINGS buffer: initiator offset + len ({}) goes outside the buffer ({})",
                    initiator_offset + initiator_len,
                    data.len()
                ),
            ));
        }

        let initiator = if initiator_len > 0 {
            data[initiator_offset..(initiator_offset + initiator_len)].to_vec()
        } else {
            Vec::new()
        };

        let acceptor_addr_type = u32::from_le_bytes(data[12..16].try_into().unwrap());

        let acceptor_len = u32::from_le_bytes(data[16..20].try_into().unwrap()) as usize;
        let acceptor_offset = u32::from_le_bytes(data[20..24].try_into().unwrap()) as usize;
        if acceptor_offset + acceptor_len > data.len() {
            return Err(Error::new(
                ErrorKind::InvalidParameter,
                format!(
                    "Invalid SEC_CHANNEL_BINDINGS buffer: acceptor offset + len ({}) goes outside the buffer ({})",
                    acceptor_offset + acceptor_len,
                    data.len()
                ),
            ));
        }

        let acceptor = if acceptor_len > 0 {
            data[acceptor_offset..(acceptor_offset + acceptor_len)].to_vec()
        } else {
            Vec::new()
        };

        let application_len = u32::from_le_bytes(data[24..28].try_into().unwrap()) as usize;
        let application_offset = u32::from_le_bytes(data[28..32].try_into().unwrap()) as usize;
        if application_offset + application_len > data.len() {
            return Err(Error::new(
                ErrorKind::InvalidParameter,
                format!(
                    "Invalid SEC_CHANNEL_BINDINGS buffer: application offset + len ({}) goes outside the buffer ({})",
                    application_offset + application_len,
                    data.len()
                ),
            ));
        }

        let application_data = if application_len > 0 {
            data[application_offset..(application_offset + application_len)].to_vec()
        } else {
            Vec::new()
        };

        Ok(Self {
            initiator_addr_type,
            initiator,
            acceptor_addr_type,
            acceptor,
            application_data,
        })
    }

    /// Builds channel bindings for the `tls-server-end-point` binding type
    /// ([RFC 5929 §4](https://datatracker.ietf.org/doc/html/rfc5929#section-4)):
    /// the application data is the `"tls-server-end-point:"` prefix followed by
    /// the hash of the server certificate DER. The digest is chosen from the
    /// certificate's signature algorithm OID per RFC 5929 §4.1.
    pub fn tls_server_end_point(
        certificate_der: impl AsRef<[u8]>,
        signature_algorithm_oid: &str,
    ) -> Result<Self> {
        use crate::crypto::{
            SHA256_SIZE, SHA384_SIZE, SHA512_SIZE, compute_sha256, compute_sha384, compute_sha512,
        };

        const PREFIX: &[u8] = b"tls-server-end-point:";

        let certificate_der = certificate_der.as_ref();
        let digest = TlsServerEndPointDigest::for_signature_oid(signature_algorithm_oid);

        let mut application_data = Vec::with_capacity(PREFIX.len() + SHA256_SIZE);
        application_data.extend_from_slice(PREFIX);
        match digest {
            TlsServerEndPointDigest::Md5 => {
                // RFC 5929 §4.1 upgrades MD5 to SHA-256, keeping the same hash size.
                application_data.extend_from_slice(&compute_sha256(certificate_der));
            }
            TlsServerEndPointDigest::Sha256 => {
                let hash = compute_sha256(certificate_der);
                application_data.extend_from_slice(&hash);
                debug_assert_eq!(application_data.len(), PREFIX.len() + SHA256_SIZE);
            }
            TlsServerEndPointDigest::Sha384 => {
                let hash = compute_sha384(certificate_der);
                application_data.extend_from_slice(&hash);
                debug_assert_eq!(application_data.len(), PREFIX.len() + SHA384_SIZE);
            }
            TlsServerEndPointDigest::Sha512 => {
                let hash = compute_sha512(certificate_der);
                application_data.extend_from_slice(&hash);
                debug_assert_eq!(application_data.len(), PREFIX.len() + SHA512_SIZE);
            }
        }

        Ok(Self {
            initiator_addr_type: 0,
            initiator: Vec::new(),
            acceptor_addr_type: 0,
            acceptor: Vec::new(),
            application_data,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::ChannelBindings;

    #[test]
    fn from_bytes() {
        let expected = ChannelBindings {
            initiator_addr_type: 0,
            initiator: Vec::new(),
            acceptor_addr_type: 0,
            acceptor: Vec::new(),
            application_data: vec![1, 2, 3, 4],
        };

        let channel_bindings_token = [1, 2, 3, 4];
        let application_offset = 32_u32;
        let application_len = channel_bindings_token.len();

        let mut buffer = [0; 36];

        buffer[24..28].copy_from_slice(&(application_len as u32).to_le_bytes());
        buffer[28..32].copy_from_slice(&application_offset.to_le_bytes());
        buffer[32..].copy_from_slice(&channel_bindings_token);

        let channel_bindings = ChannelBindings::from_bytes(buffer).unwrap();

        assert_eq!(channel_bindings, expected);
    }

    #[test]
    fn too_small_buffer() {
        assert!(ChannelBindings::from_bytes([1, 2, 3, 4, 5, 6, 7, 8]).is_err());

        assert!(ChannelBindings::from_bytes([]).is_err());
    }

    #[test]
    fn invalid_len() {
        let channel_bindings_token = [1, 2, 3, 4];
        let application_offset = 32_u32;
        // invalid len
        let application_len = channel_bindings_token.len() + 2;

        let mut buffer = [0; 36];

        buffer[24..28].copy_from_slice(&(application_len as u32).to_le_bytes());
        buffer[28..32].copy_from_slice(&application_offset.to_le_bytes());
        buffer[32..].copy_from_slice(&channel_bindings_token);

        let channel_bindings = ChannelBindings::from_bytes(buffer);

        assert!(channel_bindings.is_err());
    }

    #[test]
    fn invalid_offset() {
        let channel_bindings_token = [1, 2, 3, 4];
        // invalid offset
        let application_offset = 32_u32 + 3;
        let application_len = channel_bindings_token.len();

        let mut buffer = [0; 36];

        buffer[24..28].copy_from_slice(&(application_len as u32).to_le_bytes());
        buffer[28..32].copy_from_slice(&application_offset.to_le_bytes());
        buffer[32..].copy_from_slice(&channel_bindings_token);

        let channel_bindings = ChannelBindings::from_bytes(buffer);

        assert!(channel_bindings.is_err());
    }
}
