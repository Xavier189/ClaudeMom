//! Claude Code 会话在 3p 模式与完整功能模式之间的同步：
//! 两种部署模式用不同的 Application Support 目录，会话元数据各存一份
//! `claude-code-sessions/<account>/<org>/local_<uuid>.json`；对话记录（transcript）
//! 在各自的 CLAUDE_CONFIG_DIR 下 `projects/<escaped cwd>/<cliSessionId>.jsonl`，
//! 早期 3p 会话的记录还在 `~/.claude`。`local-agent-mode-sessions`（Cowork）不同步。
use anyhow::Result;
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

/// 完整功能模式的 mock 账号/组织（与 tools/claude-local/proxy.mjs 里的 ACCOUNT.id / ORG.uuid 一致）。
pub const FULL_ACCOUNT: &str = "c46bd1eb-fbbf-4e5a-9bb3-5ebe8521eb54";
pub const FULL_ORG: &str = "e0e877d3-8475-44a1-a501-4fc431b085ab";

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub to_full: usize,
    pub to_three_p: usize,
    pub updated: usize,
    pub skipped_deleted: usize,
    /// 元数据有但两边都找不到的 transcript 条数。
    pub missing_transcripts: usize,
    /// 3p 侧还没有会话目录时的说明；正常情况下为空。
    #[serde(skip_serializing_if = "String::is_empty")]
    pub note: String,
}

const LOCAL_PREFIX: &str = "local_";
const DELETED_PREFIX: &str = "deleted_";
const ARCHIVED_INDEX_FILE: &str = "archived-sessions.idx";

#[derive(Clone, Debug)]
struct Tombstone {
    canonical_id: String,
    ts_ms: Option<f64>,
    raw: String,
}

fn local_session_id(name: &str) -> Option<String> {
    name.strip_prefix(LOCAL_PREFIX)?
        .strip_suffix(".json")
        .map(str::to_string)
}

/// 解析 Claude Desktop 的删除墓碑文件名：`deleted_<id>`（现版无 `.json`）或兼容 `deleted_<id>.json`。
pub(crate) fn tombstone_id(name: &str) -> Option<&str> {
    let rest = name.strip_prefix(DELETED_PREFIX)?;
    let id = rest.strip_suffix(".json").unwrap_or(rest);
    (!id.is_empty() && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'))
        .then_some(id)
}

fn parse_tombstone(path: &Path, id: &str) -> Tombstone {
    let raw = fs::read_to_string(path).unwrap_or_default();
    let trimmed = raw.trim();
    let ts_ms = (!trimmed.is_empty())
        .then(|| trimmed.parse::<f64>().ok())
        .flatten()
        .filter(|ts| ts.is_finite() && *ts > 0.0);
    Tombstone {
        canonical_id: id.to_string(),
        ts_ms,
        raw,
    }
}

fn merge_tombstone(map: &mut HashMap<String, Tombstone>, key: String, incoming: Tombstone) {
    match map.get_mut(&key) {
        None => {
            map.insert(key, incoming);
        }
        Some(cur) => match (cur.ts_ms, incoming.ts_ms) {
            (Some(a), Some(b)) if b > a => *cur = incoming,
            (None, Some(_)) => *cur = incoming,
            _ => {}
        },
    }
}

/// `claude-code-sessions/<acct>/<org>/` 里含 `local_*.json`（退回含 `deleted_*`）且最新 mtime 最大的一对目录。
fn newest_pair(root: &Path) -> Option<(String, String)> {
    let mut best_local: Option<(String, String, SystemTime)> = None;
    let mut best_deleted: Option<(String, String, SystemTime)> = None;
    for acct in fs::read_dir(root).ok()?.flatten() {
        let acct_path = acct.path();
        if !acct_path.is_dir() {
            continue;
        }
        let acct_name = acct.file_name().to_string_lossy().into_owned();
        for org in fs::read_dir(&acct_path).ok()?.flatten() {
            let org_path = org.path();
            if !org_path.is_dir() {
                continue;
            }
            let org_name = org.file_name().to_string_lossy().into_owned();
            for entry in fs::read_dir(&org_path).ok()?.flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                let Ok(mtime) = entry.metadata().and_then(|meta| meta.modified()) else {
                    continue;
                };
                if local_session_id(&name).is_some() {
                    if best_local.as_ref().is_none_or(|(_, _, t)| mtime > *t) {
                        best_local = Some((acct_name.clone(), org_name.clone(), mtime));
                    }
                } else if tombstone_id(&name).is_some()
                    && best_deleted.as_ref().is_none_or(|(_, _, t)| mtime > *t)
                {
                    best_deleted = Some((acct_name.clone(), org_name.clone(), mtime));
                }
            }
        }
    }
    best_local.or(best_deleted).map(|(a, o, _)| (a, o))
}

