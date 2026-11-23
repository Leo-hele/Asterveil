#!/usr/bin/env node
// 构建两版 ZIP → 上传到 5308（SFTPGo Web）→ 回读校验 → 更新同目录 version.json。
// 用法：npm run deploy [-- --host jx.7fa4.cn --port 5308 --dry-run]

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_HOST = 'jx.7fa4.cn';
const DEFAULT_PORT = 5308;
const DEFAULT_DIR = '/share';
const VERSION_FILE = 'version.json';
const PRODUCT_PAGE = join(ROOT, 'publish', 'products', 'asterveil', 'index.html');
const PRODUCT_PAGES = ['asterveil', 'asterveil-pro'].map((name) =>
  posix.join('products', name, 'index.html'),
);
const SKY_ASSETS = ['starfield.js', 'sky-motion.js'].map((name) =>
  join(ROOT, 'publish', 'products', 'sky', name),
);

export const EDITIONS = [
  { product: 'asterveil', name: 'Asterveil' },
  { product: 'asterveil-pro', name: 'Asterveil Pro' },
];

const INSTALL =
  '下载 ZIP 并解压，在 chrome://extensions 或 edge://extensions 开启开发者模式，加载解压目录。';

export const PRODUCT_INFO = {
  asterveil: {
    name: 'Asterveil',
    description: '面向 7FA4 的模块化浏览器扩展：页面美化、主题配色、Markdown 作答与外站提交。',
    features: [
      '首页、题目、评测、计划、聊天与账户页面统一美化，支持浅色、深色和七种主题色',
      'Markdown Editor：公式预览、按题目保存草稿、PNG 导出与答案图片提交',
      '本地头像替换、Better Names 姓名显示、可拖动计划日期条与源码复制',
      '工具栏提交器支持多站题目解析，经 7FA4 代理提交代码',
    ],
    install: INSTALL,
  },
  'asterveil-pro': {
    name: 'Asterveil Pro',
    description: 'Asterveil 增强版，额外提供 PDF 导出与上传提交、加密的 Better Names 数据来源。',
    features: [
      '包含普通版全部页面美化、Markdown Editor、头像替换与外站提交能力',
      'A4 分页 PDF 导出，并支持上传 PDF 后逐页转换为图片提交',
      '加密的 Better Names 姓名数据，可按年级着色并从计划、好友和官方来源同步',
      '与普通版共存时优先运行 Pro，设置和草稿保留',
    ],
    install: INSTALL,
  },
};

const FLAGS = new Set(['no_build', 'no_version', 'dry_run', 'help']);

export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    const key = (eq >= 0 ? token.slice(2, eq) : token.slice(2)).replaceAll('-', '_');
    if (eq >= 0) {
      args[key] = token.slice(eq + 1);
    } else if (FLAGS.has(key)) {
      args[key] = true;
    } else {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new Error(`--${key} 缺少参数`);
      }
      args[key] = next;
      i++;
    }
  }
  return args;
}

/** 兼容旧的扁平格式：整份文件是单个产品时，迁移到当前各产品名下。 */
export function mergeVersionRegistry(existing, products) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    return {};
  }
  if (existing.version && !products.some(({ product }) => existing[product])) {
    return Object.fromEntries(products.map(({ product }) => [product, { ...existing }]));
  }
  return { ...existing };
}

function env(...names) {
  for (const name of names) {
    if (process.env[name]) {
      return process.env[name].trim();
    }
  }
  return '';
}

function cliConfigPath(args) {
  if (args.config) {
    return resolve(args.config);
  }
  if (process.platform === 'win32') {
    return join(
      process.env.APPDATA || process.env.LOCALAPPDATA || '',
      '7fa4_terminal',
      'config.json',
    );
  }
  if (process.platform === 'darwin') {
    return join(
      process.env.HOME || '',
      'Library',
      'Application Support',
      '7fa4_terminal',
      'config.json',
    );
  }
  return join(
    process.env.XDG_CONFIG_HOME || join(process.env.HOME || '', '.config'),
    '7fa4_terminal',
    'config.json',
  );
}

