mod api;
mod config;
mod credentials;
mod error;
mod gitx;
mod state;
mod watch;

use std::net::SocketAddr;
use std::sync::Arc;

use clap::Parser;
use tracing_subscriber::EnvFilter;

use crate::config::{CliArgs, SirgitConfig};
use crate::state::AppState;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args = CliArgs::parse();
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let config = SirgitConfig::load(&args)?;
    let state = Arc::new(AppState::new(config.clone()));

    let addr = SocketAddr::from(([127, 0, 0, 1], config.port));
    let app = api::router(state.clone());

    let url = start_url(&addr, args.path.as_deref());
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            // ungit-launcher behavior: a second invocation while one is
            // already running just focuses it instead of erroring out
            println!("sirgit already running on http://{} ## opening {}", addr, url);
            if config.launch_browser {
                let _ = open::that(&url);
            }
            return Ok(());
        }
        Err(e) => return Err(e.into()),
    };
    tracing::info!("sirgit listening on http://{}", addr);

    println!("Sirgit started ## opening {}", url);
    if config.launch_browser {
        let _ = open::that(&url);
    }

    axum::serve(listener, app).await?;
    Ok(())
}

/// Where the launched browser lands. Explicit path → that repo; no path →
/// the working directory the command ran from (ungit's launcher rule, so a
/// bare `sirgit` at a project root opens that project). Non-repo paths are
/// fine: the UI answers with its init/clone offer.
fn start_url(addr: &SocketAddr, path: Option<&std::path::Path>) -> String {
    start_url_with(addr, path, || std::env::current_dir().unwrap_or_default())
}

fn start_url_with(
    addr: &SocketAddr,
    path: Option<&std::path::Path>,
    fallback: impl FnOnce() -> std::path::PathBuf,
) -> String {
    let raw = match path {
        Some(p) => p.to_path_buf(),
        None => fallback(),
    };
    let target = std::fs::canonicalize(&raw).unwrap_or(raw);
    format!(
        "http://{}/#/repository?path={}",
        addr,
        urlencode(&target.to_string_lossy())
    )
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' | b'/' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn addr() -> SocketAddr {
        SocketAddr::new(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1)), 8449)
    }

    #[test]
    fn start_url_encodes_explicit_path() {
        // path doesn't exist → canonicalize falls back to the literal path
        let url = start_url(&addr(), Some(std::path::Path::new("/tmp/my repo/ü")));
        assert_eq!(
            url,
            "http://127.0.0.1:8449/#/repository?path=/tmp/my%20repo/%C3%BC"
        );
    }

    #[test]
    fn start_url_defaults_to_cwd() {
        // /tmp is a symlink on macOS — canonicalize resolves it
        let url = start_url_with(&addr(), None, || std::path::PathBuf::from("/tmp"));
        assert_eq!(url, "http://127.0.0.1:8449/#/repository?path=/private/tmp");
    }

    #[test]
    fn urlencode_keeps_unreserved_and_slash() {
        assert_eq!(urlencode("/a-b_c~d.e"), "/a-b_c~d.e");
    }
}
