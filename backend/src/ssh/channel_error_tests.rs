use super::is_channel_level_sftp_error;

#[test]
fn classifies_channel_vs_file_level_sftp_errors() {
    // 文件级（服务器正常应答的 Status 变体）：不失效。
    assert!(!is_channel_level_sftp_error(
        "SFTP operation failed: no-such-file: /tmp/x"
    ));
    assert!(!is_channel_level_sftp_error(
        "SFTP operation failed: permission-denied: denied"
    ));
    // 通道级形态：失效（误判无害——重建只是多一次握手）。
    assert!(is_channel_level_sftp_error(
        "SFTP download failed: I/O: connection reset by peer"
    ));
    assert!(is_channel_level_sftp_error(
        "SFTP operation failed: Timeout"
    ));
    assert!(is_channel_level_sftp_error(
        "SFTP operation failed: Unexpected packet"
    ));
    assert!(is_channel_level_sftp_error(
        "SFTP operation failed: I/O: channel closed"
    ));
}
