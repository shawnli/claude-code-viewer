// crypto.randomUUID() 在非 secure context (http://non-localhost)、老浏览器、
// 或部分蓬内隔离环境的 webview 里不存在,直接调用会 throw TypeError。
// 全部改走这个 helper: 优先原生 API,不存在则用 Math.random 兜底。
export const randomUUID = (): string => {
  if (typeof globalThis !== "undefined" && typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  // RFC 4122 v4 兼容格式;字符空间不如原生 CSPRNG 但足够避碰撞
  const hex = (n: number) => n.toString(16).padStart(2, "0");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  const b6 = bytes[6] ?? 0;
  const b8 = bytes[8] ?? 0;
  bytes[6] = (b6 & 0x0f) | 0x40; // version 4
  bytes[8] = (b8 & 0x3f) | 0x80; // variant
  const s = Array.from(bytes, hex).join("");
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
};
