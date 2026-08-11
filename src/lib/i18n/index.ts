import { i18n } from "@lingui/core";
import type { SupportedLocale } from "./schema.ts";

export const locales: SupportedLocale[] = ["ja", "en", "zh_CN"];

const importMessages = async (locale: SupportedLocale) => {
  switch (locale) {
    case "ja":
      return import("./locales/ja/messages.ts");
    case "en":
      return import("./locales/en/messages.ts");
    case "zh_CN":
      return import("./locales/zh_CN/messages.ts");
    default:
      locale satisfies never;
      throw new Error(`Unsupported locale: ${String(locale)}`);
  }
};

const loadedLocales: SupportedLocale[] = [];
export const activateLocale = async (locale: SupportedLocale) => {
  if (!loadedLocales.includes(locale)) {
    const { messages } = await importMessages(locale);
    i18n.load(locale, messages);
    loadedLocales.push(locale);
  }

  // BCP-47 归一化:lingui 内部的 i18n.date/number/plural 都会把 _locales 传给
  // Intl.*Format;活跃 locale 是 POSIX "zh_CN" 时会触发 RangeError: Invalid language tag。
  // 传入第二参 locales(BCP-47 数组)让 helper 用它,同时保持 i18n.locale 仍是 "zh_CN"
  // 以兼容 SupportedLocale 等值判断。
  const bcp47 = locale.replace("_", "-");
  i18n.activate(locale, [bcp47]);
};
