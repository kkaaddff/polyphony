// `tauri android init` 之后打补丁（幂等，可重复运行）：
//   1. usesCleartextTraffic="true" —— Android WebView 默认禁明文，v1 直连都是 ws://IP:PORT 无证书
//   2. CAMERA 权限 —— jsQR + getUserMedia 扫码兜底（插件扫码自带运行时申请，但清单权限必须有）
//   3. INTERNET 权限 —— 模板一般已带，缺则补
//   4. activity windowSoftInputMode="adjustResize" —— 软键盘弹出时压缩布局而非整页上推
//      （配合 index.html 的 interactive-widget=resizes-content；该属性只对 <activity> 生效，
//        写到 <application> 上会被静默忽略 —— 必须打在 .MainActivity 那个 activity 上）
//   5. 启动图标整体覆盖 —— gen/ 不入库，`tauri android init` 每次重新生成的是 Tauri 默认
//      图标（drawable-v24 vector 前景 + 默认背景）；「三声部辫」自定义自适应层
//      （icons/android/ 下 mipmap-* + anydpi-v26 的 fg/bg/mono，ADR #32）必须在这里
//      拷进 gen 工程的 res/，否则 CI 出的 apk 永远是默认图标（v4.0.0 实踩）。
// 用法：在 client/ 下 `node scripts/android-patch.mjs`（npm run android:init 会自动带）
import { cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const GEN_ANDROID = new URL("../src-tauri/gen/android/", import.meta.url);
const MANIFEST = new URL("app/src/main/AndroidManifest.xml", GEN_ANDROID);
const ICON_RES = new URL("../src-tauri/icons/android/", import.meta.url);

if (!existsSync(MANIFEST)) {
  console.error(
    "android-patch: gen/android 不存在 —— 先跑 `npx tauri android init` 再执行本脚本"
  );
  process.exit(1);
}

let xml = readFileSync(MANIFEST, "utf8");
const patches = [];

// 5. 图标覆盖（cpSync 同名覆盖，天然幂等；values/ 里的颜色同名照盖）
const iconTarget = new URL("app/src/main/res/", GEN_ANDROID);
if (existsSync(iconTarget)) {
  cpSync(ICON_RES, iconTarget, { recursive: true, force: true });
  patches.push("launcher-icon(三声部辫)");
} else {
  console.warn("android-patch: gen res/ 不存在，跳过图标覆盖（先跑 tauri android init）");
}

if (!xml.includes("android.permission.INTERNET")) {
  xml = xml.replace(
    /<application/,
    '  <uses-permission android:name="android.permission.INTERNET" />\n  <application'
  );
  patches.push("INTERNET");
}

if (!xml.includes("android.permission.CAMERA")) {
  xml = xml.replace(
    /<application/,
    '  <uses-permission android:name="android.permission.CAMERA" />\n  <application'
  );
  patches.push("CAMERA");
}

if (!xml.includes("android:usesCleartextTraffic")) {
  xml = xml.replace(
    /<application([^>]*)>/,
    '<application$1 android:usesCleartextTraffic="true">'
  );
  patches.push("usesCleartextTraffic");
}

// windowSoftInputMode 是 activity 级属性：定位含 .MainActivity 的 <activity> 开标签
if (!xml.includes('android:windowSoftInputMode="adjustResize"')) {
  const activityTag = xml.match(/<activity[^>]*\.MainActivity[^>]*>/);
  if (activityTag) {
    xml = xml.replace(
      activityTag[0],
      activityTag[0].replace(/android:windowSoftInputMode="[^"]*"/, "").replace(
        />$/,
        ' android:windowSoftInputMode="adjustResize">'
      )
    );
    patches.push("windowSoftInputMode=adjustResize");
  } else {
    console.warn("android-patch: 未找到 .MainActivity <activity>,跳过 windowSoftInputMode");
  }
}

if (patches.length === 0) {
  console.log("android-patch: 清单已是目标状态，无需修改");
} else {
  writeFileSync(MANIFEST, xml);
  console.log(`android-patch: 已写入 ${patches.join(" / ")}`);
}
