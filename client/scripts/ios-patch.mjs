// `tauri ios init` 之后打补丁（幂等，可重复运行）：
//   1. NSCameraUsageDescription —— 扫码插件要用相机，缺这条 iOS 直接拒绝授权（崩溃/无画面）。
//   2. NSAppTransportSecurity / NSAllowsArbitraryLoads —— iOS 默认 ATS 只放行 https，
//      自建服务器多是 http://<局域网IP>:PORT 无证书（同 Android 的 usesCleartextTraffic）。
//      不开这条，WebView 里所有 http 直连请求都被系统拦掉。不上架 App Store，故全量放行。
//   3. NSLocalNetworkUsageDescription —— iOS 14+ 访问局域网 IP 触发「本地网络」隐私弹窗，
//      缺用途说明会被系统直接拒绝（同 Android 17 的 ACCESS_LOCAL_NETWORK）。
//   4. AppIcon 覆盖 —— gen/ 不入库，`tauri ios init` 生成的图标若回落默认，则用 icons/icon.png
//      （三声部辫）重生成 AppIcon.appiconset 覆盖，保证真机/模拟器图标一致。
// 用法：在 client/ 下 `node scripts/ios-patch.mjs`（npm run ios:init 会自动带）。
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";

const GEN_APPLE = new URL("../src-tauri/gen/apple/", import.meta.url);

if (!existsSync(GEN_APPLE)) {
  console.error("ios-patch: gen/apple 不存在 —— 先跑 `npx tauri ios init` 再执行本脚本");
  process.exit(1);
}

// 动态定位 App 的 Info.plist（gen/apple/<name>_iOS/Info.plist，名字随 productName 变化）。
// 只扫源工程目录，跳过 build/（xcarchive 里的产物 plist、storyboardc 编译出的二进制 plist
// 既不是源也不该改）与 Pods 等依赖目录。
const SKIP_DIRS = new Set(["build", "Pods", "node_modules", ".tauri"]);
function findInfoPlists(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      out.push(...findInfoPlists(join(dir, e.name)));
    } else if (e.name === "Info.plist") out.push(join(dir, e.name));
  }
  return out;
}
const plists = findInfoPlists(GEN_APPLE.pathname).filter((p) => /_iOS|_ios/.test(p));
if (plists.length === 0) {
  console.error("ios-patch: 未在 gen/apple 找到 *_iOS/Info.plist —— 确认已跑 tauri ios init");
  process.exit(1);
}

// 在根 <dict> 闭合前插入键值（根 dict 的 </dict> 紧邻 </plist>）
function insertAtRoot(xml, snippet) {
  if (xml.startsWith("bplist")) throw new Error("ios-patch: Info.plist 是二进制格式，预期 XML");
  const m = xml.match(/<\/dict>\s*<\/plist>/);
  if (!m) throw new Error("ios-patch: Info.plist 结构意外（找不到根 dict 闭合）");
  const idx = xml.indexOf(m[0]);
  return xml.slice(0, idx) + snippet + xml.slice(idx);
}

const patches = [];
for (const plist of plists) {
  let xml = readFileSync(plist, "utf8");
  const before = xml;

  if (!xml.includes("<key>NSCameraUsageDescription</key>")) {
    xml = insertAtRoot(
      xml,
      "\t<key>NSCameraUsageDescription</key>\n\t<string>用于扫描文档与设备配对二维码</string>\n"
    );
    patches.push("NSCameraUsageDescription");
  }

  if (!xml.includes("<key>NSAppTransportSecurity</key>")) {
    xml = insertAtRoot(
      xml,
      "\t<key>NSAppTransportSecurity</key>\n\t<dict>\n\t\t<key>NSAllowsArbitraryLoads</key>\n\t\t<true/>\n\t</dict>\n"
    );
    patches.push("ATS(NSAllowsArbitraryLoads)");
  }

  if (!xml.includes("<key>NSLocalNetworkUsageDescription</key>")) {
    xml = insertAtRoot(
      xml,
      "\t<key>NSLocalNetworkUsageDescription</key>\n\t<string>用于连接你自建的局域网协同服务器</string>\n"
    );
    patches.push("NSLocalNetworkUsageDescription");
  }

  if (xml !== before) writeFileSync(plist, xml);
}

// 4. AppIcon 覆盖：`tauri ios init` 会回落 Tauri 默认图标（同 Android 的坑）。
//    用入库的三声部辫 icons/icon.png(512)，按生成的 Contents.json 逐尺寸 sips 重生成覆盖。
//    解析 Contents.json 而非硬编码尺寸表——Tauri 改尺寸清单时本脚本自适应。
//    1024 营销槽由 512 放大（仅 App Store 列表用，本项目不上架）；主屏 ≤180px 均由 512 缩小，清晰。
const SRC_ICON = new URL("../src-tauri/icons/icon.png", import.meta.url);
const APPICONSET = new URL("Assets.xcassets/AppIcon.appiconset/", GEN_APPLE);
const CONTENTS = new URL("Contents.json", APPICONSET);
if (existsSync(SRC_ICON) && existsSync(CONTENTS)) {
  const { images } = JSON.parse(readFileSync(CONTENTS, "utf8"));
  let n = 0;
  for (const img of images) {
    if (!img.filename) continue;
    const w = parseFloat(img.size.split("x")[0]);
    const scale = parseInt(img.scale, 10) || 1;
    const px = Math.round(w * scale);
    const out = join(APPICONSET.pathname, img.filename);
    execSync(`sips -z ${px} ${px} "${SRC_ICON.pathname}" --out "${out}"`, { stdio: "ignore" });
    n++;
  }
  patches.push(`AppIcon(三声部辫 ${n} 尺寸)`);
} else {
  console.warn("ios-patch: 缺 app-icon.png 或 AppIcon.appiconset，跳过图标覆盖");
}

if (patches.length === 0) {
  console.log("ios-patch: 已是目标状态，无需修改");
} else {
  console.log(`ios-patch: 已写入 ${patches.join(" / ")}`);
}
