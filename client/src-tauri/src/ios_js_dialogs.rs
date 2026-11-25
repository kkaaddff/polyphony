//! iOS:WKWebView 的 JS `alert()` / `confirm()` 原生弹窗。
//!
//! wry(0.57)的 WKUIDelegate 只实现了文件选择、摄像头权限与新窗口三项,没有实现
//! `runJavaScript{Alert,Confirm,TextInput}Panel…`。WKWebView 在代理不响应这些可选方法时
//! 不弹任何界面:`confirm` 直接按「取消」回调,`alert` 立即返回。后果是 iOS 上所有依赖
//! `window.confirm` 的危险操作(删文档 / 删便签 / 彻底清除 / 吊销设备 / 注销账号…)静默取消,
//! 所有 `alert(...)` 失败提示都不显示。Android 上 wry 的 WebChromeClient 实现了
//! onJsAlert / onJsConfirm,没有这个问题——iOS 模拟器实测「左滑删便签没反应」才发现。
//!
//! 做法:给 WKWebView 换一个「转发式」UI 代理——自己实现 alert / confirm,其余选择子原样转给
//! wry 原来的代理(`respondsToSelector:` 覆写 + `forwardingTargetForSelector:`),wry 的行为不变。
//! 项目没有使用 `prompt()`,故不实现(仍按取消)。按钮文案跟随系统语言。

use std::cell::Cell;
use std::ptr::NonNull;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;

use block2::RcBlock;
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject, Sel};
use objc2::{
    DefinedClass, MainThreadOnly, define_class, extern_class, extern_methods, msg_send,
    rc::Retained,
};
use objc2_foundation::{NSLocale, NSString};
use objc2_ui_kit::{
    UIAlertAction, UIAlertActionStyle, UIAlertController, UIAlertControllerStyle, UIViewController,
    UIView, UIResponder,
};
use objc2_web_kit::{WKFrameInfo, WKUIDelegate};

/// 在主线程上延迟执行。由 `setup` 注入(本模块不依赖具体的异步运行时)。
pub type Scheduler = Arc<dyn Fn(Duration, Box<dyn FnOnce() + Send>) + Send + Sync>;

/// 回调 completion 时携带的参数:`None` = alert(无参),`Some(v)` = confirm。
type Answer = Option<bool>;

// objc2-web-kit 0.3 的 `WKWebView` 类只在 macOS 上可用;iOS 上 wry 用的是它私有模块里
// 自己声明的一份。这里照同样方式声明一个「只读代理」用的最小子集——Tauri 给出的指针
// 与 wry 指向的是同一个 ObjC 类,声明只影响 Rust 侧的类型。
extern_class!(
    #[unsafe(super(UIView, UIResponder, NSObject))]
    #[thread_kind = MainThreadOnly]
    pub struct WKWebView;
);

unsafe impl NSObjectProtocol for WKWebView {}

impl WKWebView {
    extern_methods! {
        #[unsafe(method(UIDelegate))]
        pub unsafe fn ui_delegate(&self) -> Option<Retained<ProtocolObject<dyn WKUIDelegate>>>;

        #[unsafe(method(setAllowsBackForwardNavigationGestures:))]
        pub unsafe fn set_allows_back_forward_navigation_gestures(&self, allow: bool);

        #[unsafe(method(setUIDelegate:))]
        pub unsafe fn set_ui_delegate(&self, ui_delegate: Option<&ProtocolObject<dyn WKUIDelegate>>);
    }
}

struct Ivars {
    /// wry 原来的 UI 代理:文件选择 / 摄像头权限 / 新窗口等仍由它处理。
    inner: Retained<ProtocolObject<dyn WKUIDelegate>>,
    /// 取不到 webview 所在窗口时用于 present 的兜底(Tauri 承载 webview 的控制器)。
    presenter: Retained<UIViewController>,
    schedule: Scheduler,
}