fn list_dir(dir: &Path) -> (Vec<String>, HashMap<String, Tombstone>) {
    let mut locals = Vec::new();
    let mut tombstones = HashMap::new();
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = local_session_id(&name) {
            locals.push(id);
        } else if let Some(id) = tombstone_id(&name) {
            let tomb = parse_tombstone(&entry.path(), id);
            merge_tombstone(&mut tombstones, id.to_ascii_lowercase(), tomb);
        }
    }
    locals.sort();
    (locals, tombstones)
}

fn file_mtime(path: &Path) -> Option<SystemTime> {
    fs::metadata(path).ok()?.modified().ok()
}

fn file_mtime_secs(path: &Path) -> Option<f64> {
    file_mtime(path)?
        .duration_since(SystemTime::UNIX_EPOCH)
        .ok()
        .map(|d| d.as_secs_f64())
}

fn file_mtime_ms(path: &Path) -> Option<f64> {
    file_mtime_secs(path).map(|s| s * 1000.0)
}

/// 会话用于判定「新对话进展」的活跃度：JSON 里的 `lastActivityAt`，缺失时退回文件 mtime（秒）。
fn activity_score(path: &Path, meta: &Value) -> f64 {
    if let Some(activity) = meta.get("lastActivityAt").and_then(Value::as_f64) {
        return activity;
    }
    file_mtime_secs(path).unwrap_or(0.0)
}

fn is_archived(meta: &Value) -> bool {
    meta.get("isArchived").and_then(Value::as_bool) == Some(true)
}

/// 同名会话两端内容不同时，决定是否用 `src` 覆盖 `dst`。
/// `lastActivityAt` 优先；若仅归档状态 (`isArchived`) 变化而 `lastActivityAt` 未变，则按文件 mtime 决胜。
fn should_overwrite(src: &Path, src_meta: &Value, dst: &Path, dst_meta: &Value) -> bool {
    let src_act = activity_score(src, src_meta);
    let dst_act = activity_score(dst, dst_meta);
    if src_act > dst_act {
        return true;
    }
    if src_act < dst_act {
        return false;
    }
    if is_archived(src_meta) != is_archived(dst_meta) {
        return matches!((file_mtime(src), file_mtime(dst)), (Some(s), Some(d)) if s > d);
    }
    false
}

/// 条目自身及关联过的全部 CLI 会话 ID（删除任一 ID 均视为同一条会话被删除）。
fn session_claim_ids(file_id: &str, meta: Option<&Value>) -> Vec<String> {
    let mut ids = vec![file_id.to_string()];
    let Some(meta) = meta else {
        return ids;
    };
    let mut push = |id: &str| {
        if !ids.iter().any(|known| known.eq_ignore_ascii_case(id)) {
            ids.push(id.to_string());
        }
    };
    for key in ["cliSessionId", "unarchivedCliSessionId", "preClearCliSessionId"] {
        if let Some(id) = meta.get(key).and_then(Value::as_str) {
            push(id);
        }
    }
    for key in ["priorCliSessionIds", "overflowCliSessionIds"] {
        if let Some(list) = meta.get(key).and_then(Value::as_array) {
            for id in list.iter().filter_map(Value::as_str) {
                push(id);
            }
        }
    }
    ids
}

fn matching_tombstone<'a>(
    file_id: &str,
    meta: Option<&Value>,
    tombstones: &'a HashMap<String, Tombstone>,
) -> Option<&'a Tombstone> {
    let mut best: Option<&'a Tombstone> = None;
    for claim in session_claim_ids(file_id, meta) {
        let Some(candidate) = tombstones.get(&claim.to_ascii_lowercase()) else {
            continue;
        };
        best = Some(match best {
            None => candidate,
            Some(cur) => match (cur.ts_ms, candidate.ts_ms) {
                (Some(a), Some(b)) if b > a => candidate,
                (None, Some(_)) => candidate,
                _ => cur,
            },
        });
    }
    best
}

