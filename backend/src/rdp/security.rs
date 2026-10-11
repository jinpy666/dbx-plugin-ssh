//! 安全策略解析（rdp-security-review 评审锁定面）：NLA 开关 + 证书策略的
//! 线制参数/偏好/缺省三级回退，未知策略名 fail-closed。
use serde_json::Value;

// —— configuration (wire → session) ——

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CertPolicy {
    /// Unknown fingerprint asks the user (default; checklist §3-C).
    Prompt,
    /// Only an already-remembered matching fingerprint connects.
    Strict,
    /// Accept any certificate without prompting (explicit opt-in only).
    AcceptTemporarily,
}

impl CertPolicy {
    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "prompt" => Some(Self::Prompt),
            "strict" => Some(Self::Strict),
            "accept-temporarily" => Some(Self::AcceptTemporarily),
            _ => None,
        }
    }

    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Prompt => "prompt",
            Self::Strict => "strict",
            Self::AcceptTemporarily => "accept-temporarily",
        }
    }
}

/// Resolved security settings for a start request: the explicit wire
/// parameter wins, then the persisted preference, then the review-locked
/// default (`use_nla=true`, `certificate_policy=prompt`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResolvedSecurity {
    pub use_nla: bool,
    pub certificate_policy: CertPolicy,
}

pub(crate) fn resolve_security(
    use_nla: Option<bool>,
    certificate_policy: Option<&str>,
    prefs: &Value,
) -> Result<ResolvedSecurity, String> {
    let use_nla = use_nla
        .or_else(|| prefs.get("rdp_use_nla").and_then(Value::as_bool))
        .unwrap_or(true);
    let policy_raw = certificate_policy
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
        .or_else(|| {
            prefs
                .get("rdp_certificate_policy")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        });
    let certificate_policy = match policy_raw.as_deref() {
        None => CertPolicy::Prompt,
        Some(value) => CertPolicy::parse(value).ok_or_else(|| {
            "rdp/start: certificatePolicy must be prompt, strict or accept-temporarily".to_string()
        })?,
    };
    Ok(ResolvedSecurity {
        use_nla,
        certificate_policy,
    })
}
