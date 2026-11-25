# 自托管指南(部署与运维)

## 概览

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

## 安全边界(如实)

- 账号/文档 API 与 WS 全部强制鉴权(v4 设备凭据);**文档码仍是准入凭据**——知道码的已登录账号即可加入该文档并读附件。
- 图片读取免鉴权(便于编辑器直链显示):路径含 128 位随机熵且文档必须处于 active 状态;介意可在反代层限速 `/uploads/`。
- 明文 http/ws 直连仅适合内网/受信环境;公网使用请套 TLS 反代(WS 凭据走子协议头,不落 URL/访问日志)。
- 上传仅图片类型 + 5MB 上限(客户端先重编码:EXIF/GPS 剥离、长边 ≤2560px);`/health` 只回数量,不含文档码。
