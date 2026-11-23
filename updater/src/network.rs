use crate::{
    model::{self, Edition, Package, REPOSITORY, Release},
    transaction::{Transaction, extract, remove_tree},
};
use anyhow::{Context, Result, bail, ensure};
const LOCAL_BASE: &str = "http://localhost:9080";
use reqwest::{
    Url,
    blocking::{Client, Response},
    redirect::Policy,
};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    time::Duration,
};

fn allowed_url(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    if url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && matches!(
            url.host_str(),
            Some(
                "api.github.com"
                    | "github.com"
                    | "release-assets.githubusercontent.com"
                    | "objects.githubusercontent.com"
            )
        )
    {
        return true;
    }
    url.scheme() == "http"
        && url.port_or_known_default() == Some(9080)
        && matches!(url.host_str(), Some("localhost" | "127.0.0.1"))
}

fn build_client(no_proxy: bool) -> Result<Client> {
    let mut builder = Client::builder()
        .user_agent(concat!("Asterveil-Updater/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .redirect(Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 || !allowed_url(attempt.url()) {
                attempt.error("下载重定向地址无效")
            } else {
                attempt.follow()
            }
        }));
    if no_proxy {
        builder = builder.no_proxy();
    }
    Ok(builder.build()?)
}

pub fn client() -> Result<Client> {
    build_client(false)
}

fn local_client() -> Result<Client> {
    build_client(true)
}

fn response(client: &Client, url: &str, probe: bool) -> Result<Response> {
    ensure!(allowed_url(&Url::parse(url)?), "下载地址无效");
    let mut request = client
        .get(url)
        .timeout(Duration::from_secs(if probe { 20 } else { 600 }));
    if probe {
        request = request.header("Range", "bytes=0-0");
    }
    let response = request.send().map_err(network_error)?;
    match response.status().as_u16() {
        200 | 206 => Ok(response),
        403 | 429 => bail!("GitHub 请求受限，请稍后重试"),
        404 => bail!("尚无可用的正式更新附件"),
        _ => bail!("GitHub 下载服务暂不可用"),
    }
}

fn network_error(error: reqwest::Error) -> anyhow::Error {
    if error.is_timeout() {
        anyhow::anyhow!("GitHub 请求超时，请稍后重试")
    } else if error.is_connect() {
        anyhow::anyhow!("无法连接 GitHub，请检查网络或系统代理")
    } else {
        anyhow::anyhow!("GitHub 请求失败，请检查网络")
    }
}

fn small(client: &Client, url: &str, maximum: u64) -> Result<Vec<u8>> {
    let mut request = client.get(url).timeout(Duration::from_secs(20));
    ensure!(allowed_url(&Url::parse(url)?), "下载地址无效");
    if url.starts_with("https://api.github.com/") {
        request = request
            .header("Accept", "application/vnd.github+json")
            .header("X-GitHub-Api-Version", "2022-11-28");
    }
    let response = request.send().map_err(network_error)?;
    match response.status().as_u16() {
        403 | 429 => bail!("GitHub 请求受限，请稍后重试"),
        404 => bail!("尚无可用的正式更新清单"),
        200 => (),
        _ => bail!("GitHub 发布服务暂不可用"),
    }
    let mut bytes = Vec::new();
    response.take(maximum + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= maximum, "发布信息过大");
    Ok(bytes)
}

#[derive(Deserialize)]
struct GithubRelease {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
}

fn asset_url(release: &GithubRelease, name: &str) -> Result<String> {
    let expected = format!(
        "https://github.com/{REPOSITORY}/releases/download/{}/{name}",
        release.tag_name
    );
    let matches = release
        .assets
        .iter()
        .filter(|a| a.name == name && a.browser_download_url == expected)
        .collect::<Vec<_>>();
    ensure!(
        matches.len() == 1 && matches[0].size > 0,
        "发布缺少有效的更新附件"
    );
    Ok(expected)
}

