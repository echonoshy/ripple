# 本地 SQLite 迁移

本指南适用于单机 Ripple Server：把高频 SQLite 从 NFS 迁到本机文件系统，同时保持 NAS 上的 workspace、connector credentials、agent artifact 和既有备份目录不变。

## 目录约定

```text
/root/ripple/
  .ripple/                         # 本地实体目录，不能是 NAS 软链接
    ripple.sqlite                   # Ripple 控制面数据库
    audit.jsonl                     # 审计日志
    codex-sqlite/                   # 可选的 Codex app-server SQLite root
      users/<user_id>/sqlite/

/nas/ripple-data/
  sandboxes/                        # workspace、credentials、agent-runs
  sandboxes-cache/                  # 可重建缓存，不备份
  codex-service-home/               # 服务 Codex auth；恢复时重新登录
  codex-multi-auth/                 # 服务认证状态，按密钥策略单独保护
  backups/                          # 本地 SQLite 的逻辑备份目标
```

`/root/ripple/.ripple/` 所在文件系统必须是本地 ext4/xfs 等；先用 `findmnt -T /root/ripple/.ripple` 确认它不是 NFS/SMB。不要将 WAL SQLite 放回网络文件系统。

## 配置

在服务完成首次停机迁移后，启用本地 Codex SQLite root：

```yaml
external_agents:
  codex:
    sqlite_root: "/root/ripple/.ripple/codex-sqlite"
```

`sqlite_root` 只影响 app-server 的 `CODEX_SQLITE_HOME`。它不会改变 `codex_home`、workspace、connector credentials 或 service auth 位置。未配置时保持旧的、由 `codex_home` 推导的路径，便于分阶段迁移。

## 切换步骤

1. 选择维护窗口，先停止入口流量，并让现有 job 完成。不要强制杀掉服务；未完成 job 会进入恢复链路。
2. 停止 `ripple-server`，确认进程不再打开旧数据库。
3. 保留 `/nas/ripple-data/ripple-runtime` 原目录不动。将仓库中的 `.ripple` 软链接改名为带日期的回滚标记，再创建本地 `.ripple` 实体目录。
4. 使用 SQLite `.backup` 从旧控制面库生成本地新库。不要复制在线 WAL 三件套。
5. 将每个用户的旧 Codex `sqlite/` 目录复制到新的 `sqlite_root/users/<user_id>/sqlite/`。不迁移 `codex-home`、`node`、workspace 或 credentials。
6. 对本地控制面库运行 `PRAGMA integrity_check`，比较 schema migration version、sessions、jobs 等关键表计数。
7. 写入 `sqlite_root` 配置并启动服务，检查 `/health`、`/v1/health/ready`、新建 session、一次 chat 与一次 run。
8. 旧 NAS 数据保留为只读回滚副本。新服务一旦接受写入，回滚需要另一次受控迁移，不能直接把路径改回去。

## 备份与恢复

当前生产策略只备份本机运行时到 NAS；NAS 上既有的 workspace、credentials、agent-runs、service Codex auth 和 cache 不做二次备份。

- 控制面数据库：每 15 分钟从本地库用 SQLite `.backup` 创建一致性快照，执行 `integrity_check` 和 `foreign_key_check`，压缩后发布到 NAS。
- 审计日志：与控制面快照同时压缩发布。
- Codex user SQLite：每天对 `state_5.sqlite`、`goals_1.sqlite` 和 `memories_1.sqlite` 创建逻辑快照；`logs_2.sqlite` 是可清理运行日志，不备份。
- 快照目录：`/nas/ripple-data/backups/ripple-local/{control,codex-state}/<UTC 时间戳>/`。每个已完成目录都带有 `SHA256SUMS` 和 `COMPLETE`；未完成的 `.incoming` 目录不能用于恢复。
- 保留期：7 天。脚本只清理自己生成、同时具有合法时间戳和 `COMPLETE` 标记的目录，不使用 `rsync --delete` 覆盖历史快照。

安装定时任务：

```bash
cd /root/ripple
sudo install -m 0644 ops/systemd/ripple-control-plane-backup.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/ripple-control-plane-backup.timer /etc/systemd/system/
sudo install -m 0644 ops/systemd/ripple-codex-state-backup.service /etc/systemd/system/
sudo install -m 0644 ops/systemd/ripple-codex-state-backup.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ripple-control-plane-backup.timer
sudo systemctl enable --now ripple-codex-state-backup.timer
```

恢复前可先在不影响在线服务的前提下验证一个快照：

```bash
cd /root/ripple
scripts/verify-ripple-backup-snapshot.sh \
  /nas/ripple-data/backups/ripple-local/control/<UTC 时间戳>
```

恢复时先停止 `ripple-server`，选定一个包含 `COMPLETE` 的控制面目录，执行 `sha256sum -c SHA256SUMS`，解压 `ripple.sqlite.zst` 到本机 `.ripple/ripple.sqlite`，再运行 `PRAGMA integrity_check` 后启动服务。不要恢复旧的 `-wal` 或 `-shm` 文件。
