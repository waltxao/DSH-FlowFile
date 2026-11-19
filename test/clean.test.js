import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FF_CLEAN_LARGE, FF_CLEAN_UNUSED_DAYS, FF_CLEAN_RECENT_DAYS,
  FF_CLEAN_INSTALLER_DAYS, FF_CLEAN_MAX, FF_CLEAN_INSTALLER_EXT,
  FF_CLEAN_CATEGORY_LABEL, cleanBase, cleanExt, cleanNsToMs,
  cleanIsRecent, cleanLargeReason, cleanUnusedReason,
  cleanInstallerReason, cleanProtect, cleanAllowedRoot,
  cleanCandidateFromRow, cleanCandidatesFromRows,
  cleanDuplicateCandidates, cleanKeepOf, cleanDedupeByHash,
  cleanMergeCandidates, cleanStale, cleanCheckMap, cleanSummary
} from '../src/clean-core.js';

var HOME = '/Users/demo';
var NOW = Date.parse('2026-11-13T12:00:00Z');
var DAY = 86400000;
function ns(ms) { return String(BigInt(Math.round(ms)) * 1000000n); }
function row(p, size, msAgo, extra) {
  return Object.assign({
    path: p, name: cleanBase(p), size: size,
    mtime_ns: ns(NOW - msAgo * DAY), ctime_ns: ns(NOW - msAgo * DAY),
    is_dir: 0, missing: 0, hash_full: '', hash_state: 'none'
  }, extra || {});
}

test('常量与分类标签：阈值与默认天数按定稿 §6', function () {
  assert.equal(FF_CLEAN_LARGE, 100 * 1024 * 1024);
  assert.equal(FF_CLEAN_UNUSED_DAYS, 180);
  assert.equal(FF_CLEAN_RECENT_DAYS, 7);
  assert.equal(FF_CLEAN_INSTALLER_DAYS, 30);
  assert.ok(FF_CLEAN_MAX > 0 && FF_CLEAN_MAX <= 1000);
  assert.deepEqual(FF_CLEAN_INSTALLER_EXT, ['.dmg', '.pkg', '.zip', '.iso']);
  assert.equal(FF_CLEAN_CATEGORY_LABEL.large, '大文件');
  assert.equal(FF_CLEAN_CATEGORY_LABEL.duplicate, '重复副本');
});

test('cleanBase / cleanExt：路径与扩展名', function () {
  assert.equal(cleanBase('/Users/demo/Downloads/a.dmg'), 'a.dmg');
  assert.equal(cleanExt('/Users/demo/Downloads/Setup.PKG'), '.pkg');
  assert.equal(cleanExt('/a/b/noext'), '');
});

test('cleanNsToMs：纳秒字符串与毫秒兼容', function () {
  assert.equal(cleanNsToMs(ns(NOW)), NOW);
  assert.equal(cleanNsToMs(String(NOW)), NOW);
  assert.equal(cleanNsToMs('0'), 0);
  assert.equal(cleanNsToMs(''), 0);
});

test('cleanIsRecent：最近 N 天修改不列入，边界外的列入', function () {
  assert.equal(cleanIsRecent(ns(NOW - 1 * DAY), NOW, 7), true);
  assert.equal(cleanIsRecent(ns(NOW - 6.9 * DAY), NOW, 7), true);
  assert.equal(cleanIsRecent(ns(NOW - 7.1 * DAY), NOW, 7), false);
  assert.equal(cleanIsRecent('0', NOW, 7), false);
});

test('cleanLargeReason：>100MB 命中，等于阈值不命中', function () {
  assert.match(cleanLargeReason(row(HOME + '/Downloads/x.iso', FF_CLEAN_LARGE + 1, 400), FF_CLEAN_LARGE), /大文件/);
  assert.equal(cleanLargeReason(row(HOME + '/Downloads/y.iso', FF_CLEAN_LARGE, 400), FF_CLEAN_LARGE), null);
});

test('cleanUnusedReason：>180 天命中，ctime 兜底，时间缺失不命中', function () {
  assert.match(cleanUnusedReason(row(HOME + '/Downloads/old.zip', 1024, 400), NOW, 180), /180 天/);
  assert.equal(cleanUnusedReason(row(HOME + '/Downloads/new.zip', 1024, 10), NOW, 180), null);
  var noMtime = { path: HOME + '/x', size: 10, mtime_ns: '0', ctime_ns: ns(NOW - 400 * DAY) };
  assert.match(cleanUnusedReason(noMtime, NOW, 180), /180 天/);
  assert.equal(cleanUnusedReason({ path: HOME + '/x', size: 10, mtime_ns: '0', ctime_ns: '0' }, NOW, 180), null);
});