export function resolveConnection(args) {
  const config = cliConfigPath(args);
  let data = {};
  try {
    data = JSON.parse(readFileSync(config, 'utf8'));
  } catch {
    // 没有 CLI 配置时只用命令行和环境变量。
  }
  const host = String(
    args.host || env('SFTPGO_HOST', 'SFTP_HOST') || data.sftp_host || DEFAULT_HOST,
  );
  const port = Number(args.port || env('SFTPGO_PORT') || DEFAULT_PORT);
  const user = String(args.user || env('SFTPGO_USER', 'SFTP_USER') || data.sftp_user || '');
  const password = String(
    args.password || env('SFTPGO_PASSWORD', 'SFTP_PASSWORD') || data.sftp_password || '',
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`端口不合法：${port}`);
  }
  return { host, port, user, password, config };
}

class SftpGoClient {
  constructor(host, port) {
    this.base = `https://${host}:${port}`;
    this.cookies = new Map();
    this.csrf = undefined;
  }

  cookieHeader() {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  absorbCookies(response) {
    const lines =
      response.headers.getSetCookie?.() ??
      String(response.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;,]+=)/);
    for (const line of lines) {
      const pair = line.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) {
        this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
    }
  }

  async request(method, path, { form, body, headers = {}, redirect = 'follow' } = {}) {
    const init = {
      method,
      redirect,
      headers: {
        'User-Agent': 'Asterveil/publish',
        Accept: 'application/json, text/html;q=0.9,*/*;q=0.8',
        ...headers,
      },
    };
    const cookie = this.cookieHeader();
    if (cookie) {
      init.headers.Cookie = cookie;
    }
    if (form) {
      init.body = new URLSearchParams(form);
      init.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    } else if (body) {
      init.body = body;
    }
    const response = await fetch(`${this.base}${path}`, init);
    this.absorbCookies(response);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { status: response.status, body: bytes, text: bytes.toString('utf8') };
  }

  async login(user, password) {
    const page = await this.request('GET', '/web/client/login');
    const token = /name="_form_token" value="([^"]+)"/.exec(page.text)?.[1];
    if (!token) {
      throw new Error(`登录页没有表单 token（${this.base} 可能不是 SFTPGo）`);
    }
    const response = await this.request('POST', '/web/client/login', {
      form: { username: user, password, _form_token: token },
      redirect: 'manual',
    });
    if (response.status < 300 || response.status >= 400) {
      throw new Error(`SFTPGo 登录失败（HTTP ${response.status}）`);
    }
    if (!this.cookies.get('jwt')) {
      throw new Error('SFTPGo 登录后没有拿到 jwt Cookie');
    }
  }

  async csrfToken(dir) {
    if (this.csrf) {
      return this.csrf;
    }
    const page = await this.request('GET', `/web/client/files?path=${encodeURIComponent(dir)}`);
    const token = /['"]X-CSRF-TOKEN['"]:\s*['"]([^'"]+)['"]/.exec(page.text)?.[1];
    if (!token) {
      throw new Error('SFTPGo 页面里没有 X-CSRF-TOKEN（登录可能已过期）');
    }
    this.csrf = token;
    return token;
  }

  async upload(remote, data) {
    const dir = posix.dirname(remote) || '/';
    const query = `path=${encodeURIComponent(remote)}&mkdir_parents=true`;
    const response = await this.request('POST', `/web/client/file?${query}`, {
      body: data,
      headers: {
        'X-CSRF-TOKEN': await this.csrfToken(dir),
        'X-SFTPGO-MTIME': String(Math.floor(Date.now() / 1000)),
        'Content-Type': 'application/octet-stream',
      },
    });
    if (![200, 201, 204].includes(response.status)) {
      throw new Error(
        `上传 ${remote} 失败：HTTP ${response.status} ${response.text.slice(0, 200)}`,
      );
    }
  }

  async download(remote) {
    const dir = posix.dirname(remote) || '/';
    const query = `path=${encodeURIComponent(remote)}`;
    const response = await this.request('GET', `/web/client/file?${query}`, {
      headers: { 'X-CSRF-TOKEN': await this.csrfToken(dir) },
    });
    if (response.status !== 200) {
      throw new Error(`下载 ${remote} 失败：HTTP ${response.status}`);
    }
    return response.body;
  }

  webUrl(remote) {
    return `${this.base}/web/client/files?path=${encodeURIComponent(remote)}`;
  }
}

function build() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(npm, ['run', 'zip:all'], { cwd: ROOT, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    throw new Error('构建两版 ZIP 失败');
  }
}

function signUpdateManifest(version) {
  const env = { ...process.env };
  const fallback =
    process.platform === 'win32'
      ? join(env.LOCALAPPDATA || '', 'AsterveilReleaseKeys', 'update-ed25519.private.pem')
      : '';
  const key = env.ASTERVEIL_UPDATE_PRIVATE_KEY_FILE || fallback;
  if (!env.ASTERVEIL_UPDATE_PRIVATE_KEY && !(key && existsSync(key))) {
    return;
  }
  env.ASTERVEIL_UPDATE_PRIVATE_KEY_FILE = key;
  const result = spawnSync(
    process.execPath,
    [join(ROOT, 'updater', 'scripts', 'release.mjs'), 'sign', join(ROOT, '.output')],
    { cwd: ROOT, env, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    console.warn(
      `[更新] 签名清单生成失败，跳过：${(result.stderr || result.stdout).trim().split('\n').pop()}`,
    );
  } else {
    console.log(`[更新] 已生成 ${version} 的签名更新清单`);
  }
}

function findUpdateManifests(version, products) {
  const files = ['update-manifest.json', 'update-manifest.sig'].map((name) =>
    join(ROOT, '.output', name),
  );
  if (!files.every((file) => existsSync(file))) {
    return [];
  }
  try {
    const manifest = JSON.parse(readFileSync(files[0], 'utf8'));
    if (manifest.version !== version) {
      console.warn(`[更新] 现有签名清单版本 ${manifest.version} 与 ${version} 不一致，跳过`);
      return [];
    }
    for (const item of products) {
      const entry = manifest.packages?.find((p) => p.name === item.name);
      if (!entry || entry.size !== item.bytes.length || entry.sha256 !== item.sha256) {
        console.warn(`[更新] 现有签名清单与 ${item.name} 不匹配，跳过`);
        return [];
      }
    }
  } catch {
    return [];
  }
  return files;
}

function usage() {
  console.log(`用法: npm run deploy -- [选项]

  --host <host>         SFTPGo 主机（默认 CLI 配置的 sftp_host 或 jx.7fa4.cn）
  --port <port>         SFTPGo Web 端口（默认 5308）
  --user <user>         用户名（默认 CLI 配置的 sftp_user）
  --password <pass>     密码（默认 SFTPGO_PASSWORD 或 CLI 配置的 sftp_password）
  --remote-dir <path>   远程目录（默认 /share）
  --config <path>       CLI 配置文件路径
  --no-build            使用现有 .output/ 中的 ZIP
  --no-version          不更新同目录的 version.json
  --dry-run             只构建并校验产物，不上传
  --help                显示帮助`);
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    usage();
    return 0;
  }
  const { host, port, user, password } = resolveConnection(args);
  if (!user || !password) {
    throw new Error(
      `缺少 SFTPGo 凭据：用 --user/--password，或配置 ${cliConfigPath(args)} 的 sftp_user/sftp_password`,
    );
  }
  const dir = String(args.remote_dir || DEFAULT_DIR).replace(/\/+$/, '') || '/';
  const versionFile = String(args.version_file || VERSION_FILE);
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

  if (!args.no_build) {
    build();
  }
  const products = EDITIONS.map(({ product, name }) => {
    // wxt 的 zip.name 把产品名里的空格替换为连字符。
    const file = join(ROOT, '.output', `${name.replaceAll(' ', '-')}-${version}-chrome.zip`);
    if (!existsSync(file)) {
      throw new Error(`找不到构建产物：${file}（去掉 --no-build 可重新构建）`);
    }
    const bytes = readFileSync(file);
    return {
      product,
      name: basename(file),
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });

  if (args.dry_run) {
    console.log(`[dry-run] ${host}:${port}  ${dir}`);
    for (const item of products) {
      console.log(`  ${item.name}  ${item.bytes.length} B  sha256 ${item.sha256.slice(0, 16)}…`);
    }
    for (const file of findUpdateManifests(version, products)) {
      console.log(`  ${basename(file)}  签名更新清单`);
    }
    if (existsSync(PRODUCT_PAGE)) {
      for (const asset of SKY_ASSETS) {
        console.log(`  ${posix.join(dir, 'products', 'sky', basename(asset))}  星空动画`);
      }
      for (const page of PRODUCT_PAGES) {
        console.log(`  ${posix.join(dir, page)}  产品介绍页`);
      }
    }
    if (!args.no_version) {
      console.log(
        `  ${posix.join(dir, versionFile)} <- ${products.map((p) => p.product).join(', ')}`,
      );
    }
    return 0;
  }

  const client = new SftpGoClient(host, port);
  await client.login(user, password);
  let registry = {};
  if (!args.no_version) {
    try {
      const raw = JSON.parse(
        (await client.download(posix.join(dir, versionFile))).toString('utf8'),
      );
      registry = mergeVersionRegistry(raw, products);
    } catch {
      registry = {};
    }
  }
  const builtAt = new Date().toISOString();
  for (const item of products) {
    const remote = posix.join(dir, item.name);
    await client.upload(remote, item.bytes);
    const back = await client.download(remote);
    if (createHash('sha256').update(back).digest('hex') !== item.sha256) {
      throw new Error(`校验失败：${remote} 的远端内容与本地不一致`);
    }
    console.log(`[上传] ${client.webUrl(remote)}  ${item.bytes.length} B`);
    if (!args.no_version) {
      registry[item.product] = {
        ...PRODUCT_INFO[item.product],
        ...registry[item.product],
        version,
        builtAt,
        file: item.name,
        size: item.bytes.length,
        sha256: item.sha256,
      };
    }
  }
  if (existsSync(PRODUCT_PAGE)) {
    for (const asset of SKY_ASSETS) {
      const remote = posix.join(dir, 'products', 'sky', basename(asset));
      const bytes = readFileSync(asset);
      await client.upload(remote, bytes);
      if (!(await client.download(remote)).equals(bytes)) {
        throw new Error(`校验失败：${remote} 的远端内容与本地不一致`);
      }
      console.log(`[星空] ${client.webUrl(remote)}`);
    }
    const bytes = readFileSync(PRODUCT_PAGE);
    for (const page of PRODUCT_PAGES) {
      const remote = posix.join(dir, page);
      await client.upload(remote, bytes);
      if (!(await client.download(remote)).equals(bytes)) {
        throw new Error(`校验失败：${remote} 的远端内容与本地不一致`);
      }
      console.log(`[介绍页] ${client.webUrl(remote)}`);
    }
  }
  signUpdateManifest(version);
  for (const file of findUpdateManifests(version, products)) {
    const remote = posix.join(dir, basename(file));
    const bytes = readFileSync(file);
    await client.upload(remote, bytes);
    if (!(await client.download(remote)).equals(bytes)) {
      throw new Error(`校验失败：${remote} 的远端内容与本地不一致`);
    }
    console.log(`[更新] ${client.webUrl(remote)}`);
  }
  if (!args.no_version) {
    const remote = posix.join(dir, versionFile);
    await client.upload(remote, Buffer.from(`${JSON.stringify(registry, null, 2)}\n`, 'utf8'));
    console.log(
      `[版本] ${client.webUrl(remote)}  ${products.map((p) => p.product).join(', ')} ${version}`,
    );
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main()
    .then((code) => process.exit(code))
    .catch((error) => {
      console.error(`[错误] ${error.message}`);
      process.exit(1);
    });
}
