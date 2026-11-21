import assert from 'node:assert/strict';
import test from 'node:test';
import { EDITIONS, mergeVersionRegistry, parseArgs } from '../build/publish.mjs';

test('发布参数支持占位和带值的选项', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--port=5308', '--user', 'me']), {
    _: [],
    dry_run: true,
    port: '5308',
    user: 'me',
  });
  assert.throws(() => parseArgs(['--host']), /缺少参数/);
});

test('version.json 保留其他产品的条目', () => {
  const old = { '7fa4-extensions': { version: '1.3.1' }, other: { version: '2.0.0' } };
  const registry = mergeVersionRegistry(old, EDITIONS);
  assert.equal(registry['7fa4-extensions'].version, '1.3.1');
  assert.equal(registry.other.version, '2.0.0');
});

test('旧扁平格式迁移到 Asterveil 的两个产品', () => {
  const flat = { version: '0.1.3', file: 'Asterveil-0.1.3-chrome.zip', sha256: 'abc' };
  const registry = mergeVersionRegistry(flat, EDITIONS);
  assert.deepEqual(Object.keys(registry).sort(), ['asterveil', 'asterveil-pro']);
  assert.equal(registry.asterveil.sha256, 'abc');
  assert.equal(registry['asterveil-pro'].version, '0.1.3');
});
