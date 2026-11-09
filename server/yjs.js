// 全服务端唯一的 Yjs 实例。
// y-websocket/bin/utils 是 CJS,内部 require('yjs') 拿到 dist/yjs.cjs;而 ESM 的
// `import * as Y from 'yjs'` 拿到 dist/yjs.mjs —— 同进程两份 Yjs(启动日志「Yjs was
// already imported」)。docStore 用 mjs 的 applyUpdate 把快照灌进 y-websocket(cjs)
// 创建的文档,生成的结构体过不了 cjs 侧的 instanceof:从快照重新加载的文档之后
// 收到的客户端更新全部积压成 pending,既不落库也不广播(v4.1 真机联调实测:
// 文档卸载/服务重启后再编辑,内容只留在客户端)。凡服务端用 Yjs 一律从这里取。
import { createRequire } from 'module';

const Y = createRequire(import.meta.url)('yjs');

export default Y;
