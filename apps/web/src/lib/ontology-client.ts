/**
 * 本体治理页共用 fetch。
 *
 * apps/api 对 unsafe 方法 + session 身份强制校验 X-CSRF-Token（server.ts validateCsrf），
 * 登录时下发的 df_csrf cookie 是唯一的令牌来源；裸 fetch 在浏览器 session 下所有写操作
 * 都会 403 CSRF_INVALID（Bearer 服务身份无 cookie，token 缺省时不加头，两种身份都兼容）。
 */
export async function ontologyFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (init.method === "POST" || init.method === "PUT" || init.method === "PATCH" || init.method === "DELETE") {
    const token = document.cookie
      .split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("df_csrf="))
      ?.slice("df_csrf=".length);
    if (token) {
      headers.set("X-CSRF-Token", token);
    }
  }
  return fetch(path, { ...init, headers, credentials: "same-origin" });
}
