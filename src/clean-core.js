// FlowFile 清理 P0 · 纯逻辑核心（零依赖、零模板字符串）
// 同一份源码：node --test 直接 import；scripts/build.mjs 剥 export 前缀后拼进 client bundle。
// 依据 flowfile/docs/FlowFile-第3轮规格-清理-定稿.md §4：借鉴 Mole「怎么删」，不照搬「清什么」。

export const FF_CLEAN_LARGE = 100 * 1024 * 1024;
export const FF_CLEAN_UNUSED_DAYS = 180;
export const FF_CLEAN_RECENT_DAYS = 7;
export const FF_CLEAN_INSTALLER_DAYS = 30;
export const FF_CLEAN_MAX = 400;
export const FF_CLEAN_INSTALLER_EXT = ['.dmg', '.pkg', '.zip', '.iso'];
export const FF_CLEAN_CATEGORY_LABEL = { large: '大文件', unused: '久未使用', installer: '旧安装包', duplicate: '重复副本' };
var FF_CLEAN_PRIORITY = ['duplicate', 'installer', 'large', 'unused'];
var FF_CLEAN_DAY_MS = 86400000;

export function cleanBase(p) {
  var s = String(p || '');
  var i = s.lastIndexOf('/');
  return i < 0 ? s : s.slice(i + 1);
}

export function cleanExt(p) {
  var b = cleanBase(p).toLowerCase();
  var i = b.lastIndexOf('.');
  return i <= 0 ? '' : b.slice(i);
}

export function cleanNsToMs(v) {
  var s = String(v == null ? '' : v);
  if (!s || !/^\d+$/.test(s)) return 0;
  var n;
  try { n = BigInt(s); } catch (e) { return 0; }
  if (n > 1000000000000000n) n = n / 1000000n;
  return Number(n);
}

export function cleanIsRecent(mtimeNs, nowMs, days) {
  var ms = cleanNsToMs(mtimeNs);
  if (!ms) return false;
  return (nowMs - ms) < days * FF_CLEAN_DAY_MS;
}

export function cleanLargeReason(row, threshold) {
  var size = Number((row && row.size) || 0);
  var t = threshold == null ? FF_CLEAN_LARGE : threshold;
  if (size > t) return '大文件（超过 ' + Math.round(t / 1048576) + ' MB）';
  return null;
}

export function cleanUnusedReason(row, nowMs, days) {
  var d = days == null ? FF_CLEAN_UNUSED_DAYS : days;
  var ms = cleanNsToMs(row && row.mtime_ns) || cleanNsToMs(row && row.ctime_ns);
  if (!ms) return null;
  if (nowMs - ms > d * FF_CLEAN_DAY_MS) return '久未使用（超过 ' + d + ' 天未修改）';
  return null;
}

export function cleanInstallerReason(row, home, nowMs, days) {
  var d = days == null ? FF_CLEAN_INSTALLER_DAYS : days;
  var p = String((row && row.path) || '');
  var h = String(home || '').replace(/\/$/, '');
  if (p.indexOf(h + '/Downloads/') !== 0) return null;
  var ext = cleanExt(p);
  if (FF_CLEAN_INSTALLER_EXT.indexOf(ext) < 0) return null;
  var ms = cleanNsToMs(row && row.mtime_ns);
  if (ms && (nowMs - ms) < d * FF_CLEAN_DAY_MS) return null;
  return '旧安装包（Downloads 中超过 ' + d + ' 天的 ' + ext + '）';
}