fn local_release(edition: &Edition, current: &str) -> Result<Option<(Release, Package, String)>> {
    let client = local_client()?;
    let bytes = small(
        &client,
        &format!("{LOCAL_BASE}/update-manifest.json"),
        64 * 1024,
    )?;
    let signature = small(&client, &format!("{LOCAL_BASE}/update-manifest.sig"), 64)?;
    let release = model::verify_release(&bytes, &signature, &model::public_key()?)?;
    if model::version(&release.version)? <= model::version(current)? {
        return Ok(None);
    }
    let package = release
        .packages
        .iter()
        .find(|p| &p.edition == edition)
        .context("本地更新清单缺少版本")?
        .clone();
    let url = format!("{LOCAL_BASE}/{}", package.name);
    let mut probe = response(&client, &url, true)?;
    let mut first = [0u8; 1];
    probe.read_exact(&mut first).context("无法访问本地更新包")?;
    Ok(Some((release, package, url)))
}

pub fn latest(
    client: &Client,
    edition: &Edition,
    current: &str,
) -> Result<Option<(Release, Package, String)>> {
    // The local mirror is only trusted when it carries a valid signature. Any
    // failure here (no proxy, missing files, bad signature) falls back to GitHub.
    if let Ok(Some(local)) = local_release(edition, current) {
        return Ok(Some(local));
    }
    let github: GithubRelease = serde_json::from_slice(&small(
        client,
        &format!("https://api.github.com/repos/{REPOSITORY}/releases/latest"),
        2 * 1024 * 1024,
    )?)?;
    resolve_release(client, edition, current, github)
}

fn resolve_release(
    client: &Client,
    edition: &Edition,
    current: &str,
    github: GithubRelease,
) -> Result<Option<(Release, Package, String)>> {
    ensure!(!github.draft && !github.prerelease, "忽略非正式版本");
    let available = model::version(github.tag_name.strip_prefix('v').context("发布标签无效")?)?;
    // Old releases may predate signed updates. Only inspect attachments when an
    // upgrade exists; every upgrade still requires a signature and a CDN probe.
    if available <= model::version(current)? {
        return Ok(None);
    }
    let bytes = small(
        client,
        &asset_url(&github, "update-manifest.json")?,
        64 * 1024,
    )?;
    let signature = small(client, &asset_url(&github, "update-manifest.sig")?, 64)?;
    let release = model::verify_release(&bytes, &signature, &model::public_key()?)?;
    ensure!(
        github.tag_name == format!("v{}", release.version),
        "发布标签与签名版本不一致"
    );
    let package = release
        .packages
        .iter()
        .find(|p| &p.edition == edition)
        .context("版本附件缺失")?
        .clone();
    let url = asset_url(&github, &package.name)?;
    ensure!(
        github
            .assets
            .iter()
            .any(|a| a.name == package.name && a.size == package.size),
        "发布附件长度不匹配"
    );
    let mut probe = response(client, &url, true)?;
    let mut first = [0u8; 1];
    probe
        .read_exact(&mut first)
        .context("无法访问 GitHub 附件下载服务器")?;
    Ok(Some((release, package, url)))
}

pub fn download(client: &Client, url: &str, package: &Package, file: &mut File) -> Result<()> {
    if url.starts_with(LOCAL_BASE) {
        let local = local_client()?;
        let response = response(&local, url, false)?;
        return save_download(response, package, file);
    }
    let response = response(client, url, false)?;
    save_download(response, package, file)
}

fn save_download(mut response: Response, package: &Package, file: &mut File) -> Result<()> {
    ensure!(response.status().as_u16() == 200, "下载响应不完整");
    if let Some(length) = response.content_length() {
        ensure!(length == package.size, "下载长度不匹配");
    }
    let mut hash = Sha256::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        let n = response.read(&mut buffer).context("下载中断，请稍后重试")?;
        if n == 0 {
            break;
        }
        total += n as u64;
        ensure!(total <= package.size, "下载超过预期大小");
        hash.update(&buffer[..n]);
        file.write_all(&buffer[..n])?;
    }
    ensure!(
        total == package.size
            && hex::encode(hash.finalize()) == package.sha256.to_ascii_lowercase(),
        "更新包校验失败"
    );
    file.sync_all()?;
    Ok(())
}

