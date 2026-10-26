/** 本机扩展的公开占位：可选的本机扩展不随仓库分发。
 *
 * 本机部署时 vite.config.ts 会把 @local/ext 指到部署目录旁的本地扩展目录；
 * 没有该目录（GitHub 用户）就渲染空实现。后端 /api/health 的 localExt=false 时也不挂载。
 */
export function LocalExtRuntime() {
  return null;
}

export function LocalExtAdminCard() {
  return null;
}