/// 一次性开关:按钮回调、兜底定时器谁先抢到谁执行,保证 completion 只被调用一次。
#[derive(Clone)]
struct Once(Arc<Mutex<bool>>);

impl Once {
    fn new() -> Self {
        Self(Arc::new(Mutex::new(false)))
    }

    fn claim(&self) -> bool {
        let mut done = self.0.lock().unwrap_or_else(|e| e.into_inner());
        if *done {
            false
        } else {
            *done = true;
            true
        }
    }
}

/// 长期持有的 WebKit completion block(签名由调用处决定:`Fn()` 或 `Fn(Bool)`)。
struct Completion(Retained<AnyObject>);

impl Completion {
    /// 以 copy 语义持有:栈 block 会被拷到堆,堆 block 等价于 retain。
    ///
    /// # Safety
    /// `block` 必须是 WKUIDelegate 回调里传来的 completion handler。
    unsafe fn retain<T: ?Sized>(block: &block2::DynBlock<T>) -> Self {
        // SAFETY:block 本身就是 ObjC 对象
        let obj: &AnyObject =
            unsafe { &*(block as *const block2::DynBlock<T> as *const AnyObject) };
        // SAFETY:任何对象都响应 copy(返回 +1);block 的 copy 不会返回 nil
        let copied: Option<Retained<AnyObject>> = unsafe { msg_send![obj, copy] };
        // SAFETY:copy 不返回 nil
        Self(unsafe { copied.unwrap_unchecked() })
    }

    /// 包成可跨线程移动的一次性回调。`Retained` 不是 `Send`,所以闭包里只带地址,
    /// 回到主线程后再还原成 `Retained` 并调用。
    ///
    /// 注意:闭包若未执行就被丢弃(兜底未触发 / 另一个按钮被点),这里**故意不释放**该 block。
    /// WebKit 用 `CompletionHandlerCallChecker` 包裹 completion handler,block 析构时若发现
    /// 从未被调用会 raise NSException → abort(真机/模拟器实测崩溃)。因此未被选中的那份拷贝
    /// 只能保留(每次弹窗至多泄漏几个 block,量级可忽略),绝不能 release 一个未调用的 handler。
    fn into_send(self, answer: Answer) -> Box<dyn FnOnce() + Send> {
        let addr = Retained::into_raw(self.0) as usize;
        Box::new(move || {
            // SAFETY:地址由 Retained::into_raw 产生,回主线程后还原;类型由调用处保证
            let obj: Option<Retained<AnyObject>> =
                unsafe { Retained::from_raw(addr as *mut AnyObject) };
            // SAFETY:地址来自 Retained::into_raw,非空
            let completion = Completion(unsafe { obj.unwrap_unchecked() });
            // SAFETY:retain 的调用处保证签名与 answer 一致
            unsafe {
                let ptr = Retained::as_ptr(&completion.0);
                match answer {
                    None => (*(ptr as *const block2::DynBlock<dyn Fn()>)).call(()),
                    Some(v) => {
                        (*(ptr as *const block2::DynBlock<dyn Fn(Bool)>)).call((Bool::new(v),))
                    }
                }
            }
        })
    }
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = Ivars]
    struct JsDialogDelegate;

    unsafe impl NSObjectProtocol for JsDialogDelegate {
        // WebKit 调可选协议方法前先问 respondsToSelector:把 wry 代理响应的也算上,才会走到转发
        #[unsafe(method(respondsToSelector:))]
        fn responds_to_selector(&self, a_selector: Sel) -> bool {
            let own: bool = unsafe { msg_send![super(self), respondsToSelector: a_selector] };
            own || self.ivars().inner.respondsToSelector(a_selector)
        }
    }

    impl JsDialogDelegate {
        // 本类没有实现的选择子 → 原样转给 wry 的代理
        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target_for_selector(&self, _a_selector: Sel) -> Option<&AnyObject> {
            // SAFETY:`ProtocolObject` 内部就是对象指针;代理由本对象持有,调用期间有效
            Some(unsafe { &*Retained::as_ptr(&self.ivars().inner).cast::<AnyObject>() })
        }
    }

    unsafe impl WKUIDelegate for JsDialogDelegate {
        #[unsafe(method(webView:runJavaScriptAlertPanelWithMessage:initiatedByFrame:completionHandler:))]
        unsafe fn alert_panel(
            &self,
            web_view: &WKWebView,
            message: &NSString,
            _frame: &WKFrameInfo,
            completion_handler: &block2::DynBlock<dyn Fn()>,
        ) {
            // SAFETY:WebKit 传入的 alert completion,签名 `Fn()`
            let ok = unsafe { Completion::retain(completion_handler) };
            // SAFETY:同上
            let fallback = unsafe { Completion::retain(completion_handler) };
            present(
                web_view,
                message,
                ok.into_send(None),
                None,
                fallback.into_send(None),
                self.ivars().presenter.clone(),
                self.ivars().schedule.clone(),
            );
        }

        #[unsafe(method(webView:runJavaScriptConfirmPanelWithMessage:initiatedByFrame:completionHandler:))]
        unsafe fn confirm_panel(
            &self,
            web_view: &WKWebView,
            message: &NSString,
            _frame: &WKFrameInfo,
            completion_handler: &block2::DynBlock<dyn Fn(Bool)>,
        ) {
            // SAFETY:WebKit 传入的 confirm completion,签名 `Fn(Bool)`
            let ok = unsafe { Completion::retain(completion_handler) };
            // SAFETY:同上
            let cancel = unsafe { Completion::retain(completion_handler) };
            // SAFETY:同上
            let fallback = unsafe { Completion::retain(completion_handler) };
            present(
                web_view,
                message,
                ok.into_send(Some(true)),
                Some(cancel.into_send(Some(false))),
                fallback.into_send(Some(false)),
                self.ivars().presenter.clone(),
                self.ivars().schedule.clone(),
            );
        }
    }
);