fn is_blocked_by_tombstone(tomb: &Tombstone, meta: Option<&Value>, path: &Path) -> bool {
    let Some(del_ts) = tomb.ts_ms else {
        return true;
    };
    let act_ms = meta
        .and_then(|m| {
            m.get("lastActivityAt")
                .and_then(Value::as_f64)
                .or_else(|| m.get("createdAt").and_then(Value::as_f64))
        })
        .or_else(|| file_mtime_ms(path));
    act_ms.is_none_or(|act| act <= del_ts)
}

fn read_json(path: &Path) -> Option<Value> {
    let bytes = fs::read(path).ok()?;
    serde_json::from_slice(&bytes).ok()
}

fn write_preserving_mtime(dst: &Path, bytes: &[u8], mtime: Option<SystemTime>) -> Result<()> {
    crate::fsutil::atomic_write(dst, bytes)?;
    if let Some(mtime) = mtime {
        let _ = fs::File::options().write(true).open(dst).and_then(|file| file.set_modified(mtime));
    }
    Ok(())
}

/// Claude Code 的 projects 目录转义：cwd 里每个非 ASCII 字母数字字符换成 `-`。
fn escape_cwd(cwd: &str) -> String {
    cwd.chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn backup_stamp() -> String {
    format!(
        "{:.0}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs_f64())
            .unwrap_or(0.0)
    )
}

fn copy_dir(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)?.flatten() {
        let to = dst.join(entry.file_name());
        if entry.file_type().is_ok_and(|kind| kind.is_dir()) {
            copy_dir(&entry.path(), &to)?;
        } else {
            fs::copy(entry.path(), &to)?;
        }
    }
    Ok(())
}

/// 元数据里这条会话引用的 transcript id：cliSessionId + priorCliSessionIds。
fn transcript_ids(meta: &Value) -> Vec<String> {
    let mut ids = Vec::new();
    if let Some(id) = meta.get("cliSessionId").and_then(Value::as_str) {
        ids.push(id.to_string());
    }
    if let Some(list) = meta.get("priorCliSessionIds").and_then(Value::as_array) {
        for id in list.iter().filter_map(Value::as_str) {
            if !ids.iter().any(|known| known == id) {
                ids.push(id.to_string());
            }
        }
    }
    ids
}

fn find_transcript(configs: &[PathBuf], escaped: &str, id: &str) -> Option<PathBuf> {
    configs
        .iter()
        .map(|config| config.join("projects").join(escaped).join(format!("{id}.jsonl")))
        .find(|path| path.is_file())
}

/// 把某条会话的 transcript 从源侧候选目录补到目标侧第一个 config 目录。
/// 冲突保留字节数更大的一份（jsonl 只追加），被覆盖的先进备份。
fn sync_transcripts(
    meta: &Value,
    source_configs: &[PathBuf],
    target_configs: &[PathBuf],
    backup: &Path,
    report: &mut SyncReport,
) -> Result<()> {
    let Some(target) = target_configs.first() else {
        return Ok(());
    };
    let cwd = meta.get("cwd").and_then(Value::as_str).unwrap_or_default();
    if cwd.is_empty() {
        return Ok(());
    }
    let escaped = escape_cwd(cwd);
    for id in transcript_ids(meta) {
        let dst = target.join("projects").join(&escaped).join(format!("{id}.jsonl"));
        let src = find_transcript(source_configs, &escaped, &id)
            .or_else(|| find_transcript(target_configs, &escaped, &id));
        match (src, dst.is_file()) {
            (Some(src), false) => {
                fs::create_dir_all(dst.parent().unwrap())?;
                fs::copy(&src, &dst)?;
            }
            (Some(src), true) => {
                let src_bytes = fs::read(&src)?;
                let dst_bytes = fs::read(&dst)?;
                if src_bytes != dst_bytes && src_bytes.len() > dst_bytes.len() {
                    let backup_dir = backup.join(backup_stamp()).join("transcripts");
                    fs::create_dir_all(&backup_dir)?;
                    fs::copy(&dst, backup_dir.join(format!("{id}.jsonl")))?;
                    crate::fsutil::atomic_write(&dst, &src_bytes)?;
                }
            }
            (None, exists) if !exists => {
                report.missing_transcripts += 1;
                let _ = crate::host::diagnostic(
                    "claude_session_sync.missing_transcript",
                    serde_json::json!({"cliSessionId": id, "cwd": cwd}),
                );
            }
            _ => {}
        }
        // 同名子目录（子代理等输出）整体跟随。
        for config in source_configs {
            let dir = config.join("projects").join(&escaped).join(&id);
            if dir.is_dir() {
                let out = target.join("projects").join(&escaped).join(&id);
                if !out.exists() {
                    copy_dir(&dir, &out)?;
                }
            }
        }
    }
    Ok(())
}