test('cleanInstallerReason：仅 Downloads 下的旧安装包命中', function () {
  assert.match(cleanInstallerReason(row(HOME + '/Downloads/old.dmg', 1024, 90), HOME, NOW, 30), /安装包/);
  assert.equal(cleanInstallerReason(row(HOME + '/Desktop/old.dmg', 1024, 90), HOME, NOW, 30), null);
  assert.equal(cleanInstallerReason(row(HOME + '/Downloads/new.dmg', 1024, 2), HOME, NOW, 30), null);
  assert.equal(cleanInstallerReason(row(HOME + '/Downloads/old.exe', 1024, 90), HOME, NOW, 30), null);
});

test('cleanProtect：凭据/密钥逐条拒绝', function () {
  var cases = [
    [HOME + '/.ssh/id_rsa', '凭据'],
    [HOME + '/.gnupg/pubring.kbx', '凭据'],
    [HOME + '/.aws/credentials', '凭据'],
    [HOME + '/.kube/config', '凭据'],
    [HOME + '/proj/.env', '凭据'],
    [HOME + '/proj/server.pem', '凭据'],
    [HOME + '/proj/tls.key', '凭据'],
    [HOME + '/proj/cert.p12', '凭据'],
    [HOME + '/.credentials.yaml', '凭据']
  ];
  for (var i = 0; i < cases.length; i++) {
    var r = cleanProtect(cases[i][0], HOME);
    assert.ok(r && r.protected, cases[i][0] + ' 应被拒绝');
    assert.match(r.reason, /凭据|密钥|无法恢复/);
  }
});

test('cleanProtect：模型权重/下载物「长得像缓存不等于缓存」逐条拒绝', function () {
  var cases = [
    HOME + '/.ollama/models/blobs/sha256-abc',
    HOME + '/.lmstudio/models/llama.gguf',
    HOME + '/.cache/huggingface/hub/models--x',
    HOME + '/.cache/torch/hub/checkpoints/x.pth',
    HOME + '/.cache/whisper/base.pt',
    HOME + '/.cache/tensorflow/x.pb',
    HOME + '/.cache/wandb/run-1/files/x'
  ];
  for (var i = 0; i < cases.length; i++) {
    var r = cleanProtect(cases[i], HOME);
    assert.ok(r && r.protected, cases[i] + ' 应被拒绝');
    assert.match(r.reason, /模型|下载物|缓存/);
  }
});

test('cleanProtect：在用解释器/锁文件/记忆计划技能/自身数据逐条拒绝', function () {
  var cases = [
    [HOME + '/.cache/pypoetry/virtualenvs/env-1/bin/python', /解释器/],
    [HOME + '/proj/package.json', /锁文件|源码/],
    [HOME + '/proj/package-lock.json', /锁文件|源码/],
    [HOME + '/proj/pnpm-lock.yaml', /锁文件|源码/],
    [HOME + '/proj/yarn.lock', /锁文件|源码/],
    [HOME + '/proj/Cargo.lock', /锁文件|源码/],
    [HOME + '/.dsh/skills/x/SKILL.md', /记忆|计划|技能|配置/],
    [HOME + '/.claude/skills/x.md', /记忆|计划|技能|配置/],
    [HOME + '/.codex/config.toml', /记忆|计划|技能|配置/],
    [HOME + '/.config/flowfile/settings.json', /记忆|计划|技能|配置/],
    [HOME + '/.flowfile/RESTORE-MANIFEST-x.json', /自身|FlowFile/]
  ];
  for (var i = 0; i < cases.length; i++) {
    var r = cleanProtect(cases[i][0], HOME);
    assert.ok(r && r.protected, cases[i][0] + ' 应被拒绝');
    assert.match(r.reason, cases[i][1]);
  }
});