export function cleanProtect(p, home) {
  p = String(p || '');
  var h = String(home || '').replace(/\/$/, '');
  if (p.indexOf('/Volumes') === 0 || p.indexOf('//') === 0) {
    return { protected: true, reason: '/Volumes 与 SMB 网络卷一律排除（本轮不碰）' };
  }
  if (!h || (p !== h && p.indexOf(h + '/') !== 0)) {
    return { protected: true, reason: '不在用户目录（homedir）白名单内' };
  }
  var rel = p.indexOf(h + '/') === 0 ? p.slice(h.length + 1) : '';
  var segs = rel ? rel.split('/') : [];
  var nameLower = cleanBase(p).toLowerCase();
  var ext = cleanExt(p);
  var i, j;

  var credSegs = ['.ssh', '.gnupg', '.aws', '.kube'];
  for (i = 0; i < segs.length; i++) {
    if (credSegs.indexOf(segs[i].toLowerCase()) >= 0) {
      return { protected: true, reason: '凭据/密钥目录，删除后可能无法恢复登录与加密能力，一律保护' };
    }
  }
  var credNames = ['.credentials.yaml', 'id_rsa', 'id_ed25519', '.env'];
  if (credNames.indexOf(nameLower) >= 0 || ['.pem', '.key', '.p12'].indexOf(ext) >= 0) {
    return { protected: true, reason: '凭据/密钥文件，删除后可能无法恢复，一律保护' };
  }

  var modelPrefixes = ['.ollama/models/', '.lmstudio/models/', '.cache/huggingface/', '.cache/torch/', '.cache/whisper/', '.cache/tensorflow/', '.cache/wandb/'];
  for (i = 0; i < modelPrefixes.length; i++) {
    if (rel.indexOf(modelPrefixes[i]) === 0) {
      return { protected: true, reason: '模型权重/下载物，长得像缓存但重装成本高，一律保护' };
    }
  }
  if (rel.indexOf('.cache/pypoetry/virtualenvs/') === 0) {
    return { protected: true, reason: '在用 Python 解释器（virtualenvs），一律保护' };
  }
  var lockNames = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'cargo.lock'];
  if (lockNames.indexOf(nameLower) >= 0) {
    return { protected: true, reason: '项目源码/锁文件，不属于清理候选，一律保护' };
  }
  var memPrefixes = ['.dsh/', '.claude/skills/', '.codex/', '.config/flowfile/'];
  for (i = 0; i < memPrefixes.length; i++) {
    if (rel.indexOf(memPrefixes[i]) === 0) {
      return { protected: true, reason: '记忆/计划/技能/配置数据，一律保护' };
    }
  }
  if (rel.indexOf('.flowfile/') === 0) {
    return { protected: true, reason: 'FlowFile 自身数据（回收站清单/索引），一律保护' };
  }
  for (i = 0; i < segs.length - 1; i++) {
    if (segs[i].charAt(0) === '.' && segs[i].length > 1) {
      return { protected: true, reason: '隐藏点目录，默认不枚举、不列入' };
    }
  }
  return null;
}

export function cleanAllowedRoot(p, home) {
  p = String(p || '');
  var h = String(home || '').replace(/\/$/, '');
  if (p.indexOf('/Volumes') === 0 || p.indexOf('//') === 0) return false;
  return !!h && (p === h || p.indexOf(h + '/') === 0);
}

function makeCandidate(row, cats, reasons, opts) {
  var cat = 'unused';
  for (var m = 0; m < FF_CLEAN_PRIORITY.length; m++) {
    if (cats.indexOf(FF_CLEAN_PRIORITY[m]) >= 0) { cat = FF_CLEAN_PRIORITY[m]; break; }
  }
  var risk = (cat === 'duplicate' || cat === 'installer') ? 'low' : 'medium';
  var size = Number(row.size || 0);
  var mtimeNs = String(row.mtime_ns || '0');
  return {
    path: String(row.path || ''),
    name: String(row.name || cleanBase(row.path)),
    ext: cleanExt(row.path),
    size: size,
    mtime_ns: mtimeNs,
    category: cat,
    categories: cats.slice(),
    reasons: reasons.slice(),
    reason: reasons.join('；'),
    risk: risk,
    scanned_size: size,
    scanned_mtime: mtimeNs
  };
}