/// (确定, 取消):跟随系统语言,中文用「确定 / 取消」,其余用英文。
fn button_labels() -> (Retained<NSString>, Retained<NSString>) {
    let zh = NSLocale::preferredLanguages()
        .firstObject()
        .is_some_and(|lang| lang.hasPrefix(&NSString::from_str("zh")));
    let (ok, cancel) = if zh { ("确定", "取消") } else { ("OK", "Cancel") };
    (NSString::from_str(ok), NSString::from_str(cancel))
}

/// webview 所在窗口最上层的视图控制器(已有 present 时要从最上层 present,否则会被 UIKit 拒绝)。
fn top_view_controller(web_view: &WKWebView) -> Option<Retained<UIViewController>> {
    let mut vc = web_view.window()?.rootViewController()?;
    while let Some(presented) = vc.presentedViewController() {
        vc = presented;
    }
    Some(vc)
}

/// 弹原生提示框。`cancel` 为 `Some` 即确认框(两个按钮);`fallback` 在弹窗没能展示时兜底。
/// 只能在主线程调用(由 WKUIDelegate 回调进入)。
#[allow(clippy::too_many_arguments)]
fn present(
    web_view: &WKWebView,
    message: &NSString,
    ok: Box<dyn FnOnce() + Send>,
    cancel: Option<Box<dyn FnOnce() + Send>>,
    fallback: Box<dyn FnOnce() + Send>,
    fallback_presenter: Retained<UIViewController>,
    schedule: Scheduler,
) {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        // 不在主线程:不该发生;直接按默认结果回调,不让 JS 线程干等
        fallback();
        return;
    };
    let alert = UIAlertController::alertControllerWithTitle_message_preferredStyle(
        None,
        Some(message),
        UIAlertControllerStyle::Alert,
        mtm,
    );
    let once = Once::new();
    let (ok_label, cancel_label) = button_labels();

    if let Some(on_cancel) = cancel {
        let once = once.clone();
        let on_cancel = Cell::new(Some(on_cancel));
        let action = UIAlertAction::actionWithTitle_style_handler(
            Some(&cancel_label),
            UIAlertActionStyle::Cancel,
            Some(&RcBlock::new(move |_action: NonNull<UIAlertAction>| {
                if once.claim() {
                    if let Some(f) = on_cancel.take() {
                        f();
                    }
                }
            })),
            mtm,
        );
        alert.addAction(&action);
    }
    let once_ok = once.clone();
    let on_ok = Cell::new(Some(ok));
    let action = UIAlertAction::actionWithTitle_style_handler(
        Some(&ok_label),
        UIAlertActionStyle::Default,
        Some(&RcBlock::new(move |_action: NonNull<UIAlertAction>| {
            if once_ok.claim() {
                if let Some(f) = on_ok.take() {
                    f();
                }
            }
        })),
        mtm,
    );
    alert.addAction(&action);

    let presenter = top_view_controller(web_view).unwrap_or(fallback_presenter);
    let presented = Arc::new(AtomicBool::new(false));
    let presented_on_done = presented.clone();
    let on_presented = RcBlock::new(move || presented_on_done.store(true, Ordering::SeqCst));
    presenter.presentViewController_animated_completion(&alert, true, Some(&on_presented));

    // 兜底:UIKit 拒绝 present 时不会有任何回调,而 JS 线程在等 completion → App 假死。
    // 2.5s 后仍未 present 成功,就按默认结果回调(提示框=确定,确认框=取消)。
    schedule(
        Duration::from_millis(2500),
        Box::new(move || {
            if !presented.load(Ordering::SeqCst) && once.claim() {
                fallback();
            }
        }),
    );
}