fn collect_active_claims(dir: &Path, locals: &[String]) -> HashSet<String> {
    let mut claims = HashSet::new();
    for id in locals {
        let meta = read_json(&dir.join(format!("{LOCAL_PREFIX}{id}.json")));
        for claim in session_claim_ids(id, meta.as_ref()) {
            claims.insert(claim.to_ascii_lowercase());
        }
    }
    claims
}

fn prune_tombstoned_locals(
    dir: &Path,
    locals: &[String],
    tombstones: &HashMap<String, Tombstone>,
    backup: &Path,
    stamp: &str,
    label: &str,
    skipped_ids: &mut HashSet<String>,
) -> Result<()> {
    for id in locals {
        let path = dir.join(format!("{LOCAL_PREFIX}{id}.json"));
        let meta = read_json(&path);
        let Some(tomb) = matching_tombstone(id, meta.as_ref(), tombstones) else {
            continue;
        };
        if !is_blocked_by_tombstone(tomb, meta.as_ref(), &path) {
            continue;
        }
        skipped_ids.insert(id.to_ascii_lowercase());
        // 仅对带真实时间戳的墓碑清理残留副本（避免影响非时间戳测试夹具），清理前先做备份。
        if tomb.ts_ms.is_some() {
            let backup_dir = backup.join(stamp).join(format!("{label}-deleted"));
            fs::create_dir_all(&backup_dir)?;
            fs::copy(&path, backup_dir.join(format!("{LOCAL_PREFIX}{id}.json")))?;
            fs::remove_file(&path)?;
        }
    }
    Ok(())
}

fn mirror_tombstones(
    dir: &Path,
    remaining_locals: &[String],
    tombstones: &HashMap<String, Tombstone>,
) -> Result<()> {
    let active_claims = collect_active_claims(dir, remaining_locals);
    for (id_lower, tomb) in tombstones {
        if tomb.ts_ms.is_none() || active_claims.contains(id_lower) {
            continue;
        }
        let plain = dir.join(format!("{DELETED_PREFIX}{}", tomb.canonical_id));
        let legacy = dir.join(format!("{DELETED_PREFIX}{}.json", tomb.canonical_id));
        if plain.exists() || legacy.exists() {
            continue;
        }
        crate::fsutil::atomic_write(&plain, tomb.raw.as_bytes())?;
    }
    Ok(())
}

fn sync_archived_index(dir: &Path) -> Result<()> {
    let (locals, _) = list_dir(dir);
    let mut archived = Vec::new();
    for id in locals {
        let path = dir.join(format!("{LOCAL_PREFIX}{id}.json"));
        if let Some(meta) = read_json(&path)
            && is_archived(&meta)
        {
            archived.push(format!("{LOCAL_PREFIX}{id}"));
        }
    }
    archived.sort();
    archived.dedup();
    let idx_path = dir.join(ARCHIVED_INDEX_FILE);
    if archived.is_empty() {
        if idx_path.exists() {
            let _ = fs::remove_file(&idx_path);
        }
        return Ok(());
    }
    let bytes = serde_json::to_vec(&serde_json::json!({
        "v": 1,
        "archived": archived,
    }))?;
    if fs::read(&idx_path).ok().as_deref() != Some(bytes.as_slice()) {
        crate::fsutil::atomic_write(&idx_path, &bytes)?;
    }
    Ok(())
}

