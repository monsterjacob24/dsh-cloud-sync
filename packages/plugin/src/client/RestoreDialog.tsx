/**
 * 从云端恢复会话对话框（01 §5.4）：目录列表、来源设备筛选、勾选、
 * 落位路径呈现与改选（目录选择器优先，能力缺失降级手动输入）。
 * 纯展示组件：状态与动作全部经 props 进入，文案全部经 t 查字典。
 */

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CloudSyncCardFace, CloudSyncCardState } from './cloud-sync-card-controller.ts'
import {
  catalogErrorKeyOf,
  deviceOptions,
  filterEntries,
  isRowRestorable,
  relativeTime,
  rowKeyOf,
  type CatalogEntry,
} from './pure.ts'
import { relativeText } from './CloudSyncCard.tsx'

type T = TranslateNS<'settings.cloudSync'>

/** 对话框 props：字典 t + 卡片快照 + controller 动作（由 overlay 组件组装）。 */
export interface RestoreDialogProps {
  t: T
  state: CloudSyncCardState
  actions: Pick<
    CloudSyncCardFace,
    'closeRestore' | 'setDeviceFilter' | 'toggleRow' | 'pickTarget' | 'overrideTarget' | 'restoreSelected'
  >
}

/** 行目标单元格：落位路径的呈现与改选控件。 */
function TargetCell(props: { t: T; entry: CatalogEntry; rowKey: string; state: CloudSyncCardState; actions: RestoreDialogProps['actions'] }) {
  const { t, entry, rowKey, state, actions } = props
  if (entry.existsLocal) {
    return <span className="dsh-cloud-sync-restore__badge dsh-cloud-sync-restore__badge--muted">{t('restore.existsLocal')}</span>
  }
  if (entry.versionIncompatible) {
    return (
      <span
        className="dsh-cloud-sync-restore__badge dsh-cloud-sync-restore__badge--muted"
        title={`format v${String(entry.formatVersion)}`}
      >
        {t('restore.versionIncompatible')}
      </span>
    )
  }
  const override = state.overrides[rowKey]
  const target = override ?? entry.resolvedCwd
  return (
    <span className="dsh-cloud-sync-restore__target">
      {target !== null && target !== undefined && target !== ''
        ? (
          <span className="dsh-cloud-sync-restore__path" title={target}>
            {target}
            {override === undefined && entry.resolution === 'suggested'
              ? <span className="dsh-cloud-sync-restore__badge">{t('restore.pathSuggested')}</span>
              : null}
            {override === undefined && entry.resolution === 'mapping'
              ? <span className="dsh-cloud-sync-restore__badge">{t('restore.pathMapped')}</span>
              : null}
          </span>
        )
        : <span className="dsh-cloud-sync-restore__unmatched">{t('restore.unmatchedPath')}</span>}
      {state.pickerAvailable
        ? (
          <button
            type="button"
            className="dsh-cloud-sync-restore__pick"
            onClick={() => { actions.pickTarget(rowKey) }}
          >
            {t('restore.pickDirectory')}
          </button>
        )
        : (
          <input
            className="dsh-cloud-sync-restore__manual"
            type="text"
            value={override ?? ''}
            placeholder={t('restore.manualPath.placeholder')}
            onChange={(event) => { actions.overrideTarget(rowKey, event.target.value) }}
          />
        )}
    </span>
  )
}

/** 恢复对话框主体。 */
export function RestoreDialog({ t, state, actions }: RestoreDialogProps) {
  const catalog = state.catalog
  const entries = catalog === null ? [] : filterEntries(catalog.sessions, state.deviceFilter)
  const selectedCount = state.selectedKeys.length
  return (
    <Modal
      open
      onClose={() => { actions.closeRestore() }}
      title={t('restore.title')}
      closeLabel={t('restore.close')}
      className="dsh-cloud-sync-restore"
      contentClassName="dsh-cloud-sync-restore__content"
      footer={(
        <>
          <span className="dsh-cloud-sync-restore__selected">{t('restore.selected', { count: selectedCount })}</span>
          <button
            type="button"
            className="dsh-cloud-sync-card__button"
            onClick={() => { actions.closeRestore() }}
          >
            {t('restore.cancel')}
          </button>
          <button
            type="button"
            className="dsh-cloud-sync-card__button dsh-cloud-sync-card__button--primary"
            disabled={selectedCount === 0 || state.restorePending}
            onClick={() => { actions.restoreSelected() }}
          >
            {t(state.restorePending ? 'restore.restoring' : 'restore.action')}
          </button>
        </>
      )}
    >
      {catalog !== null && catalog.error !== ''
        ? <p className="dsh-cloud-sync-card__error">{t(catalogErrorKeyOf(catalog.error))}</p>
        : null}
      {catalog === null && state.catalogPending
        ? <p className="dsh-cloud-sync-card__hint">{t('restore.loading')}</p>
        : null}
      {catalog !== null && catalog.error === '' && entries.length === 0 && !state.catalogPending
        ? <p className="dsh-cloud-sync-card__hint">{t('restore.empty')}</p>
        : null}
      {catalog !== null && catalog.sessions.length > 0
        ? (
          <>
            <div className="dsh-cloud-sync-restore__filter">
              <select
                className="dsh-cloud-sync-restore__select"
                value={state.deviceFilter}
                onChange={(event) => { actions.setDeviceFilter(event.target.value) }}
              >
                <option value="">{t('restore.filter.all')}</option>
                {deviceOptions(catalog).map((device) => (
                  <option key={device} value={device}>{device}</option>
                ))}
              </select>
            </div>
            <div className="dsh-cloud-sync-restore__head" role="row">
              <span />
              <span>{t('restore.column.title')}</span>
              <span>{t('restore.column.updated')}</span>
              <span>{t('restore.column.events')}</span>
              <span>{t('restore.column.target')}</span>
            </div>
            <ul className="dsh-cloud-sync-restore__list">
              {entries.map((entry) => {
                const rowKey = rowKeyOf(entry)
                const restorable = isRowRestorable(entry)
                const updated = relativeTime(entry.updatedAt, Date.now())
                return (
                  <li key={rowKey} className="dsh-cloud-sync-restore__row" data-disabled={!restorable}>
                    <input
                      type="checkbox"
                      checked={state.selectedKeys.includes(rowKey)}
                      disabled={!restorable || state.restorePending}
                      onChange={() => { actions.toggleRow(rowKey) }}
                    />
                    <span className="dsh-cloud-sync-restore__title" title={entry.title}>
                      {entry.title === '' ? entry.sessionId : entry.title}
                      <span className="dsh-cloud-sync-restore__device">{entry.device}</span>
                    </span>
                    <span className="dsh-cloud-sync-restore__updated">
                      {updated === null ? '' : relativeText(t, updated)}
                    </span>
                    <span className="dsh-cloud-sync-restore__events">{entry.eventCount}</span>
                    <TargetCell t={t} entry={entry} rowKey={rowKey} state={state} actions={actions} />
                  </li>
                )
              })}
            </ul>
          </>
        )
        : null}
    </Modal>
  )
}