test('cleanProtect：/Volumes 与 SMB 一律排除、越界路径排除、隐藏点目录段排除', function () {
  var out = [
    ['/Volumes/QuickSwap/a.iso', /Volumes|SMB|用户目录/],
    ['//NAS/share/a.iso', /Volumes|SMB|用户目录/],
    ['/etc/passwd', /用户目录/],
    [HOME + '/Library/.hiddenCache/x.bin', /隐藏点目录|隐藏目录/]
  ];
  for (var i = 0; i < out.length; i++) {
    var r = cleanProtect(out[i][0], HOME);
    assert.ok(r && r.protected, out[i][0] + ' 应被拒绝');
    assert.match(r.reason, out[i][1]);
  }
  assert.equal(cleanProtect(HOME + '/Downloads/old.dmg', HOME), null);
  assert.equal(cleanProtect(HOME + '/Desktop/big.mov', HOME), null);
});

test('cleanAllowedRoot：只允许 homedir()，排除 /Volumes 与 SMB', function () {
  assert.equal(cleanAllowedRoot(HOME + '/Downloads/a.dmg', HOME), true);
  assert.equal(cleanAllowedRoot('/Volumes/QuickSwap/a.dmg', HOME), false);
  assert.equal(cleanAllowedRoot('/etc/a', HOME), false);
});

test('cleanCandidateFromRow：大文件候选结构完整，含 scanned 锁', function () {
  var c = cleanCandidateFromRow(row(HOME + '/Desktop/big.mov', 500 * 1024 * 1024, 400), { home: HOME, nowMs: NOW });
  assert.ok(c);
  assert.equal(c.path, HOME + '/Desktop/big.mov');
  assert.equal(c.category, 'large');
  assert.ok(c.categories.indexOf('large') >= 0);
  assert.ok(c.categories.indexOf('unused') >= 0);
  assert.equal(c.scanned_size, 500 * 1024 * 1024);
  assert.equal(c.scanned_mtime, c.mtime_ns);
  assert.equal(typeof c.reason, 'string');
  assert.ok(c.risk === 'low' || c.risk === 'medium');
  assert.equal(c.size, 500 * 1024 * 1024);
  assert.equal(c.ext, '.mov');
});

test('cleanCandidateFromRow：多规则命中合并、主类别优先级 duplicate > installer > large > unused', function () {
  var d = cleanCandidateFromRow(row(HOME + '/Downloads/old.iso', 600 * 1024 * 1024, 400), { home: HOME, nowMs: NOW });
  assert.ok(d);
  assert.ok(d.categories.length >= 3, '应同时命中 installer/large/unused');
  assert.equal(d.category, 'installer');
});

test('cleanCandidatesFromRows：最近 N 天不列入、保护清单过滤、/Volumes 排除', function () {
  var rows = [
    row(HOME + '/Desktop/recent.mov', 500 * 1024 * 1024, 1),
    row(HOME + '/Desktop/old.mov', 500 * 1024 * 1024, 400),
    row(HOME + '/.ssh/id_rsa', 500 * 1024 * 1024, 400),
    row('/Volumes/QuickSwap/big.iso', 500 * 1024 * 1024, 400),
    row(HOME + '/Downloads/x.txt', 10, 400)
  ];
  var out = cleanCandidatesFromRows(rows, { home: HOME, nowMs: NOW });
  var paths = out.map(function (x) { return x.path; });
  assert.ok(paths.indexOf(HOME + '/Desktop/old.mov') >= 0, '400 天的大文件应列入');
  assert.equal(paths.indexOf(HOME + '/Desktop/recent.mov'), -1, '最近 7 天修改不列入');
  assert.equal(paths.indexOf(HOME + '/.ssh/id_rsa'), -1, '凭据段不列入');
  assert.equal(paths.indexOf('/Volumes/QuickSwap/big.iso'), -1, '/Volumes 一律排除');
  assert.ok(paths.indexOf(HOME + '/Downloads/x.txt') >= 0, '10 字节但 400 天未使用，按定稿 §4.1 久未使用规则也应列入');
});

test('cleanCandidatesFromRows：上限 FF_CLEAN_MAX 截断且按 size 降序', function () {
  var rows = [];
  for (var i = 0; i < FF_CLEAN_MAX + 50; i++) {
    rows.push(row(HOME + '/Downloads/f' + i + '.iso', 200 * 1024 * 1024 + i, 400));
  }
  var out = cleanCandidatesFromRows(rows, { home: HOME, nowMs: NOW });
  assert.equal(out.length, FF_CLEAN_MAX);
  assert.ok(out[0].size >= out[out.length - 1].size);
});

