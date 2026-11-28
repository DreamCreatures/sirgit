use std::path::PathBuf;

use clap::Parser;
use serde::{Deserialize, Serialize};

#[derive(Parser, Debug)]
#[command(
    name = "sirgit",
    version,
    about = "A fast, lightweight local git graph UI"
)]
pub struct CliArgs {
    /// TCP port to listen on
    #[arg(long, short = 'p')]
    pub port: Option<u16>,

    /// Do not open the browser on startup
    #[arg(long = "no-open")]
    pub no_open: bool,

    /// Repository path to open immediately
    pub path: Option<PathBuf>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct SirgitConfig {
    pub port: u16,
    pub launch_browser: bool,
    /// Fetch remotes once when a repo is opened (never on file-watch events)
    #[serde(alias = "auto_fetch_on_open")]
    pub auto_fetch_on_open: bool,
    /// Number of commits per log page
    #[serde(alias = "page_size")]
    pub page_size: u32,
    pub theme: String,
}

impl Default for SirgitConfig {
    fn default() -> Self {
        Self {
            port: 8449,
            launch_browser: true,
            auto_fetch_on_open: true,
            page_size: 200,
            theme: "dark".into(),
        }
    }
}

impl SirgitConfig {
    fn config_file() -> Option<PathBuf> {
        dirs::home_dir().map(|h| h.join(".sirgitrc.json"))
    }

    /// Precedence: defaults < ~/.sirgitrc.json < CLI args
    pub fn load(args: &CliArgs) -> anyhow::Result<Self> {
        let mut cfg = Self::default();
        if let Some(file) = Self::config_file() {
            if let Ok(text) = std::fs::read_to_string(&file) {
                match serde_json::from_str::<SirgitConfig>(&text) {
                    Ok(file_cfg) => cfg = file_cfg,
                    Err(e) => tracing::warn!("ignoring invalid {}: {}", file.display(), e),
                }
            }
        }
        if let Some(port) = args.port {
            cfg.port = port;
        }
        if args.no_open {
            cfg.launch_browser = false;
        }
        Ok(cfg)
    }

    pub fn save(&self) -> anyhow::Result<()> {
        if let Some(file) = Self::config_file() {
            let text = serde_json::to_string_pretty(self)?;
            std::fs::write(file, text)?;
        }
        Ok(())
    }

    /// Client-safe subset (never includes anything sensitive; config has no secrets by design)
    pub fn public(&self) -> Self {
        self.clone()
    }
}
