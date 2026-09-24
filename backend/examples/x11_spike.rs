//! X11 forwarding spike — API sequence compile-check ONLY.
//!
//! This example exists to prove that russh 0.62 exposes the public APIs
//! needed for X11 forwarding (see docs/SPIKE_X11_FORWARDING.zh-CN.md):
//!   1. client can SEND `x11-req` on a session channel (Channel::request_x11);
//!   2. client can ACCEPT a server-initiated `x11` channel
//!      (client::Handler::server_channel_open_x11);
//!   3. fallback: direct-tcpip to a local TCP DISPLAY.
//!
//! It is NOT wired into the plugin, NOT committed, and must never run
//! against a real host with the permissive host-key checker below.
//!
//! Compile check: `cargo check --example x11_spike`

use russh::client;
use russh::Channel;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpStream;

/// Local X server display (XQuartz/VcXsrv typically listen on 6000+n).
const LOCAL_DISPLAY_PORT: u16 = 6000;

struct SpikeHandler;

impl client::Handler for SpikeHandler {
    type Error = russh::Error;

    // SPIKE ONLY: accept any host key. Never ship this.
    async fn check_server_key(
        &mut self,
        _server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    // Step 2: server opens an "x11" channel back to us
    // (russh-0.62.7 src/client/mod.rs:2564). Bridge it to the local DISPLAY.
    async fn server_channel_open_x11(
        &mut self,
        channel: Channel<client::Msg>,
        originator_address: &str,
        originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        eprintln!(
            "[x11-spike] server opened x11 channel from {originator_address}:{originator_port}"
        );

        // Accept the reverse channel (rejecting = drop `reply` or call reject()).
        reply.accept().await;

        // Bridge: ssh channel <-> local X display (TCP form here; a real
        // implementation should prefer the unix socket named by $DISPLAY).
        let display = TcpStream::connect(("127.0.0.1", LOCAL_DISPLAY_PORT)).await?;
        let (mut ch_rx, mut ch_tx) = tokio::io::split(channel.into_stream());
        let (mut dp_rx, mut dp_tx) = tokio::io::split(display);

        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut ch_rx, &mut dp_tx).await;
            let _ = dp_tx.shutdown().await;
        });
        tokio::spawn(async move {
            let _ = tokio::io::copy(&mut dp_rx, &mut ch_tx).await;
            let _ = ch_tx.shutdown().await;
        });
        Ok(())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Usage: x11_spike <host> <port> <user> [password]. SPIKE ONLY.
    let host = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "127.0.0.1".into());
    let port: u16 = std::env::args()
        .nth(2)
        .and_then(|p| p.parse().ok())
        .unwrap_or(22);
    let user = std::env::args().nth(3).unwrap_or_else(|| "nobody".into());
    let password = std::env::args().nth(4).unwrap_or_default();

    let config = Arc::new(client::Config::default());
    let mut handle = client::connect(config, (host.as_str(), port), SpikeHandler).await?;

    let authenticated = handle
        .authenticate_password(&user, &password)
        .await
        .map_err(|e| format!("auth failed: {e}"))?;
    if !authenticated.success() {
        return Err("authentication rejected".into());
    }

    // Step 1: session channel, then request X11 forwarding on it.
    // `single_connection=false`: reuse this display for multiple x11 channels.
    let channel = handle.channel_open_session().await?;
    let auth_proto = "MIT-MAGIC-COOKIE-1";
    let fake_cookie = "00112233445566778899aabbccddeeff"; // 16 random bytes hex
    channel
        .request_x11(
            false, // want_reply
            false, // single_connection
            auth_proto,
            fake_cookie,
            0, // screen number
        )
        .await
        .map_err(|e| format!("x11-req failed: {e}"))?;

    eprintln!("[x11-spike] x11-req sent; waiting for server to open x11 channels...");
    // The real loop lives in SpikeHandler::server_channel_open_x11.
    // Keep the session channel alive for a while in this spike.
    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
    Ok(())
}