test('cleanKeepOf：保留最早修改、路径最短、非 SMB 的一份', function () {
  var g = [
    row('/Volumes/S/a.iso', 100, 400),
    row(HOME + '/Downloads/a.iso', 100, 300),
    row(HOME + '/a.iso', 100, 500)
  ];
  assert.equal(cleanKeepOf(g), HOME + '/a.iso');
});

test('cleanDuplicateCandidates：按 (size,hash_full) 分桶、排除 keep、只认 hash_state=full', function () {
  var rows = [
    row(HOME + '/a/orig.bin', 1000, 500, { hash_full: 'H1', hash_state: 'full' }),
    row(HOME + '/b/copy.bin', 1000, 400, { hash_full: 'H1', hash_state: 'full' }),
    row(HOME + '/c/copy2.bin', 1000, 300, { hash_full: 'H1', hash_state: 'full' }),
    row(HOME + '/d/solo.bin', 1000, 300, { hash_full: 'H2', hash_state: 'full' }),
    row(HOME + '/e/unhashed.bin', 1000, 300, { hash_full: '', hash_state: 'partial' })
  ];
  var out = cleanDuplicateCandidates(rows, { home: HOME, nowMs: NOW });
  assert.equal(out.length, 2, 'H1 组排除 keep 后剩 2 个副本');
  for (var i = 0; i < out.length; i++) {
    assert.equal(out[i].category, 'duplicate');
    assert.match(out[i].reason, /重复/);
  }
  var paths = out.map(function (x) { return x.path; });
  assert.equal(paths.indexOf(HOME + '/a/orig.bin'), -1, 'keep 那份不列入');
  assert.equal(paths.indexOf(HOME + '/e/unhashed.bin'), -1, '未完成 hash 的不列入');
});

test('cleanDedupeByHash：同 hash_full 只列一份并记 groupSize，无 hash 按路径', function () {
  var list = [
    { path: '/a/x', hash_full: 'H', size: 10 },
    { path: '/b/y', hash_full: 'H', size: 10 },
    { path: '/c/z', hash_full: '', size: 10 },
    { path: '/c/z', hash_full: '', size: 10 }
  ];
  var r = cleanDedupeByHash(list);
  assert.equal(r.items.length, 2);
  assert.equal(r.items[0].groupSize, 2);
  assert.equal(r.dropped, 2);
});

test('cleanMergeCandidates：同路径多来源合并 categories，不产生重复条目', function () {
  var a = [
    { path: '/a/x', category: 'large', categories: ['large'], reasons: ['大'], reason: '大', size: 1, scanned_size: 1, scanned_mtime: '1' },
    { path: '/a/x', category: 'duplicate', categories: ['duplicate'], reasons: ['重'], reason: '重', size: 1, scanned_size: 1, scanned_mtime: '1' }
  ];
  var out = cleanMergeCandidates(a);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].categories, ['large', 'duplicate']);
  assert.equal(out[0].category, 'duplicate', 'duplicate 优先级更高');
});

test('cleanStale：大小或 mtime 与扫描时不一致即硬停止跳过', function () {
  var c = { scanned_size: 100, scanned_mtime: '123456' };
  assert.equal(cleanStale(c, { size: 100, mtimeNs: '123456' }).stale, false);
  assert.equal(cleanStale(c, { size: 101, mtimeNs: '123456' }).stale, true);
  assert.equal(cleanStale(c, { size: 100, mtimeNs: '999' }).stale, true);
  assert.equal(cleanStale(c, null).stale, true);
  assert.match(cleanStale(c, { size: 101, mtimeNs: '123456' }).reason, /重新扫描|变化/);
});

test('cleanCheckMap：清理批次默认全不勾（反 Mole 的默认全勾）', function () {
  var m = cleanCheckMap([{ id: 1 }, { id: 2 }]);
  assert.deepEqual(m, { 1: false, 2: false });
});

test('cleanSummary：候选数、总字节、按类别分组', function () {
  var list = [
    { category: 'large', size: 100 },
    { category: 'large', size: 200 },
    { category: 'duplicate', size: 50 }
  ];
  var s = cleanSummary(list);
  assert.equal(s.count, 3);
  assert.equal(s.bytes, 350);
  assert.equal(s.byCategory.large.count, 2);
  assert.equal(s.byCategory.large.bytes, 300);
  assert.equal(s.byCategory.duplicate.count, 1);
});
