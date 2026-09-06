/**
 * dsh-cloud-sync 插件 Client 半入口（浏览器侧）。
 * named exports `inject` / `apply`，无 default export（dsh 函数插件约定）。
 * 产物经 scripts/build-client.mjs 打包为 __ModuleLoader__ 的 lazy-CJS factory。
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// 以下均为类型 import（构建时被擦除，不触发 bundle-purity gate）：
import type {} from '@deepseek-ai/dsh-client-locale/client' // ctx.locale 合并
import type {} from '@deepseek-ai/dsh-client-ui-settings/client' // ctx.settingsScope 合并
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client' // ctx.slots 合并
import type {} from '@deepseek-ai/dsh-client-ui-settings-plugins/client' // settings.plugin.item 槽的 SlotMap 合并
import { CloudSyncCard } from './CloudSyncCard.tsx'
import { CloudSyncOverlay } from './CloudSyncOverlay.tsx'
import { CLOUD_SYNC_NS, CLOUD_SYNC_STATUS_NS, CloudSyncCardController, type DirectoryPickerLike } from './cloud-sync-card-controller.ts'
import { en, zh } from './locales.ts'
import { installCardStyles } from './styles.ts'

/** 本插件的字典命名空间。 */
const LOCALE_NS = 'settings.cloudSync'

/** 需要的 cordis 服务（fiber inject）。 */
export const inject = ['slots', 'locale', 'settingsScope']

/**
 * 挂载云端同步设置卡：注册字典、创建 controller、向 settings.plugin.item 槽注册卡片。
 * @param ctx - 浏览器插件上下文。
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(LOCALE_NS, { zh, en }), 'cloud-sync: dictionaries')
  // 双 namespace：配置（'cloud-sync'，Host 不写）与状态/触发（'cloud-sync-status'，Host 高频回写）
  // 目录选择器是可选 Remote 能力（'remote' 服务缺失时恢复对话框降级为手动输入）
  const directoryPicker = (ctx.get('remote') as { directoryPicker?: DirectoryPickerLike } | undefined)?.directoryPicker
  const controller = new CloudSyncCardController(
    ctx.settingsScope.bind({ namespace: CLOUD_SYNC_NS }),
    ctx.settingsScope.bind({ namespace: CLOUD_SYNC_STATUS_NS }),
    directoryPicker,
  )
  ctx.effect(() => () => { controller.dispose() }, 'cloud-sync: card controller')
  installCardStyles()
  ctx.slots.inject('settings.plugin.item', () => ctx.slots.register({
    name: 'settings.plugin.item',
    key: CLOUD_SYNC_NS,
    locale: LOCALE_NS,
    inject: () => controller.inject(),
  }, CloudSyncCard))
  // M4：恢复对话框与启动通知挂在根作用域浮层槽（设置页外也能打开对话框）
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'cloud-sync-overlay',
    order: 100,
    locale: LOCALE_NS,
    inject: () => controller.inject(),
  }, CloudSyncOverlay))
}
