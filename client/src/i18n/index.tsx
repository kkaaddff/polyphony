// 轻量 i18n:zh/en 两字典,默认跟随系统语言,localStorage(polyphony.locale)覆盖。
// 复用 storage.ts 的 useLocalStorageState —— 语言切换在同标签页即时生效、
// 跨标签页经 storage 事件同步,零额外依赖。
import { useCallback, useEffect } from "react";
import { zh } from "./zh";
import { en } from "./en";
import { useLocalStorageState } from "@/lib/storage";

export type Locale = "zh" | "en";
export type LocalePref = "auto" | Locale;

export const LOCALE_KEY = "polyphony.locale";

const dicts = { zh, en } as const;

// ---------- 类型:扁平点号键(home.title 等),zh 为完本 ----------

type Dict = typeof zh;
type Sections = keyof Dict & string;
type KeyOf<S extends Sections> = `${S}.${keyof Dict[S] & string}`;
export type TKey = { [S in Sections]: KeyOf<S> }[Sections];

/** en 与 zh 同构的形状校验(satisfies 在 en.ts 内;此处再兜一层编译期断言)。 */
type SameShape = { [S in Sections]: Record<keyof Dict[S], string> };

// ---------- 解析 ----------

/** 系统语言 → Locale(zh* 开头取 zh,其余 en)。 */
export function systemLocale(): Locale {
  try {
    if (typeof navigator === "undefined") return "en";
    const langs: readonly string[] = navigator.languages?.length
      ? navigator.languages
      : [navigator.language || "en"];
    return langs.some((l) => /^zh\b/i.test(l)) ? "zh" : "en";
  } catch {
    return "en";
  }
}

function lookup(locale: Locale, key: TKey): string {
  const [section, name] = key.split(".") as [Sections, string];
  const table = dicts[locale][section] as Record<string, string | undefined>;
  return table[name] ?? key; // 字典缺项回落键名(类型已防,双保险)
}

function interpolate(text: string, params?: Record<string, string | number>) {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) =>
    k in params ? String(params[k]) : m
  );
}

// ---------- hook ----------

/**
 * 取翻译函数与当前 locale。
 * 每个使用处独立订阅 localStorage,语言切换全站即时生效;
 * 同时同步 <html lang> 与 document.title。
 */
export function useT(): { t: (key: TKey, params?: Record<string, string | number>) => string; locale: Locale } {
  const [pref] = useLocalStorageState<LocalePref>(LOCALE_KEY, "auto");
  const locale: Locale = pref === "zh" || pref === "en" ? pref : systemLocale();

  const t = useCallback(
    (key: TKey, params?: Record<string, string | number>) =>
      interpolate(lookup(locale, key), params),
    [locale]
  );

  useEffect(() => {
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    document.title =
      `Polyphony · ${locale === "zh" ? "实时协同文档" : "Realtime Docs"}`;
  }, [locale]);

  return { t, locale };
}

/** 供 Settings 语言选择器使用(写法与 storage hook 一致)。 */
export function useLocalePref(): [LocalePref, (v: LocalePref) => void] {
  return useLocalStorageState<LocalePref>(LOCALE_KEY, "auto");
}

// en 同构兜底断言(never 分支:不满足即编译失败)
const _enShape: SameShape = en;
void _enShape;
