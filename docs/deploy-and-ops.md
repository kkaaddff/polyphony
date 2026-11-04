# 自托管指南(部署与运维)

## 拓扑

```text
browser/app --> http(s)://<host>:9091 (或经反代 https://docs.example.com)
                 |
                 |  可选: nginx/caddy TLS 反代(WebSocket 升级头)
                 v
+---------------------------------------------------------+
| Docker: polyphony (all-in-one)                          |
| server/index.js  express + ws + y-websocket CRDT relay  |
| SQLite data/polyphony.db (账号/文档快照/成员/附件登记)     |
| /auth /pair /docs /rooms /uploads   GET /health counts  |
| STATIC_DIR=/app/public 静态托管 + SPA fallback(同源)      |
| port 9091 · vol polyphony-data · vol polyphony-uploads  |
+---------------------------------------------------------+
```

- **单容器即全功能**:同一端口提供 Web 前端 + 协同 WS + 账号/文档 API + 图片上传;`docker compose up -d --build` 一条命令。
- **同源是刻意设计**:Web 端 `location.origin` 兜底天然指向协同服务;也适配随机四级域名反代场景。
- **数据全部落卷**:SQLite 库在 `polyphony-data` 卷(`data/polyphony.db`,WAL 模式),图片在 `polyphony-uploads` 卷;容器重建/升级均不丢。
- **重启不再清空文档**:v4 起服务端持久化文档快照(防抖落盘 + 退出刷盘,SIGTERM 有 15s 优雅窗口),重启后第一个客户端连上即恢复。
- v4 首次启动会把 v3 残留(`accounts.json`、平铺 `uploads/`)改名归档到 `_v3-archive-<时间戳>/` 目录(同卷 rename,不占新空间);确认新版运行正常后可手动删除。

## 快速部署

```bash
git clone https://github.com/kkaaddff/polyphony.git && cd polyphony
docker compose up -d          # 首次会构建镜像(node:22-alpine 双阶段)
curl http://127.0.0.1:9091/health
```

自定义端口:改 `docker-compose.yml` 的 `ports`(如 `"8080:9091"`)。

## HTTPS 反代要点

`/ws` 是长连接 WebSocket,升级头不可少;上传走 5MB 限制,body 大小留余量:

```nginx
location / {
    proxy_pass http://127.0.0.1:9091;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400s;      # 撑住协同长连接
    client_max_body_size 6m;
}
```

## 自动化部署(自建 Gitea CI 参考)

仓库内 [`.gitea/workflows/deploy.yml`](../.gitea/workflows/deploy.yml) 是自托管 Gitea Actions 的完整参考(在生产环境的自建 runner 上运行):

- push `main` → 自动 `docker compose build` + 原地换容器(构建期间旧容器照常服务);
- 纯文档推送不触发(不打扰在线用户);连续推送自动取消旧任务;
- 镜像双标签(`polyphony:<git-sha>` / `:latest`),验证失败自动回滚上一版本;
- 部署后 `GET /health` + 双客户端 CRDT 收敛冒烟(`docker exec` 容器内自环验证)。

手动回滚(任一方式):

```bash
docker tag polyphony:<某历史sha12> polyphony:latest && docker compose up -d --force-recreate
docker tag polyphony:rollback polyphony:latest && docker compose up -d --force-recreate  # 最近一版
```

## 常用运维

```bash
docker compose ps / logs -f           # 状态与日志
docker compose up -d --build          # 手动更新部署
docker compose down                   # 停止(数据卷保留)
docker volume inspect polyphony-data      # SQLite 库实际位置
docker volume inspect polyphony-uploads   # 上传图片实际位置
```

## 备份与恢复(v4)

数据 = 一个 SQLite 库 + 一个图片目录,两者都在具名卷里:

```bash
# 在线备份数据库(无需停服,VACUUM INTO 产出一致性快照):
docker exec polyphony node --disable-warning=ExperimentalWarning -e "
  const {DatabaseSync}=require('node:sqlite');
  new DatabaseSync('/app/server/data/polyphony.db',{readonly:true})
    .exec(\"VACUUM INTO '/app/server/data/backup.db'\");"
docker cp polyphony:/app/server/data/backup.db ./polyphony-$(date +%F).db

# 打包图片卷:
docker run --rm -v polyphony-uploads:/src -v "$PWD":/dst alpine \
  tar czf /dst/uploads-$(date +%F).tgz -C /src .
```

- 恢复:停容器 → 覆盖 `data/polyphony.db` 与 uploads 卷内容 → `up -d`。
- 归档清理:确认 v4 运行正常后删除数据目录下的 `_v3-archive-*/`(v3 账号与图片的历史归档)。

## 历史说明(v3.0 及之前)

v3.0 曾用「PM2 + OpenResty 静态站点 + tar over ssh」链路部署(`deploy/` 目录,已删除,
git 历史可寻)。v3.1 起自托管统一走 Docker all-in-one;该链路的经验(nginx 前缀剥除、
`openresty -t` 校验回滚、em-dash 路径坑)记录于 decisions.md 坑清单。

## 安全边界(如实)

- 账号/文档 API 与 WS 全部强制鉴权(v4 设备凭据);**文档码仍是准入凭据**——知道码的已登录账号即可加入该文档并读附件。
- 图片读取免鉴权(便于编辑器直链显示):路径含 128 位随机熵且文档必须处于 active 状态;介意可在反代层限速 `/uploads/`。
- 明文 http/ws 直连仅适合内网/受信环境;公网使用请套 TLS 反代(WS 凭据走子协议头,不落 URL/访问日志)。
- 上传仅图片类型 + 5MB 上限(客户端先重编码:EXIF/GPS 剥离、长边 ≤2560px);`/health` 只回数量,不含文档码。
