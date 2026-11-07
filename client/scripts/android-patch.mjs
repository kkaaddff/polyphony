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
//   6. ACCESS_LOCAL_NETWORK —— Android 17(API 37)起 WebView 访问局域网 IP 必须持有该
//      运行时权限；缺失时 WebView 内所有 http://<局域网IP> 请求直接失败
//      （net::ERR_LOCAL_NETWORK_PERMISSION_MISSING，v4 真机联调实踩）。
//      清单声明在下面补；运行时申请要写进 MainActivity（同样是生成文件，用本脚本打补丁）。
// 用法：在 client/ 下 `node scripts/android-patch.mjs`（npm run android:init 会自动带）
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

// Android 17+ 访问局域网(自部署服务器 IP)所需；低版本系统忽略未知权限声明
if (!xml.includes("android.permission.ACCESS_LOCAL_NETWORK")) {
  xml = xml.replace(
    /<application/,
    '  <uses-permission android:name="android.permission.ACCESS_LOCAL_NETWORK" />\n  <application'
  );
  patches.push("ACCESS_LOCAL_NETWORK");
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

// MainActivity 运行时申请 ACCESS_LOCAL_NETWORK(Android 17+)。文件在 gen 里，同样打补丁而非手改。
{
  const javaRoot = new URL("app/src/main/java/", GEN_ANDROID);
  let activityPath = null;
  if (existsSync(javaRoot)) {
    const walk = (dir) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name === "MainActivity.kt") activityPath = p;
      }
    };
    walk(javaRoot.pathname);
  }
  if (!activityPath) {
    console.warn("android-patch: 未找到 MainActivity.kt，跳过本地网络权限申请");
  } else {
    const original = readFileSync(activityPath, "utf8");
    let kt = original;
    const added = [];
    // 分段幂等：每段独立检测，重复运行不会叠加
    const addImports = (names) => {
      const missing = names
        .filter((i) => !kt.includes(`import ${i}\n`))
        .map((i) => `import ${i}\n`)
        .join("");
      if (!missing) return;
      const lastImport = kt.lastIndexOf("\nimport ");
      const importEnd = kt.indexOf("\n", lastImport + 1);
      kt = kt.slice(0, importEnd + 1) + missing + kt.slice(importEnd + 1);
    };
    const insertAtClassEnd = (snippet) => {
      const lastBrace = kt.lastIndexOf("}");
      kt = kt.slice(0, lastBrace) + snippet + kt.slice(lastBrace);
    };

    if (!kt.includes("super.onCreate(savedInstanceState)")) {
      console.warn("android-patch: MainActivity 结构意外，跳过本地网络权限申请");
    } else {
      addImports([
        "android.Manifest",
        "android.content.pm.PackageManager",
        "android.os.Build",
        "android.widget.Toast",
      ]);
      if (!kt.includes("requestLocalNetworkPermission()")) {
        kt = kt.replace(
          "    super.onCreate(savedInstanceState)\n",
          "    super.onCreate(savedInstanceState)\n    requestLocalNetworkPermission()\n"
        );
        added.push("调用");
      }
      if (!kt.includes("fun requestLocalNetworkPermission")) {
        insertAtClassEnd(
          [
            "",
            "  // Android 17(API 37)+：WebView 访问局域网服务器所需运行时权限，缺失会导致所有请求失败",
            "  private fun requestLocalNetworkPermission() {",
            "    if (Build.VERSION.SDK_INT < 37) return",
            "    if (checkSelfPermission(Manifest.permission.ACCESS_LOCAL_NETWORK) ==",
            "      PackageManager.PERMISSION_GRANTED",
            "    ) return",
            "    requestPermissions(arrayOf(Manifest.permission.ACCESS_LOCAL_NETWORK), 0x4c4e)",
            "  }",
            "",
          ].join("\n")
        );
        added.push("申请方法");
      }
      if (!kt.includes("onRequestPermissionsResult")) {
        insertAtClassEnd(
          [
            "",
            "  // 拒绝时明确告知：否则页面只会表现为「网络失败」，用户无从下手",
            "  override fun onRequestPermissionsResult(",
            "    requestCode: Int,",
            "    permissions: Array<String>,",
            "    grantResults: IntArray",
            "  ) {",
            "    super.onRequestPermissionsResult(requestCode, permissions, grantResults)",
            "    if (requestCode == 0x4c4e && grantResults.isNotEmpty() &&",
            "      grantResults[0] != PackageManager.PERMISSION_GRANTED",
            "    ) {",
            '      Toast.makeText(this, "未获得本地网络权限，将无法连接自建服务器；可在系统设置中开启", Toast.LENGTH_LONG).show()',
            "    }",
            "  }",
            "",
          ].join("\n")
        );
        added.push("拒绝提示");
      }
      // 冷启动「首次点输入框不弹键盘」(v4 实踩):启动时系统权限弹窗抢走窗口焦点,
      // 回到 Activity 后 WebView 没重新拿 View 焦点,IME 无服务对象(mServedView=null)。
      // 窗口焦点回来时把焦点还给 WebView。
      if (!kt.includes("onWindowFocusChanged")) {
        insertAtClassEnd(
          [
            "",
            "  override fun onWindowFocusChanged(hasFocus: Boolean) {",
            "    super.onWindowFocusChanged(hasFocus)",
            "    if (hasFocus) {",
            "      val content = findViewById<android.view.ViewGroup>(android.R.id.content)",
            "      findWebView(content)?.let { if (!it.hasFocus()) it.requestFocus() }",
            "    }",
            "  }",
            "",
            "  private fun findWebView(v: android.view.View?): android.webkit.WebView? {",
            "    if (v is android.webkit.WebView) return v",
            "    if (v is android.view.ViewGroup) {",
            "      for (i in 0 until v.childCount) findWebView(v.getChildAt(i))?.let { return it }",
            "    }",
            "    return null",
            "  }",
            "",
          ].join("\n")
        );
        added.push("焦点归还");
      }
      if (kt !== original) {
        writeFileSync(activityPath, kt);
        patches.push(`MainActivity(${added.join("+") || "imports"})`);
      }
    }
  }
}

if (patches.length === 0) {
  console.log("android-patch: 清单已是目标状态，无需修改");
} else {
  writeFileSync(MANIFEST, xml);
  console.log(`android-patch: 已写入 ${patches.join(" / ")}`);
}