/// 单向合并 mine → theirs：复制缺席会话、按新鲜度（含归档状态）覆盖、补 transcript。
fn merge_dir(
    mine: &Path,
    mine_configs: &[PathBuf],
    theirs: &Path,
    their_configs: &[PathBuf],
    tombstones: &HashMap<String, Tombstone>,
    backup: &Path,
    stamp: &str,
    report: &mut SyncReport,
    direction: &str,
    skipped_ids: &mut HashSet<String>,
) -> Result<()> {
    let (mine_locals, _) = list_dir(mine);
    let (their_locals, _) = list_dir(theirs);
    let their_set: HashSet<&str> = their_locals.iter().map(String::as_str).collect();
    for id in &mine_locals {
        let src = mine.join(format!("{LOCAL_PREFIX}{id}.json"));
        let dst = theirs.join(format!("{LOCAL_PREFIX}{id}.json"));
        let src_meta = read_json(&src);
        if let Some(tomb) = matching_tombstone(id, src_meta.as_ref(), tombstones)
            && is_blocked_by_tombstone(tomb, src_meta.as_ref(), &src)
        {
            skipped_ids.insert(id.to_ascii_lowercase());
            continue;
        }
        if !their_set.contains(id.as_str()) {
            fs::create_dir_all(theirs)?;
            fs::copy(&src, &dst)?;
            if direction == "full" {
                report.to_full += 1;
            } else {
                report.to_three_p += 1;
            }
        } else {
            let src_bytes = fs::read(&src)?;
            let dst_bytes = fs::read(&dst)?;
            if src_bytes != dst_bytes {
                let (Ok(src_json), Ok(dst_json)) = (
                    serde_json::from_slice::<Value>(&src_bytes),
                    serde_json::from_slice::<Value>(&dst_bytes),
                ) else {
                    let _ = crate::host::diagnostic(
                        "claude_session_sync.bad_json",
                        serde_json::json!({"file": src.file_name().unwrap_or_default().to_string_lossy()}),
                    );
                    continue;
                };
                if should_overwrite(&src, &src_json, &dst, &dst_json) {
                    let backup_dir = backup.join(stamp).join(direction);
                    fs::create_dir_all(&backup_dir)?;
                    fs::copy(&dst, backup_dir.join(format!("{LOCAL_PREFIX}{id}.json")))?;
                    write_preserving_mtime(&dst, &src_bytes, file_mtime(&src))?;
                    report.updated += 1;
                }
            }
        }
        // 元数据到位后补 transcript（含之前同步过、当时没拷上的）。
        if let Some(meta) = read_json(&dst) {
            sync_transcripts(&meta, mine_configs, their_configs, backup, report)?;
        }
    }
    Ok(())
}

