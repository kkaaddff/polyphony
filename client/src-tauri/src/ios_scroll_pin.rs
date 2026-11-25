//! iOS:键盘弹起时钉住 WKWebView 的滚动视图,页头不再跟着跳。
//!
//! 键盘弹出时 WebKit 会滚动 webview 自带的 UIScrollView 把聚焦的输入框露出来(原生层的滚动,
//! CSS 的 overflow / position:fixed 管不到)。移动全屏页(便签 / 首页 / 文档页)本身已按可视区
//! 定高、输入框贴在键盘上方,这次滚动只会把整页先推走、前端再晚一帧补回来——真机录屏里
//! 页头连跳两次。做法同 Capacitor Keyboard 插件的 disableScroll:挂一个滚动代理,滚动发生的
//! 同一次调用里把偏移复位,画面上不出现被推走的那一帧。
//!
//! 只在前端声明「当前是全屏钉住页」时生效(`ios_set_scroll_pinned`,由 lib/viewport.ts 按
//! `[data-vv-pinned]` 是否存在来同步);其它靠文档自身滚动的页面不受影响。

use std::sync::atomic::{AtomicBool, Ordering};

use objc2::runtime::{AnyObject, NSObject};
use objc2::{MainThreadOnly, define_class, msg_send, rc::Retained};
use objc2_core_foundation::CGPoint;

static PINNED: AtomicBool = AtomicBool::new(false);

/// 前端同步「是否钉住」。
pub fn set_pinned(pinned: bool) {
    PINNED.store(pinned, Ordering::SeqCst);
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    struct ScrollPinDelegate;

    impl ScrollPinDelegate {
        #[unsafe(method(scrollViewDidScroll:))]
        fn scroll_view_did_scroll(&self, scroll_view: &AnyObject) {
            if !PINNED.load(Ordering::SeqCst) {
                return;
            }
            // SAFETY:scroll_view 是 UIScrollView
            let offset: CGPoint = unsafe { msg_send![scroll_view, contentOffset] };
            if offset.y != 0.0 {
                // SAFETY:同上;复位会再次触发本回调,届时 y == 0 直接返回
                let _: () = unsafe {
                    msg_send![scroll_view, setContentOffset: CGPoint { x: offset.x, y: 0.0 }]
                };
            }
        }
    }
);

/// 给 webview 的滚动视图挂上钉住代理。UIScrollView 只弱引用代理,所以代理对象随进程存活。
///
/// # Safety
/// 必须在主线程调用;`web_view` 必须指向有效的 WKWebView(或为空)。
pub unsafe fn install(web_view: *mut AnyObject) -> Result<(), String> {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return Err("ios_scroll_pin: 必须在主线程安装".into());
    };
    // SAFETY:调用方保证指针有效(或为空,这里判空)
    let Some(web_view) = (unsafe { web_view.as_ref() }) else {
        return Err("ios_scroll_pin: webview 指针为空".into());
    };
    // SAFETY:WKWebView 响应 scrollView
    let scroll_view: Option<Retained<AnyObject>> = unsafe { msg_send![web_view, scrollView] };
    let scroll_view = scroll_view.ok_or("ios_scroll_pin: 取不到 scrollView")?;
    let delegate = mtm.alloc::<ScrollPinDelegate>().set_ivars(());
    // SAFETY:init 是 NSObject 的指定构造器
    let delegate: Retained<ScrollPinDelegate> = unsafe { msg_send![super(delegate), init] };
    // SAFETY:scroll_view / delegate 有效且位于主线程
    let _: () = unsafe { msg_send![&*scroll_view, setDelegate: &*delegate] };
    std::mem::forget(delegate);
    Ok(())
}