export function cleanCandidateFromRow(row, opts) {
  opts = opts || {};
  var home = opts.home || '';
  var nowMs = opts.nowMs || Date.now();
  if (!row || row.is_dir || row.missing) return null;
  var p = String(row.path || '');
  if (cleanProtect(p, home)) return null;
  if (!cleanAllowedRoot(p, home)) return null;
  if (cleanIsRecent(row.mtime_ns, nowMs, FF_CLEAN_RECENT_DAYS)) return null;
  var cats = [], reasons = [];
  var lr = cleanLargeReason(row, FF_CLEAN_LARGE);
  if (lr) { cats.push('large'); reasons.push(lr); }
  var ur = cleanUnusedReason(row, nowMs, FF_CLEAN_UNUSED_DAYS);
  if (ur) { cats.push('unused'); reasons.push(ur); }
  var ir = cleanInstallerReason(row, home, nowMs, FF_CLEAN_INSTALLER_DAYS);
  if (ir) { cats.push('installer'); reasons.push(ir); }
  if (!cats.length) return null;
  return makeCandidate(row, cats, reasons, opts);
}

export function cleanCandidatesFromRows(rows, opts) {
  var out = [];
  for (var i = 0; i < (rows || []).length; i++) {
    var c = cleanCandidateFromRow(rows[i], opts);
    if (c) out.push(c);
  }
  var merged = cleanMergeCandidates(out);
  merged.sort(function (a, b) { return b.size - a.size; });
  if (merged.length > FF_CLEAN_MAX) merged = merged.slice(0, FF_CLEAN_MAX);
  return merged;
}

export function cleanKeepOf(group) {
  if (!group || !group.length) return '';
  var arr = group.slice();
  arr.sort(function (a, b) {
    var am = BigInt(String(a.mtime_ns || '0'));
    var bm = BigInt(String(b.mtime_ns || '0'));
    if (am !== bm) return am < bm ? -1 : 1;
    var al = String(a.path || '').length, bl = String(b.path || '').length;
    if (al !== bl) return al - bl;
    var as = String(a.path || '').indexOf('/Volumes') === 0 ? 1 : 0;
    var bs = String(b.path || '').indexOf('/Volumes') === 0 ? 1 : 0;
    return as - bs;
  });
  return arr[0].path;
}

export function cleanDuplicateCandidates(rows, opts) {
  opts = opts || {};
  var home = opts.home || '';
  var nowMs = opts.nowMs || Date.now();
  var buckets = {}, order = [], i, j, k;
  for (i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (!r || r.is_dir || r.missing) continue;
    var h = String(r.hash_full || '');
    if (!h || r.hash_state !== 'full') continue;
    var key = String(r.size || 0) + ':' + h;
    if (!buckets[key]) { buckets[key] = []; order.push(key); }
    buckets[key].push(r);
  }
  var out = [];
  for (k = 0; k < order.length; k++) {
    var g = buckets[order[k]];
    if (g.length < 2) continue;
    var keep = cleanKeepOf(g);
    for (j = 0; j < g.length; j++) {
      var r2 = g[j];
      if (r2.path === keep) continue;
      var p = String(r2.path || '');
      if (cleanProtect(p, home) || !cleanAllowedRoot(p, home)) continue;
      if (cleanIsRecent(r2.mtime_ns, nowMs, FF_CLEAN_RECENT_DAYS)) continue;
      var base = cleanCandidateFromRow(r2, opts);
      var cats = ['duplicate'].concat(base ? base.categories : []);
      var reasons = ['重复副本（同内容已有建议保留的一份）'].concat(base ? base.reasons : []);
      var seen = {}, cats2 = [];
      for (var x = 0; x < cats.length; x++) if (!seen[cats[x]]) { seen[cats[x]] = 1; cats2.push(cats[x]); }
      var c = makeCandidate(r2, cats2, reasons, opts);
      c.groupSize = g.length;
      c.keep = keep;
      out.push(c);
    }
  }
  return cleanMergeCandidates(out);
}

