# 端到端测试用的最小 GTK4 应用:一个窗口 + 一个 TextView(GTK4 输入法模块的对照样本)。
import gi

gi.require_version("Gtk", "4.0")
from gi.repository import Gtk


def on_activate(app):
    win = Gtk.ApplicationWindow(application=app, title="e2e-gtk4-textview")
    win.set_default_size(900, 600)
    view = Gtk.TextView()
    view.set_wrap_mode(Gtk.WrapMode.CHAR)
    # 文本一变就落盘:没有剪贴板工具的会话(GNOME 无头)靠这个文件读回
    buf = view.get_buffer()

    def dump(_buf):
        with open("/tmp/out-gtk4.txt", "w", encoding="utf-8") as f:
            f.write(buf.get_text(buf.get_start_iter(), buf.get_end_iter(), False))

    buf.connect("changed", dump)
    win.set_child(view)
    win.present()


app = Gtk.Application(application_id="online.hengheng.polyphony.e2e.gtk4")
app.connect("activate", on_activate)
app.run(None)
