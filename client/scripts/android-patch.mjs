// `tauri android init` 之后打补丁（幂等，可重复运行）：
//   1. usesCleartextTraffic="true" —— Android WebView 默认禁明文，v1 直连都是 ws://IP:PORT 无证书
//   2. CAMERA 权限 —— jsQR + getUserMedia 扫码兜底（插件扫码自带运行时申请，但清单权限必须有）
//   3. INTERNET 权限 —— 模板一般已带，缺则补
//   4. activity windowSoftInputMode="adjustResize" —— 软键盘弹出时压缩布局而非整页上推
//      （配合 index.html 的 interactive-widget=resizes-content；该属性只对 <activity> 生效，
//        写到 <application> 上会被静默忽略 —— 必须打在 .MainActivity 那个 activity 上）
// 用法：在 client/ 下 `node scripts/android-patch.mjs`（npm run android:init 会自动带）
import { readFileSync, writeFileSync } from "node:fs";

const MANIFEST = new URL(
  "../src-tauri/gen/android/app/src/main/AndroidManifest.xml",
  import.meta.url
);

let xml = readFileSync(MANIFEST, "utf8");
const patches = [];

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
