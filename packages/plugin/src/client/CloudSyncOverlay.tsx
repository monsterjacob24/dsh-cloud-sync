/**
 * shell.overlay 浮层（M4）：恢复对话框 + 启动检查通知 + 恢复结果提示。
 * 挂在根作用域列表槽，设置页外同样可用（启动 toast 的「点击查看」要能在
 * 任意页面打开恢复对话框）。对话框用 ui-primitives 的 Modal；启动通知需要
 * 点击动作而 Toast 组件不支持点击，按 01 §5.5（右下角轻提示）自绘。
 */

import { Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { CloudSyncCardFace } from './cloud-sync-card-controller.ts'
import { RestoreDialog } from './RestoreDialog.tsx'

// ui-layout 声明的 'shell.overlay' 槽（list/root，无 owner props）。本包不依赖
// ui-layout 的类型包，按 renderer 的 SlotMap 合并惯例就地声明同形条目。
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

export type CloudSyncOverlayProps =
  PropsRuntime<'shell.overlay'>
  & PropsLocale<'settings.cloudSync'>
  & InjectFace<CloudSyncCardFace>

/**
 * 云端同步浮层：恢复对话框（restoreOpen 时）、启动通知（未读时）、恢复结果 toast。
 * Host 未 serve 设置 namespace（state.available=false）时整体不渲染，卸载无残留。
 */
export function CloudSyncOverlay(props: CloudSyncOverlayProps) {
  const { t } = props
  const state = props.useCloudSyncCard((snapshot) => snapshot)
  if (!state.available) return null
  return (
    <>
      {state.restoreOpen
        ? <RestoreDialog t={t} state={state} actions={props} />
        : null}
      {state.notice !== null
        ? (
          <div className="dsh-cloud-sync-notice" role="alert">
            <span className="dsh-cloud-sync-notice__text">{t('toast.newCloudSessions')}</span>
            <button
              type="button"
              className="dsh-cloud-sync-notice__action"
              onClick={() => { props.viewNotice() }}
            >
              {t('toast.view')}
            </button>
            <button
              type="button"
              className="dsh-cloud-sync-notice__dismiss"
              aria-label={t('toast.dismiss')}
              onClick={() => { props.dismissNotice() }}
            >
              {'×'}
            </button>
          </div>
        )
        : null}
      {state.restoreOutcome !== null
        ? (
          <Toast
            text={t('restore.result', { ok: state.restoreOutcome.ok, failed: state.restoreOutcome.failed })}
            onDone={() => { props.clearRestoreOutcome() }}
          />
        )
        : null}
    </>
  )
}
