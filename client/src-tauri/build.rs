fn main() {
    // Android 15+ 要求 16KB page size 对齐(实测启动弹「应用兼容性」警告:LOAD 区段未对齐)。
    // 只对 Android 目标注入链接参数,桌面构建不受影响。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("android") {
        println!("cargo:rustc-link-arg=-Wl,-z,max-page-size=16384");
    }
    tauri_build::build()
}