/// 给 webview 换上转发式 UI 代理。WKWebView 只弱引用代理,所以代理对象随进程存活。
///
/// # Safety
/// 必须在主线程调用;`web_view` 必须指向有效的 WKWebView,`presenter` 指向有效的 UIViewController。
pub unsafe fn install(
    web_view: *mut WKWebView,
    presenter: *mut UIViewController,
    schedule: Scheduler,
) -> Result<(), String> {
    let Some(mtm) = objc2::MainThreadMarker::new() else {
        return Err("ios_js_dialogs: 必须在主线程安装".into());
    };
    // SAFETY:调用方保证指针有效(或为空,这里判空)
    let web_view_ref = unsafe { web_view.as_ref() };
    // SAFETY:同上
    let presenter = unsafe { Retained::retain(presenter) };
    let (Some(web_view), Some(presenter)) = (web_view_ref, presenter) else {
        return Err("ios_js_dialogs: webview / 视图控制器指针为空".into());
    };
    // 屏幕左缘右滑返回:WKWebView 默认关闭,打开后走 SPA 的历史栈(真机实测可用;
    // 模拟器里 XCUITest 合成的拖拽触发不了这个手势,别拿它判断)。
    // SAFETY:web_view 有效
    unsafe { web_view.set_allows_back_forward_navigation_gestures(true) };
    // SAFETY:web_view 有效
    let inner = unsafe { web_view.ui_delegate() }
        .ok_or("ios_js_dialogs: WKWebView 没有 UI 代理(预期由 wry 设置)")?;
    let delegate = mtm
        .alloc::<JsDialogDelegate>()
        .set_ivars(Ivars { inner, presenter, schedule });
    // SAFETY:init 是 NSObject 的指定构造器
    let delegate: Retained<JsDialogDelegate> = unsafe { msg_send![super(delegate), init] };
    // SAFETY:delegate 有效且位于主线程
    unsafe { web_view.set_ui_delegate(Some(ProtocolObject::from_ref(&*delegate))) };
    std::mem::forget(delegate);
    Ok(())
}