pub fn prepare(tx: &Transaction) -> Result<serde_json::Value> {
    let http = client()?;
    let current = model::extension_manifest(&tx.target, &tx.edition)?;
    let Some((release, package, url)) = latest(
        &http,
        &tx.edition,
        current["version"].as_str().context("当前版本无效")?,
    )?
    else {
        return Ok(serde_json::json!({"state":"current", "version": current["version"]}));
    };
    if let Some(j) = tx.read()? {
        ensure!(j.phase != "pending", "等待新版插件启动");
        ensure!(
            j.phase != "rolled_back" || j.version != release.version,
            "此版本曾安装失败，已保留旧版"
        );
        if j.phase == "prepared"
            && j.version == release.version
            && crate::transaction::tree_hash(&tx.stage()).ok().as_deref() == Some(&j.tree_hash)
        {
            return Ok(serde_json::json!({"state":"prepared", "version":release.version}));
        }
    }
    let mut archive = tempfile::NamedTempFile::new_in(&tx.work)?;
    download(&http, &url, &package, archive.as_file_mut())?;
    remove_tree(&tx.stage())?;
    if let Err(error) =
        extract(archive.path(), &tx.stage()).and_then(|_| tx.prepared(&release.version))
    {
        let _ = remove_tree(&tx.stage());
        return Err(error);
    }
    // Keep the authenticated metadata alongside the transaction for diagnosis.
    fs::write(tx.work.join("release.json"), serde_json::to_vec(&release)?)?;
    Ok(serde_json::json!({"state":"prepared", "version":release.version}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_or_equal_releases_need_no_update_assets_but_newer_ones_do() {
        let http = client().unwrap();
        for tag in ["v0.1.1", "v0.1.2"] {
            let github = GithubRelease {
                tag_name: tag.into(),
                draft: false,
                prerelease: false,
                assets: vec![],
            };
            assert!(
                resolve_release(&http, &Edition::Full, "0.1.2", github)
                    .unwrap()
                    .is_none()
            );
        }
        for tag in ["v0.1.3", "v0.1.10", "invalid"] {
            let github = GithubRelease {
                tag_name: tag.into(),
                draft: false,
                prerelease: false,
                assets: vec![],
            };
            assert!(resolve_release(&http, &Edition::Full, "0.1.2", github).is_err());
        }
    }
    #[test]
    fn limits_release_hosts_and_credentials() {
        for s in [
            "http://github.com/x",
            "https://github.com.evil.test/x",
            "https://user@github.com/x",
            "https://github.com:444/x",
            "https://127.0.0.1/x",
        ] {
            assert!(!allowed_url(&Url::parse(s).unwrap()));
        }
        assert!(allowed_url(
            &Url::parse("https://release-assets.githubusercontent.com/a").unwrap()
        ));
        assert!(allowed_url(
            &Url::parse("http://localhost:9080/update-manifest.json").unwrap()
        ));
        assert!(allowed_url(
            &Url::parse("http://127.0.0.1:9080/Asterveil-0.2.1-chrome.zip").unwrap()
        ));
        for s in [
            "http://localhost:9081/a",
            "http://example.com:9080/a",
            "http://user@localhost:9080/a",
        ] {
            assert!(!allowed_url(&Url::parse(s).unwrap()));
        }
    }

    #[test]
    fn downloaded_bytes_must_match_signed_size_and_hash() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            for _ in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let mut input = [0; 2048];
                let _ = stream.read(&mut input).unwrap();
                stream
                    .write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nTEST",
                    )
                    .unwrap();
            }
        });
        // Only this test client accepts HTTP; the production client requires HTTPS.
        let client = Client::builder().no_proxy().build().unwrap();
        let mut package = Package {
            edition: Edition::Light,
            name: "test.zip".into(),
            size: 4,
            sha256: hex::encode(Sha256::digest(b"TEST")),
        };
        for valid in [true, false, false] {
            let response = client.get(format!("http://{address}/")).send().unwrap();
            let mut file = tempfile::tempfile().unwrap();
            assert_eq!(save_download(response, &package, &mut file).is_ok(), valid);
            if valid {
                package.sha256 = "00".repeat(32);
            } else {
                package.size = 5;
            }
        }
        server.join().unwrap();
    }
}