export function cleanDedupeByHash(list) {
  var hashCount = {}, pathCount = {}, i, h;
  for (i = 0; i < (list || []).length; i++) {
    h = String(list[i].hash_full || '');
    if (h) hashCount[h] = (hashCount[h] || 0) + 1;
    else pathCount[String(list[i].path)] = (pathCount[String(list[i].path)] || 0) + 1;
  }
  var seenHash = {}, seenPath = {}, items = [], dropped = 0;
  for (i = 0; i < (list || []).length; i++) {
    var it = list[i];
    h = String(it.hash_full || '');
    if (h) {
      if (seenHash[h]) { dropped++; continue; }
      seenHash[h] = 1;
      items.push(Object.assign({}, it, { groupSize: hashCount[h] }));
    } else {
      var pk = String(it.path);
      if (seenPath[pk]) { dropped++; continue; }
      seenPath[pk] = 1;
      items.push(Object.assign({}, it, { groupSize: 1 }));
    }
  }
  return { items: items, dropped: dropped };
}

export function cleanMergeCandidates(list) {
  var byPath = {}, order = [], i, j, k;
  for (i = 0; i < (list || []).length; i++) {
    var c = list[i];
    var p = c.path;
    if (!byPath[p]) {
      var t = Object.assign({}, c);
      t.categories = (c.categories || [c.category]).slice();
      t.reasons = (c.reasons || [c.reason]).slice();
      byPath[p] = t;
      order.push(p);
    } else {
      var e = byPath[p];
      var cs = c.categories || [c.category];
      for (j = 0; j < cs.length; j++) if (e.categories.indexOf(cs[j]) < 0) e.categories.push(cs[j]);
      var rs = c.reasons || [c.reason];
      for (j = 0; j < rs.length; j++) if (e.reasons.indexOf(rs[j]) < 0) e.reasons.push(rs[j]);
    }
  }
  var out = [];
  for (k = 0; k < order.length; k++) {
    var f = byPath[order[k]];
    var cat = 'unused';
    for (var m = 0; m < FF_CLEAN_PRIORITY.length; m++) {
      if (f.categories.indexOf(FF_CLEAN_PRIORITY[m]) >= 0) { cat = FF_CLEAN_PRIORITY[m]; break; }
    }
    f.category = cat;
    f.reason = f.reasons.join('；');
    out.push(f);
  }
  return out;
}

export function cleanStale(c, current) {
  if (!current) return { stale: true, reason: '无法读取当前文件状态，请重新扫描' };
  var sizeOk = Number(c && c.scanned_size) === Number(current.size);
  var mOk = String(c && c.scanned_mtime) === String(current.mtimeNs);
  if (sizeOk && mOk) return { stale: false, reason: '' };
  return { stale: true, reason: '文件在扫描后发生变化，请重新扫描后再执行' };
}

export function cleanCheckMap(items) {
  var m = {};
  for (var i = 0; i < (items || []).length; i++) m[items[i].id] = false;
  return m;
}

export function cleanScanStamp(st) {
  if (!st) return { size: 0, mtimeNs: '0' };
  var size = Number(st.size || 0);
  var mtimeNs;
  try {
    mtimeNs = String(st.mtimeNs || BigInt(Math.floor(st.mtimeMs || (st.mtime && st.mtime.getTime()) || 0) * 1e6));
  } catch (e) { mtimeNs = '0'; }
  return { size: size, mtimeNs: mtimeNs };
}

export function cleanSummary(list) {
  var s = { count: 0, bytes: 0, byCategory: {} };
  for (var i = 0; i < (list || []).length; i++) {
    var x = list[i], sz = Number(x.size || 0), cat = x.category || 'unused';
    s.count++; s.bytes += sz;
    if (!s.byCategory[cat]) s.byCategory[cat] = { count: 0, bytes: 0 };
    s.byCategory[cat].count++;
    s.byCategory[cat].bytes += sz;
  }
  return s;
}