/// sessions root 指 `.../claude-code-sessions`；config 候选按优先级给出，
/// 写入目标是每个候选列表的第一个。
pub fn sync_sessions(
    three_p_root: &Path,
    three_p_configs: &[PathBuf],
    full_root: &Path,
    full_configs: &[PathBuf],
    backup_root: &Path,
) -> Result<SyncReport> {
    let mut report = SyncReport::default();
    let Some((acct, org)) = newest_pair(three_p_root) else {
        report.note = "3p 模式还没有会话".into();
        return Ok(report);
    };
    let three_p = three_p_root.join(&acct).join(&org);
    let full = full_root.join(FULL_ACCOUNT).join(FULL_ORG);
    fs::create_dir_all(&full)?;
    let stamp = backup_stamp();
    // 任一侧的墓碑都阻止复制并清理残留幽灵；同一会话只计一次。
    let (tp_locals, tp_deleted) = list_dir(&three_p);
    let (f_locals, f_deleted) = list_dir(&full);
    let mut tombstones = HashMap::new();
    for (id, tomb) in tp_deleted.into_iter().chain(f_deleted) {
        merge_tombstone(&mut tombstones, id, tomb);
    }
    let mut skipped_ids = HashSet::new();
    prune_tombstoned_locals(
        &three_p,
        &tp_locals,
        &tombstones,
        backup_root,
        &stamp,
        "three-p",
        &mut skipped_ids,
    )?;
    prune_tombstoned_locals(
        &full,
        &f_locals,
        &tombstones,
        backup_root,
        &stamp,
        "full",
        &mut skipped_ids,
    )?;
    let (tp_after_prune, _) = list_dir(&three_p);
    let (f_after_prune, _) = list_dir(&full);
    mirror_tombstones(&three_p, &tp_after_prune, &tombstones)?;
    mirror_tombstones(&full, &f_after_prune, &tombstones)?;
    merge_dir(
        &three_p,
        three_p_configs,
        &full,
        full_configs,
        &tombstones,
        backup_root,
        &stamp,
        &mut report,
        "full",
        &mut skipped_ids,
    )?;
    merge_dir(
        &full,
        full_configs,
        &three_p,
        three_p_configs,
        &tombstones,
        backup_root,
        &stamp,
        &mut report,
        "three-p",
        &mut skipped_ids,
    )?;
    report.skipped_deleted = skipped_ids.len();
    sync_archived_index(&three_p)?;
    sync_archived_index(&full)?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seed(
        root: &Path,
        acct: &str,
        org: &str,
        id: &str,
        activity: f64,
        extra: &str,
    ) {
        let dir = root.join(acct).join(org);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(format!("local_{id}.json")),
            format!(
                r#"{{"sessionId":"{id}","cliSessionId":"cli-{id}","cwd":"/Users/mac/Desktop/reclaude2api","lastActivityAt":{activity}{extra}}}"#
            ),
        )
        .unwrap();
    }

    fn transcript(config: &Path, id: &str, lines: usize) -> PathBuf {
        let file = config
            .join("projects/-Users-mac-Desktop-reclaude2api")
            .join(format!("cli-{id}.jsonl"));
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "x\n".repeat(lines)).unwrap();
        file
    }

    fn transcript_exists(config: &Path, id: &str) -> bool {
        config
            .join("projects/-Users-mac-Desktop-reclaude2api")
            .join(format!("cli-{id}.jsonl"))
            .is_file()
    }

    fn copy_dir_prep(config: &Path, id: &str) {
        let dir = config
            .join("projects/-Users-mac-Desktop-reclaude2api")
            .join(format!("cli-{id}/sub"));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("out.txt"), "o").unwrap();
    }

    #[test]
    fn escape_matches_claude_code_project_dirs() {
        assert_eq!(escape_cwd("/Users/mac/Desktop/reclaude2api"), "-Users-mac-Desktop-reclaude2api");
        assert_eq!(escape_cwd("/Users/mac/.tmp_cc"), "-Users-mac--tmp-cc");
    }

    #[test]
    fn sessions_and_transcripts_flow_both_ways() {
        let temp = tempfile::tempdir().unwrap();
        let t3 = temp.path().join("3p/sessions");
        let tf = temp.path().join("full/sessions");
        let c3 = vec![temp.path().join("3p/claude-code-3p"), temp.path().join("claude")];
        let cf = vec![temp.path().join("full/claude-code"), temp.path().join("claude")];
        let backup = temp.path().join("backup");
        seed(&t3, "a3p", "o3p", "s1", 10.0, "");
        // transcript 只在 ~/.claude 候选里也找得到。
        transcript(&c3[1], "s1", 3);
        seed(&tf, FULL_ACCOUNT, FULL_ORG, "s2", 20.0, "");
        transcript(&cf[0], "s2", 2);
        let report = sync_sessions(&t3, &c3, &tf, &cf, &backup).unwrap();
        assert_eq!((report.to_full, report.to_three_p), (1, 1));
        assert!(transcript_exists(&cf[0], "s1"));
        assert!(transcript_exists(&c3[0], "s2"));
        assert_eq!(report.missing_transcripts, 0);
    }

    #[test]
    fn prior_ids_subdirs_conflicts_and_backfill() {
        let temp = tempfile::tempdir().unwrap();
        let t3 = temp.path().join("3p/sessions");
        let tf = temp.path().join("full/sessions");
        let c3 = vec![temp.path().join("3p/claude-code-3p")];
        let cf = vec![temp.path().join("full/claude-code")];
        let backup = temp.path().join("backup");
        // priorCliSessionIds 的 transcript 也复制。
        seed(&t3, "a3p", "o3p", "s1", 30.0, r#","priorCliSessionIds":["cli-p1"]"#);
        transcript(&c3[0], "s1", 5);
        transcript(&c3[0], "p1", 1);
        // 子目录整体复制。
        copy_dir_prep(&c3[0], "s1");
        // 冲突保留大的一份 + 备份。
        transcript(&cf[0], "s1", 2);
        let dst = cf[0].join("projects/-Users-mac-Desktop-reclaude2api/cli-s1.jsonl");
        // 元数据已同步过去但 transcript 缺的会话补拷。
        seed(&t3, "a3p", "o3p", "s9", 1.0, "");
        seed(&tf, FULL_ACCOUNT, FULL_ORG, "s9", 1.0, "");
        transcript(&c3[0], "s9", 1);
        let _report = sync_sessions(&t3, &c3, &tf, &cf, &backup).unwrap();
        assert!(transcript_exists(&cf[0], "p1"));
        assert!(cf[0].join("projects/-Users-mac-Desktop-reclaude2api/cli-s1/sub").is_dir());
        assert!(transcript_exists(&cf[0], "s9"), "已有元数据缺 transcript 的也要补");
        assert!(fs::read_to_string(&dst).unwrap().lines().count() == 5, "大的那份覆盖小的");
        let stamped: Vec<_> = fs::read_dir(&backup).unwrap().flatten().collect();
        assert!(stamped.iter().any(|e| e.path().join("transcripts/cli-s1.jsonl").is_file()), "被覆盖的进备份");
        // 缺源计 missing_transcripts。
        seed(&t3, "a3p", "o3p", "gone", 1.0, "");
        let report = sync_sessions(&t3, &c3, &tf, &cf, &backup).unwrap();
        assert!(report.missing_transcripts >= 1);
    }

    #[test]
    fn tombstones_dedupe_and_other_files_untouched() {
        let temp = tempfile::tempdir().unwrap();
        let t3 = temp.path().join("3p/sessions");
        let tf = temp.path().join("full/sessions");
        let c3 = vec![temp.path().join("3p/claude-code-3p")];
        let cf = vec![temp.path().join("full/claude-code")];
        let dir3 = t3.join("a").join("o");
        fs::create_dir_all(&dir3).unwrap();
        fs::write(dir3.join("deleted_s9.json"), "{}").unwrap();
        fs::write(dir3.join("local_s9.json"), "{}").unwrap();
        fs::write(dir3.join("scheduled-tasks.json"), "[]").unwrap();
        let report = sync_sessions(&t3, &c3, &tf, &cf, &temp.path().join("backup")).unwrap();
        assert_eq!(report.skipped_deleted, 1, "墓碑按 id 去重");
        assert!(!tf.join(FULL_ACCOUNT).join(FULL_ORG).join("local_s9.json").exists());
        assert!(dir3.join("scheduled-tasks.json").exists());
    }

    #[test]
    fn desktop_plain_tombstones_prune_ghosts_and_match_cli_id() {
        let temp = tempfile::tempdir().unwrap();
        let t3 = temp.path().join("3p/sessions");
        let tf = temp.path().join("full/sessions");
        let c3 = vec![temp.path().join("3p/claude-code-3p")];
        let cf = vec![temp.path().join("full/claude-code")];
        let backup = temp.path().join("backup");

        // s1: 3p 与 full 都有残留，full 有无后缀 deleted_s1 + deleted_cli-s1（时间戳 2000 > 1000）
        seed(&t3, "a3p", "o3p", "s1", 1000.0, "");
        seed(&tf, FULL_ACCOUNT, FULL_ORG, "s1", 1000.0, "");
        let full_dir = tf.join(FULL_ACCOUNT).join(FULL_ORG);
        let three_p_dir = t3.join("a3p").join("o3p");
        fs::write(full_dir.join("deleted_s1"), "2000").unwrap();
        fs::write(full_dir.join("deleted_cli-s1"), "2000").unwrap();

        // s2: 3p 只有 local_s2.json，full 仅通过 cliSessionId 的墓碑 deleted_cli-s2 匹配拦截并清理
        seed(&t3, "a3p", "o3p", "s2", 1000.0, "");
        fs::write(full_dir.join("deleted_cli-s2"), "2000").unwrap();

        // s3: 墓碑时间 2000，但 3p 有更新对话 lastActivityAt=3000，应保留并同步
        seed(&t3, "a3p", "o3p", "s3", 3000.0, "");
        transcript(&c3[0], "s3", 2);
        fs::write(full_dir.join("deleted_s3"), "2000").unwrap();

        let report = sync_sessions(&t3, &c3, &tf, &cf, &backup).unwrap();
        assert_eq!(report.skipped_deleted, 2);
        assert_eq!(report.to_full, 1);
        assert!(!full_dir.join("local_s1.json").exists());
        assert!(!three_p_dir.join("local_s1.json").exists());
        assert!(!full_dir.join("local_s2.json").exists());
        assert!(!three_p_dir.join("local_s2.json").exists());
        assert!(three_p_dir.join("deleted_s1").is_file());
        assert!(three_p_dir.join("deleted_cli-s2").is_file());
        assert!(full_dir.join("local_s3.json").is_file());

        let stamped: Vec<_> = fs::read_dir(&backup).unwrap().flatten().collect();
        assert!(stamped.iter().any(|e| e.path().join("full-deleted/local_s1.json").is_file()));
        assert!(stamped.iter().any(|e| e.path().join("three-p-deleted/local_s2.json").is_file()));
    }

    #[test]
    fn archive_state_and_index_sync_both_ways_with_same_last_activity() {
        let temp = tempfile::tempdir().unwrap();
        let t3 = temp.path().join("3p/sessions");
        let tf = temp.path().join("full/sessions");
        let c3 = vec![temp.path().join("3p/claude-code-3p")];
        let cf = vec![temp.path().join("full/claude-code")];
        let backup = temp.path().join("backup");

        seed(&t3, "a3p", "o3p", "a1", 1000.0, r#","isArchived":false"#);
        transcript(&c3[0], "a1", 2);
        seed(&tf, FULL_ACCOUNT, FULL_ORG, "a1", 1000.0, r#","isArchived":true"#);
        let tp_file = t3.join("a3p/o3p/local_a1.json");
        let full_file = tf.join(FULL_ACCOUNT).join(FULL_ORG).join("local_a1.json");
        let t0 = SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_700_000_000);
        let t1 = t0 + std::time::Duration::from_secs(5);
        fs::File::options().write(true).open(&tp_file).unwrap().set_modified(t0).unwrap();
        fs::File::options().write(true).open(&full_file).unwrap().set_modified(t1).unwrap();

        let report = sync_sessions(&t3, &c3, &tf, &cf, &backup).unwrap();
        assert_eq!(report.updated, 1);
        let synced: Value = serde_json::from_slice(&fs::read(&tp_file).unwrap()).unwrap();
        assert_eq!(synced["isArchived"], true);
        let tp_idx: Value = serde_json::from_slice(&fs::read(t3.join("a3p/o3p/archived-sessions.idx")).unwrap()).unwrap();
        let full_idx: Value = serde_json::from_slice(&fs::read(tf.join(FULL_ACCOUNT).join(FULL_ORG).join("archived-sessions.idx")).unwrap()).unwrap();
        assert_eq!(tp_idx["archived"], serde_json::json!(["local_a1"]));
        assert_eq!(full_idx["archived"], serde_json::json!(["local_a1"]));

        // 在 3p 侧取消归档且 mtime 更新（lastActivityAt 仍为 1000），同步回 full 并清理空的 idx
        seed(&t3, "a3p", "o3p", "a1", 1000.0, r#","isArchived":false"#);
        let t2 = t1 + std::time::Duration::from_secs(5);
        fs::File::options().write(true).open(&tp_file).unwrap().set_modified(t2).unwrap();
        let report = sync_sessions(&t3, &c3, &tf, &cf, &backup).unwrap();
        assert_eq!(report.updated, 1);
        let unarchived: Value = serde_json::from_slice(&fs::read(&full_file).unwrap()).unwrap();
        assert_eq!(unarchived["isArchived"], false);
        assert!(!t3.join("a3p/o3p/archived-sessions.idx").exists());
        assert!(!tf.join(FULL_ACCOUNT).join(FULL_ORG).join("archived-sessions.idx").exists());
    }

    #[test]
    fn newest_pair_falls_back_to_deleted_only_three_p_dir() {
        let temp = tempfile::tempdir().unwrap();
        let t3 = temp.path().join("3p/sessions");
        let tf = temp.path().join("full/sessions");
        let c3 = vec![temp.path().join("3p/claude-code-3p")];
        let cf = vec![temp.path().join("full/claude-code")];
        let backup = temp.path().join("backup");

        let three_p_dir = t3.join("a3p").join("o3p");
        fs::create_dir_all(&three_p_dir).unwrap();
        fs::write(three_p_dir.join("deleted_x1"), "2000").unwrap();
        seed(&tf, FULL_ACCOUNT, FULL_ORG, "x1", 1000.0, "");
        seed(&tf, FULL_ACCOUNT, FULL_ORG, "x2", 1000.0, "");
        transcript(&cf[0], "x2", 1);

        let report = sync_sessions(&t3, &c3, &tf, &cf, &backup).unwrap();
        assert_eq!(report.skipped_deleted, 1);
        assert_eq!(report.to_three_p, 1);
        assert!(!tf.join(FULL_ACCOUNT).join(FULL_ORG).join("local_x1.json").exists());
        assert!(three_p_dir.join("local_x2.json").is_file());
    }

    #[test]
    fn empty_three_p_reports_note_instead_of_error() {
        let temp = tempfile::tempdir().unwrap();
        let report = sync_sessions(
            &temp.path().join("nope"),
            &[],
            &temp.path().join("full"),
            &[],
            &temp.path().join("backup"),
        )
        .unwrap();
        assert_eq!(report.note, "3p 模式还没有会话");
    }

    /// 写死的 mock 账号/组织必须与 proxy.mjs 里的字面量保持一致。
    #[test]
    fn full_mode_ids_match_proxy_mock() {
        let proxy = include_str!("../runtime/proxy.mjs");
        assert!(proxy.contains(FULL_ACCOUNT), "proxy.mjs 的 ACCOUNT.id 变了");
        assert!(proxy.contains(FULL_ORG), "proxy.mjs 的 ORG.uuid 变了");
    }
}
