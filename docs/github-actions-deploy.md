# GitHub Actions 自动部署到阿里云

推送到 `main` 后，工作流运行测试、类型检查、构建和 smoke 检查，构建 runtime/tools 两个镜像，以提交 SHA 标记，通过 SSH 上传到阿里云服务器。服务器导入镜像、停止 API、备份 SQLite 数据与配置、执行迁移，再启动 API 并等待健康检查。也可以在 Actions → 部署到阿里云 → Run workflow 手动重跑 `main`。

使用镜像文件直传，不需要 ACR、Docker Hub 或 GHCR 账号，服务器更新时也无需访问镜像仓库。镜像包含原生 SQLite 依赖，目标架构必须与服务器一致。上传包含工具镜像，耗时与 GitHub 到服务器的带宽有关。

## 1. 服务器准备（一次）

先按照 [Ubuntu 部署命令](deploy-aliyun.md) 完成初次部署、`.env`、服务器密钥、Nginx 和 HTTPS。默认目录 `/opt/mewCat-service`，默认 Linux x86_64；首次初始化仍按原文档构建。之后自动部署不再拉取源码或现场构建镜像。

SSH 用户必须能执行 Docker、读写部署目录和备份密钥。现有文档使用 root；如果使用专用部署账户，需要预先配置 Docker 权限及目录权限。需要 Bash、tar、gzip、flock 和支持 `docker compose up --wait --wait-timeout` 的 Compose v2 插件。

在服务器检查：

```bash
cd /opt/mewCat-service
docker compose version
uname -m
docker inspect "$(docker compose ps -q api)" --format '{{index .Config.Labels "com.docker.compose.project"}}'
docker inspect "$(docker compose ps -q api)" --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}'
```

记录实际 Compose 项目名和数据库卷名。默认项目名 `mewcat-service` 对应 `mewcat-service_database`。若原部署使用过 `-p` 或 `COMPOSE_PROJECT_NAME`，必须把下面的 `ALIYUN_COMPOSE_PROJECT` 设置为原项目名，否则会创建新的空数据库卷。不要同时运行旧的手动更新流程。

SSH 端口必须允许 GitHub Runner 连接。若防火墙仅放行你的管理 IP，默认托管 Runner 无法连接；可以使用具有固定出口的 Runner 并修改 `runs-on`。数据库和服务仍只通过本机 `127.0.0.1:3000` 提供给 Nginx，不开放公网 3000。

## 2. 配置 SSH 密钥及主机校验

在可信管理机器上生成一对专用、无口令的部署密钥，将公钥追加到服务器对应用户的 `~/.ssh/authorized_keys`，私钥存入下面的 GitHub Secret。它与服务器拉取 GitHub 源码的 Deploy key 用途不同。

```bash
ssh-keygen -t ed25519 -N '' -C 'github-actions-mewcat' -f ./mewcat_actions
```

通过阿里云控制台终端核对服务器主机密钥指纹：

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
```

在可信管理机器获取 known_hosts 行，并核对其指纹与上述输出一致：

```bash
ssh-keyscan -t ed25519 -p 22 你的服务器IP > aliyun_known_hosts
ssh-keygen -lf aliyun_known_hosts
```

`ssh-keyscan` 自身不能验证服务器身份，所以必须核对。将 `aliyun_known_hosts` 文件的完整内容存入 Secret，不是仅存 SHA256 指纹。使用非 22 端口时，两处命令及下方变量都要使用实际端口。

## 3. GitHub 配置

在仓库 Settings → Environments 创建 `production`，可限制部署分支为 `main`。需要完全自动执行时，不设置人工审批。以下 Secrets 可以放在该环境或仓库 Settings → Secrets and variables → Actions 中：

| Secret | 内容 |
| --- | --- |
| `ALIYUN_HOST` | 服务器公网 IPv4 或域名，不带协议和端口 |
| `ALIYUN_USER` | SSH 用户，例如 `root` |
| `ALIYUN_SSH_PRIVATE_KEY` | 上一步生成的完整私钥，包含 BEGIN/END 行 |
| `ALIYUN_SSH_KNOWN_HOSTS` | 经核验的 known_hosts 行 |

可选 Variables：

| Variable | 默认值 | 用途 |
| --- | --- | --- |
| `ALIYUN_SSH_PORT` | `22` | SSH 端口 |
| `ALIYUN_DEPLOY_PATH` | `/opt/mewCat-service` | 已完成初始化的绝对路径，仅支持字母、数字、下划线、连字符及 `/` |
| `ALIYUN_COMPOSE_PROJECT` | `mewcat-service` | 必须与现有部署项目名一致 |
| `ALIYUN_PLATFORM` | `linux/amd64` | `uname -m` 为 `aarch64` 时设置 `linux/arm64` |

供应商 API Key 和服务器身份密钥继续只保存在服务器上，不加入 GitHub Secrets。将本次工作流及脚本提交并推送到 `main` 后，在 Actions 查看运行结果。

## 4. 发布后管理

成功发布指向 `.deploy/current`；每次发布的 Compose 文件和镜像 SHA 保存在 `.deploy/releases/`，备份在 `.deploy/backups/`。不自动删除备份或旧镜像，需根据磁盘容量定期维护。失败上传可能在 `/tmp/mewcat-*` 留下镜像包，排查后可清理对应目录。

后续管理使用成功发布对应的镜像和配置，避免直接使用旧源码的 `docker compose up --build`：

```bash
cd /opt/mewCat-service
set -a
. .deploy/current/image.env
set +a
# 如修改过项目名，这里也使用实际项目名。
dc=(docker compose --project-directory "$PWD" -p mewcat-service \
  -f .deploy/current/compose.yaml -f .deploy/current/compose.images.yaml)
"${dc[@]}" ps
"${dc[@]}" logs --tail=100 api
"${dc[@]}" run --rm --no-deps --pull never migrate node dist/scripts/admin.js clients
```

停止 API 后才复制完整 SQLite 目录，包含可能存在的 WAL 文件。备份也包含 `.env` 和 `secrets`，需限制访问，并定期复制到服务器外的安全存储。每次更新会有短暂停机。

迁移失败或健康检查超时会使 Actions 失败，`.deploy/current` 保留上次成功发布。失败版本的配置路径及备份路径会打印在日志中；可能出现 API 停止或新容器不健康的情况。先检查失败发布的日志和迁移状态；不会自动把旧镜像套在已升级数据库上。需要恢复时，停止 API，使用相匹配的数据库备份、密钥、配置及旧版本镜像恢复，不能只切换镜像，也不要执行 `docker compose down -v`。

并发部署使用 GitHub 队列与服务器文件锁，不会因下一次推送取消正在运行的迁移。GitHub 队列最多保留 100 个等待运行，按进入等待的顺序处理，不保证提交先后顺序；大量连续推送后应核对最后成功部署的 SHA。

参考：[GitHub Actions 工作流与并发队列](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax)、[Docker Compose 健康等待](https://docs.docker.com/reference/cli/docker/compose/up/)。
